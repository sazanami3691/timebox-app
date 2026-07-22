export const SCHEMA_VERSION = 1;
export const MINUTE_MS = 60_000;
export const ACTIVE_TIMER_STATES = new Set(["running", "paused", "expired"]);

export function createId(prefix = "item") {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function shiftLocalDate(dateString, days) {
  const [year, month, day] = String(dateString).split("-").map(Number);
  if (![year, month, day].every(Number.isInteger)) throw new Error("日付が不正です。");
  const value = new Date(year, month - 1, day, 12, 0, 0, 0);
  value.setDate(value.getDate() + days);
  return localDateString(value);
}

export function localDateTimeMs(dateString, timeString) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString));
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(String(timeString));
  if (!dateMatch || !timeMatch) return Number.NaN;
  const [, y, mo, d] = dateMatch.map(Number);
  const [, h, mi] = timeMatch.map(Number);
  if (h > 23 || mi > 59) return Number.NaN;
  const value = new Date(y, mo - 1, d, h, mi, 0, 0);
  if (
    value.getFullYear() !== y || value.getMonth() !== mo - 1 || value.getDate() !== d ||
    value.getHours() !== h || value.getMinutes() !== mi
  ) return Number.NaN;
  return value.getTime();
}

export function getPlanDurationMs(plan) {
  if (plan.scheduleType === "duration") {
    const minutes = Number(plan.durationMinutes);
    return Number.isFinite(minutes) && minutes >= 1 ? Math.round(minutes * MINUTE_MS) : Number.NaN;
  }
  if (plan.scheduleType === "clock") {
    const start = localDateTimeMs(plan.date, plan.startTime);
    const end = localDateTimeMs(plan.date, plan.endTime);
    return end > start ? end - start : Number.NaN;
  }
  return Number.NaN;
}

export function validatePlan(plan) {
  const errors = [];
  if (!String(plan.title ?? "").trim()) errors.push("作業名を入力してください。");
  const dateText = String(plan.date ?? "");
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  const validDate = dateMatch && localDateString(new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), 12)) === dateText;
  if (!validDate) {
    errors.push("対象日を正しく入力してください。");
  }
  if (!["work", "break"].includes(plan.kind)) errors.push("種類を選択してください。");
  if (!["duration", "clock"].includes(plan.scheduleType)) errors.push("登録方式を選択してください。");
  if (plan.scheduleType === "duration") {
    const minutes = Number(plan.durationMinutes);
    if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes < 1) {
      errors.push("時間は1分以上の整数で入力してください。");
    }
  }
  if (plan.scheduleType === "clock") {
    const start = localDateTimeMs(plan.date, plan.startTime);
    const end = localDateTimeMs(plan.date, plan.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end)) errors.push("開始・終了時刻を正しく入力してください。");
    else if (end <= start) errors.push("終了時刻は開始時刻より後にしてください。");
  }
  return errors;
}

export function findClockOverlap(candidate, plans, excludeId = null) {
  if (candidate.scheduleType !== "clock") return null;
  const start = localDateTimeMs(candidate.date, candidate.startTime);
  const end = localDateTimeMs(candidate.date, candidate.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return plans.find((plan) => {
    if (plan.id === excludeId || plan.date !== candidate.date || plan.scheduleType !== "clock") return false;
    const otherStart = localDateTimeMs(plan.date, plan.startTime);
    const otherEnd = localDateTimeMs(plan.date, plan.endTime);
    return start < otherEnd && end > otherStart;
  }) ?? null;
}

export function classifyClockStart(plan, nowMs) {
  const durationMs = getPlanDurationMs(plan);
  if (plan.scheduleType !== "clock" || !Number.isFinite(durationMs)) {
    return { mode: "full", durationMs };
  }
  const startMs = localDateTimeMs(plan.date, plan.startTime);
  const endMs = localDateTimeMs(plan.date, plan.endTime);
  if (nowMs > startMs && nowMs < endMs) {
    return { mode: "late-choice", durationMs, untilEndMs: endMs - nowMs };
  }
  return { mode: "full", durationMs };
}

export function createTimer(plan, nowMs, targetMs = getPlanDurationMs(plan)) {
  if (!Number.isFinite(targetMs) || targetMs <= 0) throw new Error("計測時間が不正です。");
  return {
    key: "active",
    schemaVersion: SCHEMA_VERSION,
    planId: plan.id,
    planDate: plan.date,
    title: String(plan.title),
    note: String(plan.note ?? ""),
    kind: plan.kind,
    status: "running",
    actualStartedAt: nowMs,
    lastResumedAt: nowMs,
    endAt: nowMs + targetMs,
    remainingMs: targetMs,
    baseTargetMs: getPlanDurationMs(plan),
    currentTargetMs: targetMs,
    accumulatedActiveMs: 0,
    expiredAt: null,
    updatedAt: nowMs
  };
}

function assertTimer(timer) {
  if (!timer || !ACTIVE_TIMER_STATES.has(timer.status)) throw new Error("タイマー状態が不正です。");
  for (const key of ["actualStartedAt", "baseTargetMs", "currentTargetMs", "accumulatedActiveMs"]) {
    if (!Number.isFinite(timer[key]) || timer[key] < 0) throw new Error("保存されたタイマー値が不正です。");
  }
  if (timer.baseTargetMs <= 0 || timer.currentTargetMs <= 0) throw new Error("保存された計測時間が不正です。");
  if (timer.status === "running" && (!Number.isFinite(timer.endAt) || !Number.isFinite(timer.lastResumedAt) || timer.endAt < timer.lastResumedAt)) {
    throw new Error("実行中タイマーの日時が不正です。");
  }
  if (timer.status === "paused" && (!Number.isFinite(timer.remainingMs) || timer.remainingMs <= 0)) {
    throw new Error("一時停止中タイマーの残り時間が不正です。");
  }
  if (timer.status === "expired" && !Number.isFinite(timer.expiredAt)) throw new Error("終了待ちタイマーの日時が不正です。");
}

function maximumRemainingMs(timer) {
  return Math.max(0, timer.currentTargetMs - timer.accumulatedActiveMs);
}

export function reduceTimer(timer, action, nowMs = Date.now()) {
  assertTimer(timer);
  if (!Number.isFinite(nowMs)) throw new Error("現在時刻が不正です。");
  const current = { ...timer };

  if (current.status === "running" && nowMs >= current.endAt) {
    current.accumulatedActiveMs += Math.max(0, current.endAt - current.lastResumedAt);
    current.status = "expired";
    current.remainingMs = 0;
    current.expiredAt = current.endAt;
    current.lastResumedAt = null;
  }

  switch (action.type) {
    case "sync":
      break;
    case "pause":
      if (current.status !== "running") throw new Error("実行中のタイマーだけ一時停止できます。");
      current.remainingMs = Math.min(Math.max(0, current.endAt - nowMs), maximumRemainingMs(current));
      current.accumulatedActiveMs += Math.max(0, nowMs - current.lastResumedAt);
      current.status = "paused";
      current.endAt = null;
      current.lastResumedAt = null;
      break;
    case "resume":
      if (current.status !== "paused" || !Number.isFinite(current.remainingMs) || current.remainingMs <= 0) {
        throw new Error("一時停止中のタイマーだけ再開できます。");
      }
      current.status = "running";
      current.lastResumedAt = nowMs;
      current.endAt = nowMs + current.remainingMs;
      current.expiredAt = null;
      break;
    case "extend": {
      const extensionMs = Number(action.extensionMs ?? 5 * MINUTE_MS);
      if (!Number.isFinite(extensionMs) || extensionMs <= 0) throw new Error("延長時間が不正です。");
      if (current.status === "paused") {
        current.remainingMs += extensionMs;
        current.currentTargetMs += extensionMs;
      } else if (current.status === "running") {
        current.endAt += extensionMs;
        current.remainingMs = Math.max(0, current.endAt - nowMs);
        current.currentTargetMs += extensionMs;
      } else {
        const overtimeMs = Math.max(0, nowMs - current.expiredAt);
        current.accumulatedActiveMs += overtimeMs;
        current.currentTargetMs += overtimeMs + extensionMs;
        current.status = "running";
        current.lastResumedAt = nowMs;
        current.endAt = nowMs + extensionMs;
        current.remainingMs = extensionMs;
        current.expiredAt = null;
      }
      break;
    }
    default:
      throw new Error("未対応のタイマー操作です。");
  }
  if (action.type !== "sync" || current.status !== timer.status) current.updatedAt = nowMs;
  return current;
}

export function timerRemainingMs(timer, nowMs = Date.now()) {
  if (timer.status === "paused") return Math.max(0, timer.remainingMs);
  if (timer.status === "running") return Math.min(Math.max(0, timer.endAt - nowMs), maximumRemainingMs(timer));
  return 0;
}

export function timerOvertimeMs(timer, nowMs = Date.now()) {
  return timer.status === "expired" ? Math.max(0, nowMs - timer.expiredAt) : 0;
}

export function activeElapsedMs(timer, nowMs = Date.now(), includeExpiredOvertime = true) {
  assertTimer(timer);
  if (timer.status === "paused") return Math.max(0, timer.accumulatedActiveMs);
  if (timer.status === "running") {
    return Math.max(0, timer.accumulatedActiveMs + Math.max(0, Math.min(nowMs, timer.endAt) - timer.lastResumedAt));
  }
  return Math.max(0, timer.accumulatedActiveMs + (includeExpiredOvertime ? timerOvertimeMs(timer, nowMs) : 0));
}

export function outcomeActualMs(timer, nowMs, { includeOvertime = true, plannedOnly = false } = {}) {
  if (plannedOnly && timer.status === "expired") return Math.max(0, timer.currentTargetMs);
  return activeElapsedMs(timer, nowMs, includeOvertime);
}

export function aggregateDay(historyEntries) {
  const result = {
    workCompleted: 0,
    workSkipped: 0,
    workActualMs: 0,
    workAchievementRate: 0,
    breakCompleted: 0,
    breakSkipped: 0
  };
  for (const entry of historyEntries) {
    if (entry.kind === "work") {
      if (entry.outcome === "completed") result.workCompleted += 1;
      if (entry.outcome === "skipped") result.workSkipped += 1;
      const actualMs = Number(entry.actualMs);
      if (Number.isFinite(actualMs) && actualMs > 0) result.workActualMs += actualMs;
    } else if (entry.kind === "break") {
      if (entry.outcome === "completed") result.breakCompleted += 1;
      if (entry.outcome === "skipped") result.breakSkipped += 1;
    }
  }
  const targetCount = result.workCompleted + result.workSkipped;
  result.workAchievementRate = targetCount ? result.workCompleted / targetCount : 0;
  return result;
}

export function validateCopyBatch(sourcePlans, destinationPlans, destinationDate) {
  const pending = destinationPlans.filter((plan) => plan.status === "pending");
  const proposed = sourcePlans.map((plan) => ({ ...plan, date: destinationDate, status: "pending" }));
  const conflicts = [];
  const accepted = [...pending];
  for (const plan of proposed) {
    const conflict = findClockOverlap(plan, accepted);
    if (conflict) conflicts.push({ plan, conflict });
    accepted.push(plan);
  }
  return { valid: conflicts.length === 0, conflicts, proposed };
}
