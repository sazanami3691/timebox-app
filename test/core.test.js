import test from "node:test";
import assert from "node:assert/strict";
import {
  MINUTE_MS,
  activeElapsedMs,
  aggregateDay,
  classifyClockStart,
  createTimer,
  findClockOverlap,
  getPlanDurationMs,
  localDateTimeMs,
  outcomeActualMs,
  reduceTimer,
  timerOvertimeMs,
  timerRemainingMs,
  validateCopyBatch,
  validatePlan
} from "../js/core.js";

const basePlan = {
  id: "plan-a",
  date: "2026-07-22",
  title: "設計",
  note: "",
  kind: "work",
  scheduleType: "duration",
  durationMinutes: 30,
  status: "pending",
  order: 1
};

test("時間指定型は分数から計測時間を作る", () => {
  assert.equal(getPlanDurationMs(basePlan), 30 * MINUTE_MS);
  assert.deepEqual(validatePlan(basePlan), []);
  assert.ok(validatePlan({ ...basePlan, durationMinutes: Number.NaN }).length > 0);
  assert.ok(validatePlan({ ...basePlan, date: "2026-02-30" }).length > 0);
});

test("時刻指定の重複を検出し、境界が接するだけなら許可する", () => {
  const existing = { ...basePlan, id: "existing", scheduleType: "clock", startTime: "10:00", endTime: "11:00" };
  const overlap = { ...existing, id: "overlap", startTime: "10:30", endTime: "11:30" };
  const adjacent = { ...existing, id: "adjacent", startTime: "11:00", endTime: "12:00" };
  assert.equal(findClockOverlap(overlap, [existing])?.id, "existing");
  assert.equal(findClockOverlap(adjacent, [existing]), null);
});

test("早期開始は予定時間全体を実行する", () => {
  const plan = { ...basePlan, scheduleType: "clock", startTime: "21:00", endTime: "21:30" };
  const now = localDateTimeMs(plan.date, "20:50");
  assert.deepEqual(classifyClockStart(plan, now), { mode: "full", durationMs: 30 * MINUTE_MS });
});

test("遅延開始では予定時間全体と本来の終了までを提示する", () => {
  const plan = { ...basePlan, scheduleType: "clock", startTime: "21:00", endTime: "21:30" };
  const now = localDateTimeMs(plan.date, "21:10");
  assert.deepEqual(classifyClockStart(plan, now), {
    mode: "late-choice",
    durationMs: 30 * MINUTE_MS,
    untilEndMs: 20 * MINUTE_MS
  });
  assert.deepEqual(classifyClockStart(plan, localDateTimeMs(plan.date, "21:31")), { mode: "full", durationMs: 30 * MINUTE_MS });
});

test("一時停止は残り時間を固定し、再開時に新しい終了予定を作る", () => {
  const start = 1_000_000;
  const timer = createTimer(basePlan, start);
  const paused = reduceTimer(timer, { type: "pause" }, start + 5 * MINUTE_MS);
  assert.equal(paused.status, "paused");
  assert.equal(paused.remainingMs, 25 * MINUTE_MS);
  assert.equal(timerRemainingMs(paused, start + 20 * MINUTE_MS), 25 * MINUTE_MS);
  const resumedAt = start + 60 * MINUTE_MS;
  const resumed = reduceTimer(paused, { type: "resume" }, resumedAt);
  assert.equal(resumed.endAt, resumedAt + 25 * MINUTE_MS);
  assert.equal(activeElapsedMs(resumed, resumedAt + 5 * MINUTE_MS), 10 * MINUTE_MS);
});

test("端末時計が開始時刻より後ろへ変わっても残り時間は目標を超えない", () => {
  const start = 1_500_000;
  const timer = createTimer(basePlan, start);
  assert.equal(timerRemainingMs(timer, start - 10 * MINUTE_MS), 30 * MINUTE_MS);
  const paused = reduceTimer(timer, { type: "pause" }, start - 10 * MINUTE_MS);
  assert.equal(paused.remainingMs, 30 * MINUTE_MS);
});

test("終了予定時刻を過ぎた復帰でexpiredへ遷移する", () => {
  const start = 2_000_000;
  const timer = createTimer({ ...basePlan, durationMinutes: 1 }, start);
  const restored = reduceTimer(timer, { type: "sync" }, start + 2 * MINUTE_MS);
  assert.equal(restored.status, "expired");
  assert.equal(restored.expiredAt, start + MINUTE_MS);
  assert.equal(timerRemainingMs(restored), 0);
  assert.equal(timerOvertimeMs(restored, start + 4 * MINUTE_MS), 3 * MINUTE_MS);
});

test("実行中の5分延長は終了予定時刻へ加算する", () => {
  const start = 3_000_000;
  const timer = createTimer(basePlan, start);
  const extended = reduceTimer(timer, { type: "extend" }, start + MINUTE_MS);
  assert.equal(extended.endAt, timer.endAt + 5 * MINUTE_MS);
  assert.equal(extended.currentTargetMs, 35 * MINUTE_MS);
});

test("expired中の5分延長は現在時刻から再開し超過も実績対象にする", () => {
  const start = 4_000_000;
  const expired = reduceTimer(createTimer({ ...basePlan, durationMinutes: 1 }, start), { type: "sync" }, start + 4 * MINUTE_MS);
  const extended = reduceTimer(expired, { type: "extend" }, start + 4 * MINUTE_MS);
  assert.equal(extended.status, "running");
  assert.equal(extended.endAt, start + 9 * MINUTE_MS);
  assert.equal(extended.accumulatedActiveMs, 4 * MINUTE_MS);
  assert.equal(extended.currentTargetMs, 9 * MINUTE_MS);
});

test("終了待ち完了は予定時間のみ／超過込みを選べる", () => {
  const start = 5_000_000;
  const expired = reduceTimer(createTimer({ ...basePlan, durationMinutes: 10 }, start), { type: "sync" }, start + 13 * MINUTE_MS);
  assert.equal(outcomeActualMs(expired, start + 13 * MINUTE_MS, { plannedOnly: true }), 10 * MINUTE_MS);
  assert.equal(outcomeActualMs(expired, start + 13 * MINUTE_MS, { includeOvertime: true }), 13 * MINUTE_MS);
});

test("作業達成率と作業時間を集計し休憩時間を除外する", () => {
  const result = aggregateDay([
    { kind: "work", outcome: "completed", actualMs: 20 * MINUTE_MS },
    { kind: "work", outcome: "skipped", actualMs: 5 * MINUTE_MS },
    { kind: "break", outcome: "completed", actualMs: 10 * MINUTE_MS }
  ]);
  assert.equal(result.workCompleted, 1);
  assert.equal(result.workSkipped, 1);
  assert.equal(result.workAchievementRate, 0.5);
  assert.equal(result.workActualMs, 25 * MINUTE_MS);
  assert.equal(result.breakCompleted, 1);
  assert.equal(aggregateDay([]).workAchievementRate, 0);
});

test("前日コピーは時刻重複が1件でもあれば全体を無効とする", () => {
  const source = [
    { ...basePlan, id: "s1", scheduleType: "clock", startTime: "09:00", endTime: "10:00" },
    { ...basePlan, id: "s2", scheduleType: "duration" }
  ];
  const destination = [{ ...basePlan, id: "d1", date: "2026-07-23", scheduleType: "clock", startTime: "09:30", endTime: "10:30" }];
  const result = validateCopyBatch(source, destination, "2026-07-23");
  assert.equal(result.valid, false);
  assert.equal(result.conflicts.length, 1);
});
