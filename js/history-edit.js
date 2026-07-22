import { SCHEMA_VERSION, validatePlan } from "./core.js";

export const MAX_HISTORY_ACTUAL_MINUTES = 525_600;
const KINDS = new Set(["work", "break"]);
const OUTCOMES = new Set(["completed", "skipped"]);

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}が不正です。`);
  return value;
}

function finiteTimestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label}が不正です。`);
  return value;
}

export function validateHistoryEditInput(input) {
  const title = typeof input?.title === "string" ? input.title.trim() : "";
  if (!title) throw new Error("作業名を入力してください。");
  if (title.length > 120) throw new Error("作業名は120文字以内で入力してください。");
  if (typeof input?.note !== "string") throw new Error("メモが不正です。");
  if (input.note.length > 1000) throw new Error("メモは1000文字以内で入力してください。");
  if (!KINDS.has(input.kind)) throw new Error("作業／休憩の指定が不正です。");
  if (!OUTCOMES.has(input.outcome)) throw new Error("完了／スキップの指定が不正です。");
  const rawMinutes = input.actualMinutes;
  if (rawMinutes === "" || rawMinutes === null || rawMinutes === undefined) throw new Error("実績時間を入力してください。");
  const actualMinutes = typeof rawMinutes === "number" ? rawMinutes : Number(rawMinutes);
  if (!Number.isFinite(actualMinutes) || !Number.isSafeInteger(actualMinutes) || actualMinutes < 0) {
    throw new Error("実績時間は0以上の整数分で入力してください。");
  }
  if (actualMinutes > MAX_HISTORY_ACTUAL_MINUTES) throw new Error(`実績時間は${MAX_HISTORY_ACTUAL_MINUTES}分以下で入力してください。`);
  const actualMs = actualMinutes * 60_000;
  if (!Number.isSafeInteger(actualMs)) throw new Error("実績時間が大きすぎます。");
  return { title, note: input.note, kind: input.kind, outcome: input.outcome, actualMinutes, actualMs };
}

export function sanitizeHistoryEntry(entry) {
  requiredString(entry?.id, "履歴ID");
  requiredString(entry?.planId, "予定ID");
  requiredString(entry?.date, "日付");
  requiredString(entry?.title, "作業名");
  if (typeof entry.note !== "string") throw new Error("履歴のメモが不正です。");
  if (!KINDS.has(entry.kind)) throw new Error("履歴の種類が不正です。");
  if (!OUTCOMES.has(entry.outcome)) throw new Error("履歴の結果が不正です。");
  if (entry.schemaVersion !== SCHEMA_VERSION) throw new Error("履歴のschemaVersionが未対応です。");
  if (!Number.isFinite(entry.actualMs) || !Number.isSafeInteger(entry.actualMs) || entry.actualMs < 0) throw new Error("履歴の実績時間が不正です。");
  if (!Number.isFinite(entry.plannedMs) || !Number.isSafeInteger(entry.plannedMs) || entry.plannedMs < 0) throw new Error("履歴の予定時間が不正です。");
  finiteTimestamp(entry.actualStartedAt, "実際の開始時刻", { nullable: true });
  finiteTimestamp(entry.recordedAt, "記録時刻");
  requiredString(entry.source, "記録元");
  return {
    schemaVersion: entry.schemaVersion,
    id: entry.id,
    planId: entry.planId,
    date: entry.date,
    title: entry.title,
    note: entry.note,
    kind: entry.kind,
    outcome: entry.outcome,
    actualMs: entry.actualMs,
    plannedMs: entry.plannedMs,
    actualStartedAt: entry.actualStartedAt,
    recordedAt: entry.recordedAt,
    source: entry.source
  };
}

export function buildEditedHistory(current, input) {
  const original = sanitizeHistoryEntry(current);
  const changes = validateHistoryEditInput(input);
  return {
    ...original,
    title: changes.title,
    note: changes.note,
    kind: changes.kind,
    outcome: changes.outcome,
    actualMs: changes.actualMs
  };
}

export function historyRevisionKey(entry) {
  const safe = sanitizeHistoryEntry(entry);
  return JSON.stringify([
    safe.schemaVersion, safe.id, safe.planId, safe.date, safe.title, safe.note, safe.kind,
    safe.outcome, safe.actualMs, safe.plannedMs, safe.actualStartedAt, safe.recordedAt, safe.source
  ]);
}

export function chooseLatestHistory(entries) {
  const safeEntries = entries.map(sanitizeHistoryEntry);
  return safeEntries.sort((left, right) => right.recordedAt - left.recordedAt || right.id.localeCompare(left.id))[0] ?? null;
}

function assertRelatedPlan(plan, entries, timer) {
  requiredString(plan?.id, "関連予定ID");
  requiredString(plan?.date, "関連予定の日付");
  requiredString(plan?.title, "関連予定の作業名");
  if (typeof plan.note !== "string" || !KINDS.has(plan.kind)) throw new Error("関連予定の必須値が破損しています。バックアップを取ってから確認してください。");
  if (plan.schemaVersion !== SCHEMA_VERSION || !Number.isFinite(plan.order) || !Number.isFinite(plan.createdAt) || !Number.isFinite(plan.updatedAt) || validatePlan(plan).length) {
    throw new Error("関連予定の必須値が破損しています。バックアップを取ってから確認してください。");
  }
  if (!OUTCOMES.has(plan.status)) throw new Error("関連予定の状態が履歴と一致しません。バックアップを取ってから確認してください。");
  if (entries.some((entry) => entry.planId !== plan.id || entry.date !== plan.date)) {
    throw new Error("関連予定と履歴の日付が一致しません。バックアップを取ってから確認してください。");
  }
  if (timer?.planId === plan.id) throw new Error("この予定は現在のタイマーで使用中のため、履歴を変更できません。先にタイマーを完了またはスキップしてください。");
}

export function syncPlanFromHistory(plan, entry, now = Date.now()) {
  const safeEntry = sanitizeHistoryEntry(entry);
  assertRelatedPlan(plan, [safeEntry], null);
  if (!Number.isFinite(now) || !Number.isSafeInteger(now)) throw new Error("更新日時が不正です。");
  return {
    ...plan,
    title: safeEntry.title,
    note: safeEntry.note,
    kind: safeEntry.kind,
    status: safeEntry.outcome,
    actualMs: safeEntry.actualMs,
    completedAt: Number.isFinite(plan.completedAt) ? plan.completedAt : safeEntry.recordedAt,
    updatedAt: now
  };
}

export function assertHistoryPlanTransactionSafe(plan, entries, timer) {
  if (!plan) return true;
  assertRelatedPlan(plan, entries.map(sanitizeHistoryEntry), timer);
  return true;
}

export function planAfterHistoryDeletion(plan, remainingEntries, now = Date.now()) {
  if (!plan) return null;
  const safeRemaining = remainingEntries.map(sanitizeHistoryEntry);
  assertRelatedPlan(plan, safeRemaining.length ? safeRemaining : [{
    schemaVersion: SCHEMA_VERSION,
    id: "deleted-placeholder",
    planId: plan.id,
    date: plan.date,
    title: plan.title,
    note: plan.note,
    kind: plan.kind,
    outcome: plan.status,
    actualMs: Number.isFinite(plan.actualMs) ? plan.actualMs : 0,
    plannedMs: 0,
    actualStartedAt: null,
    recordedAt: Number.isFinite(plan.completedAt) ? plan.completedAt : 0,
    source: "reconcile"
  }], null);
  if (!safeRemaining.length) {
    return { ...plan, status: "pending", actualMs: null, completedAt: null, updatedAt: now };
  }
  return syncPlanFromHistory(plan, chooseLatestHistory(safeRemaining), now);
}
