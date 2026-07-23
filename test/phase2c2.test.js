import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import {
  MAX_HISTORY_ACTUAL_MINUTES,
  buildEditedHistory,
  chooseLatestHistory,
  historyRevisionKey,
  planAfterHistoryDeletion,
  syncPlanFromHistory,
  validateHistoryEditInput
} from "../js/history-edit.js";
import { normalizeSearchText, searchRecords } from "../js/search.js";
import { SCHEMA_VERSION } from "../js/core.js";
import { BACKUP_VERSION, createBackupDocument, validateBackupObject } from "../js/backup.js";
import { databaseInfo } from "../js/db.js";

const rootUrl = new URL("../", import.meta.url);
const readText = (path) => readFile(new URL(path, rootUrl), "utf8");

function plan(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "plan-1",
    date: "2026-07-23",
    title: "読書 ABC123",
    note: "資料確認",
    kind: "work",
    scheduleType: "duration",
    durationMinutes: 30,
    startTime: "",
    endTime: "",
    status: "completed",
    order: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    actualMs: 1_800_000,
    completedAt: 1_700_001_800_000,
    ...overrides
  };
}

function history(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "history-1",
    planId: "plan-1",
    date: "2026-07-23",
    title: "読書 ABC123",
    note: "資料確認",
    kind: "work",
    outcome: "completed",
    actualMs: 1_800_000,
    plannedMs: 1_800_000,
    actualStartedAt: 1_700_000_000_000,
    recordedAt: 1_700_001_800_000,
    source: "timer",
    ...overrides
  };
}

test("検索文字列はtrim・NFKC・英字小文字化し、空文字と日本語を扱う", () => {
  assert.equal(normalizeSearchText("  ＡＢＣ１２３  "), "abc123");
  assert.equal(normalizeSearchText(""), "");
  assert.equal(normalizeSearchText(" 読書 "), "読書");
  const input = { value: "  Ａ  " };
  normalizeSearchText(input.value);
  assert.deepEqual(input, { value: "  Ａ  " });
});

test("検索はtitle・noteのリテラル部分一致で予定と履歴を区別する", () => {
  const plans = [
    plan({ id: "p-pending", status: "pending" }),
    plan({ id: "p-skipped", title: "別件", note: "読書メモ", status: "skipped", kind: "break", scheduleType: "clock", startTime: "10:00", endTime: "10:30" }),
    plan({ id: "p-none", title: "運動", note: "屋外" })
  ];
  const entries = [
    history({ id: "h-completed" }),
    history({ id: "h-skipped", planId: "orphan", title: "別履歴", note: "読書記録", outcome: "skipped", kind: "break" })
  ];
  const before = structuredClone({ plans, entries });
  const result = searchRecords(plans, entries, "読書");
  assert.equal(result.totalCount, 4);
  assert.deepEqual(result.plans.map((item) => item.type), ["plan", "plan"]);
  assert.deepEqual(result.history.map((item) => item.type), ["history", "history"]);
  assert.ok(result.plans.some((item) => item.status === "pending" && item.scheduleType === "duration"));
  assert.ok(result.plans.some((item) => item.status === "skipped" && item.kind === "break" && item.scheduleType === "clock"));
  assert.ok(result.history.some((item) => item.outcome === "completed" && item.kind === "work"));
  assert.ok(result.history.some((item) => item.outcome === "skipped" && item.planId === "orphan"));
  assert.deepEqual({ plans, entries }, before);
  assert.equal(searchRecords(plans, entries, ".*").totalCount, 0, "正規表現として解釈しない");
});

test("検索結果は日付降順、予定order順、履歴recordedAt降順、IDで安定化する", () => {
  const result = searchRecords([
    plan({ id: "p-b", date: "2026-07-23", order: 2 }),
    plan({ id: "p-a", date: "2026-07-23", order: 2 }),
    plan({ id: "p-new", date: "2026-07-24", order: 9 })
  ], [
    history({ id: "h-old", recordedAt: 100 }),
    history({ id: "h-b", recordedAt: 200 }),
    history({ id: "h-a", recordedAt: 200 })
  ], "読書");
  assert.deepEqual(result.plans.map((item) => item.id), ["p-new", "p-a", "p-b"]);
  assert.deepEqual(result.history.map((item) => item.id), ["h-a", "h-b", "h-old"]);
});

test("履歴編集値を検証し0以上の整数分だけをミリ秒へ変換する", () => {
  assert.equal(validateHistoryEditInput({ title: "変更", note: "メモ", kind: "break", outcome: "skipped", actualMinutes: "45" }).actualMs, 2_700_000);
  const badValues = [
    { title: "", note: "", kind: "work", outcome: "completed", actualMinutes: 0 },
    { title: "x", note: "", kind: "other", outcome: "completed", actualMinutes: 0 },
    { title: "x", note: "", kind: "work", outcome: "pending", actualMinutes: 0 },
    { title: "x", note: "", kind: "work", outcome: "completed", actualMinutes: -1 },
    { title: "x", note: "", kind: "work", outcome: "completed", actualMinutes: 1.5 },
    { title: "x", note: "", kind: "work", outcome: "completed", actualMinutes: "NaN" },
    { title: "x", note: "", kind: "work", outcome: "completed", actualMinutes: MAX_HISTORY_ACTUAL_MINUTES + 1 }
  ];
  for (const input of badValues) assert.throws(() => validateHistoryEditInput(input));
});

test("編集後履歴は変更可能項目だけを書き換え、禁止・未知フィールドを維持／保存しない", () => {
  const original = history({ unexpected: "drop" });
  const before = structuredClone(original);
  const edited = buildEditedHistory(original, { title: " 変更 ", note: "新メモ", kind: "break", outcome: "skipped", actualMinutes: 12 });
  assert.deepEqual({ id: edited.id, planId: edited.planId, date: edited.date, plannedMs: edited.plannedMs, actualStartedAt: edited.actualStartedAt, recordedAt: edited.recordedAt, source: edited.source, schemaVersion: edited.schemaVersion }, {
    id: original.id, planId: original.planId, date: original.date, plannedMs: original.plannedMs, actualStartedAt: original.actualStartedAt, recordedAt: original.recordedAt, source: original.source, schemaVersion: original.schemaVersion
  });
  assert.equal(edited.title, "変更");
  assert.equal(edited.actualMs, 720_000);
  assert.equal(Object.hasOwn(edited, "unexpected"), false);
  assert.deepEqual(original, before);
  assert.equal(historyRevisionKey(original), historyRevisionKey(before));
});

test("最新履歴をrecordedAt、同値ならIDで安定選択する", () => {
  const latest = chooseLatestHistory([
    history({ id: "a", recordedAt: 10 }),
    history({ id: "b", recordedAt: 20 }),
    history({ id: "c", recordedAt: 20 })
  ]);
  assert.equal(latest.id, "c");
});

test("履歴から予定へtitle・note・kind・outcome・actualMsだけを同期し予定固有値を維持する", () => {
  const original = plan({ status: "skipped", scheduleType: "clock", startTime: "09:00", endTime: "09:30", order: 8 });
  const updated = syncPlanFromHistory(original, history({ title: "同期名", note: "同期メモ", kind: "break", outcome: "completed", actualMs: 600_000 }), 999);
  assert.equal(updated.title, "同期名");
  assert.equal(updated.note, "同期メモ");
  assert.equal(updated.kind, "break");
  assert.equal(updated.status, "completed");
  assert.equal(updated.actualMs, 600_000);
  assert.equal(updated.date, original.date);
  assert.equal(updated.scheduleType, "clock");
  assert.equal(updated.startTime, "09:00");
  assert.equal(updated.endTime, "09:30");
  assert.equal(updated.order, 8);
  assert.equal(updated.completedAt, original.completedAt);
  assert.equal(updated.updatedAt, 999);
});

test("履歴削除後は残存なしでpending、残存ありで最新履歴へ同期し孤立予定は不要", () => {
  const original = plan();
  const pending = planAfterHistoryDeletion(original, [], 2000);
  assert.equal(pending.status, "pending");
  assert.equal(pending.actualMs, null);
  assert.equal(pending.completedAt, null);
  const reconciled = planAfterHistoryDeletion(original, [
    history({ id: "old", recordedAt: 100, outcome: "completed" }),
    history({ id: "new", recordedAt: 200, outcome: "skipped", title: "最新", actualMs: 60_000 })
  ], 3000);
  assert.equal(reconciled.status, "skipped");
  assert.equal(reconciled.title, "最新");
  assert.equal(reconciled.actualMs, 60_000);
  assert.equal(planAfterHistoryDeletion(null, [], 1), null);
});

test("編集済み履歴はC1バックアップ形式バージョン1で書き出し・検証できる", () => {
  const editedHistory = buildEditedHistory(history(), { title: "復元対象", note: "編集済み", kind: "break", outcome: "skipped", actualMinutes: 7 });
  const backup = createBackupDocument({
    plans: [plan({ title: editedHistory.title, note: editedHistory.note, kind: editedHistory.kind, status: editedHistory.outcome, actualMs: editedHistory.actualMs })],
    history: [editedHistory],
    settings: { soundEnabled: true, soundVolume: 0.25, scheduleNotification: "start", wakeLockEnabled: false },
    appVersion: "1.4.0",
    exportedAt: "2026-07-23T05:00:00.000Z"
  });
  const restored = validateBackupObject(backup);
  assert.equal(restored.backupVersion, 1);
  assert.deepEqual(restored.data.history[0], editedHistory);
});

test("DB処理は検索スナップショットと履歴・予定・タイマーの単一トランザクションを持つ", async () => {
  const source = await readText("js/db.js");
  const searchBody = source.slice(source.indexOf("export async function getSearchSnapshot"), source.indexOf("export async function getHistoryEntryById"));
  assert.match(searchBody, /\[STORES\.plans, STORES\.history\]/);
  assert.match(searchBody, /plansRequest/);
  assert.match(searchBody, /historyRequest/);
  const mutationBody = source.slice(source.indexOf("async function historyMutationContext"), source.indexOf("export async function putPlansAtomically"));
  assert.match(mutationBody, /\[STORES\.history, STORES\.plans, STORES\.timer\]/);
  assert.match(mutationBody, /historyStore\.get\(historyId\)/);
  assert.match(mutationBody, /getAll\(hint\.planId\)/);
  assert.match(mutationBody, /get\("active"\)/);
  assert.match(mutationBody, /tx\.abort\(\)/);
  assert.match(mutationBody, /historyStore\.put\(edited\)/);
  assert.match(mutationBody, /historyStore\.delete\(current\.id\)/);
});

test("currentTimer競合・日付不一致・pending予定は純粋安全判定とDB処理で拒否される", async () => {
  const module = await import("../js/history-edit.js");
  assert.throws(() => module.assertHistoryPlanTransactionSafe(plan(), [history()], { planId: "plan-1" }), /タイマー/);
  assert.throws(() => module.assertHistoryPlanTransactionSafe(plan(), [history({ date: "2026-07-24" })], null), /日付/);
  assert.throws(() => module.assertHistoryPlanTransactionSafe(plan({ status: "pending" }), [history()], null), /状態/);
});

test("版数・キャッシュ・静的参照は1.5.0、DBとバックアップは版1を維持する", async () => {
  const appVersion = /TIMEBOX_APP_VERSION = "([^"]+)"/.exec(await readText("app-version.js"))?.[1];
  const packageJson = JSON.parse(await readText("package.json"));
  const sw = await readText("sw.js");
  const html = await readText("index.html");
  assert.equal(appVersion, "1.5.0");
  assert.equal(packageJson.version, appVersion);
  assert.equal(databaseInfo.version, 1);
  assert.equal(databaseInfo.schemaVersion, 1);
  assert.equal(BACKUP_VERSION, 1);
  assert.match(sw, /"\.\/js\/search\.js"/);
  assert.match(sw, /"\.\/js\/search-view\.js"/);
  assert.match(sw, /"\.\/js\/history-edit\.js"/);
  assert.match(html, /data-navigation="search"/);
  assert.doesNotMatch(html, /data-navigation="search"[^>]*disabled/);
  for (const file of ["js/search.js", "js/search-view.js", "js/history-edit.js"]) await stat(new URL(file, rootUrl));
  assert.match(`${await readText("js/app.js")}\n${html}`, /reorder/i);
});
