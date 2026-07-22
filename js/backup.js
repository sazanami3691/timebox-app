import {
  SCHEMA_VERSION,
  findClockOverlap,
  localDateTimeMs,
  validatePlan
} from "./core.js";
import {
  DEFAULT_SETTINGS,
  normalizeSettings
} from "./settings.js";

export const BACKUP_FORMAT = "timebox-app-backup";
export const BACKUP_VERSION = 1;
export const MAX_BACKUP_FILE_BYTES = 10 * 1024 * 1024;

const PLAN_STATUSES = new Set(["pending", "completed", "skipped"]);
const SCHEDULE_NOTIFICATION_VALUES = new Set(["none", "start", "5", "10", "15"]);

export class BackupValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackupValidationError";
  }
}

function fail(message) {
  throw new BackupValidationError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteTimestamp(value) {
  return Number.isFinite(value) && value >= 0;
}

function requireString(value, label, { nonEmpty = false } = {}) {
  if (typeof value !== "string") fail(`${label}は文字列である必要があります。`);
  if (nonEmpty && !value.trim()) fail(`${label}が空です。`);
  return value;
}

function requireTimestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!isFiniteTimestamp(value)) fail(`${label}が不正です。`);
  return value;
}

function validIsoDate(value) {
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Date.parse(value));
}

function sanitizePlan(input, index, schemaVersion) {
  const label = `予定${index + 1}件目`;
  if (!isRecord(input)) fail(`${label}がオブジェクトではありません。`);
  if (input.schemaVersion !== schemaVersion) fail(`${label}のschemaVersionには対応していません。`);

  const plan = {
    schemaVersion: input.schemaVersion,
    id: requireString(input.id, `${label}のID`, { nonEmpty: true }),
    date: requireString(input.date, `${label}の日付`, { nonEmpty: true }),
    title: requireString(input.title, `${label}の作業名`, { nonEmpty: true }),
    note: requireString(input.note, `${label}のメモ`),
    kind: input.kind,
    scheduleType: input.scheduleType,
    durationMinutes: input.durationMinutes,
    startTime: input.startTime,
    endTime: input.endTime,
    status: input.status,
    order: input.order,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    actualMs: input.actualMs
  };

  if (!Number.isFinite(plan.order)) fail(`${label}の並び順が不正です。`);
  requireTimestamp(plan.createdAt, `${label}の作成日時`);
  requireTimestamp(plan.updatedAt, `${label}の更新日時`);
  if (!PLAN_STATUSES.has(plan.status)) fail(`${label}の状態が不正です。`);
  if (plan.actualMs !== null && (!Number.isFinite(plan.actualMs) || plan.actualMs < 0)) {
    fail(`${label}の実績時間が不正です。`);
  }
  if (plan.durationMinutes !== undefined && (!Number.isFinite(plan.durationMinutes) || !Number.isInteger(plan.durationMinutes))) {
    fail(`${label}の時間が不正です。`);
  }
  if (plan.scheduleType === "duration" && (plan.durationMinutes < 1 || plan.durationMinutes > 1440)) {
    fail(`${label}の時間は1〜1440分である必要があります。`);
  }
  if (plan.startTime !== undefined && typeof plan.startTime !== "string") fail(`${label}の開始時刻が不正です。`);
  if (plan.endTime !== undefined && typeof plan.endTime !== "string") fail(`${label}の終了時刻が不正です。`);

  const errors = validatePlan(plan);
  if (errors.length) fail(`${label}: ${errors.join(" ")}`);
  if (plan.scheduleType === "clock") {
    if (!Number.isFinite(localDateTimeMs(plan.date, plan.startTime)) || !Number.isFinite(localDateTimeMs(plan.date, plan.endTime))) {
      fail(`${label}の時刻が不正です。`);
    }
  }

  if (Object.hasOwn(input, "completedAt")) {
    plan.completedAt = requireTimestamp(input.completedAt, `${label}の完了日時`, { nullable: true });
  }
  return plan;
}

function sanitizeHistoryEntry(input, index, schemaVersion) {
  const label = `履歴${index + 1}件目`;
  if (!isRecord(input)) fail(`${label}がオブジェクトではありません。`);
  if (input.schemaVersion !== schemaVersion) fail(`${label}のschemaVersionには対応していません。`);
  if (!Number.isFinite(localDateTimeMs(input.date, "12:00"))) fail(`${label}の日付が不正です。`);
  if (!(["work", "break"].includes(input.kind))) fail(`${label}の種類が不正です。`);
  if (!(["completed", "skipped"].includes(input.outcome))) fail(`${label}の結果が不正です。`);
  if (!Number.isFinite(input.actualMs) || input.actualMs < 0) fail(`${label}の実績時間が不正です。`);
  if (!Number.isFinite(input.plannedMs) || input.plannedMs < 0) fail(`${label}の予定時間が不正です。`);

  return {
    schemaVersion: input.schemaVersion,
    id: requireString(input.id, `${label}のID`, { nonEmpty: true }),
    planId: requireString(input.planId, `${label}の予定ID`, { nonEmpty: true }),
    date: requireString(input.date, `${label}の日付`, { nonEmpty: true }),
    title: requireString(input.title, `${label}の作業名`),
    note: requireString(input.note, `${label}のメモ`),
    kind: input.kind,
    outcome: input.outcome,
    actualMs: input.actualMs,
    plannedMs: input.plannedMs,
    actualStartedAt: requireTimestamp(input.actualStartedAt, `${label}の開始日時`, { nullable: true }),
    recordedAt: requireTimestamp(input.recordedAt, `${label}の記録日時`),
    source: requireString(input.source, `${label}の記録元`, { nonEmpty: true })
  };
}

export function validateBackupSettings(input) {
  if (!isRecord(input)) fail("settingsがオブジェクトではありません。");
  for (const key of ["soundEnabled", "wakeLockEnabled"]) {
    if (Object.hasOwn(input, key) && typeof input[key] !== "boolean") fail(`${key}は真偽値である必要があります。`);
  }
  if (Object.hasOwn(input, "soundVolume") && (!Number.isFinite(input.soundVolume) || input.soundVolume < 0 || input.soundVolume > 1)) {
    fail("soundVolumeは0〜1である必要があります。");
  }
  if (Object.hasOwn(input, "scheduleNotification") && !SCHEDULE_NOTIFICATION_VALUES.has(input.scheduleNotification)) {
    fail("scheduleNotificationが不正です。");
  }
  const allowed = {
    soundEnabled: Object.hasOwn(input, "soundEnabled") ? input.soundEnabled : DEFAULT_SETTINGS.soundEnabled,
    soundVolume: Object.hasOwn(input, "soundVolume") ? input.soundVolume : DEFAULT_SETTINGS.soundVolume,
    scheduleNotification: Object.hasOwn(input, "scheduleNotification") ? input.scheduleNotification : DEFAULT_SETTINGS.scheduleNotification,
    wakeLockEnabled: Object.hasOwn(input, "wakeLockEnabled") ? input.wakeLockEnabled : DEFAULT_SETTINGS.wakeLockEnabled
  };
  return normalizeSettings(allowed);
}

function assertUniqueIds(items, label) {
  const ids = new Set();
  for (const item of items) {
    if (ids.has(item.id)) fail(`${label}に重複ID「${item.id}」があります。`);
    ids.add(item.id);
  }
}

function assertNoClockOverlaps(plans) {
  const checked = [];
  for (const plan of plans) {
    const conflict = findClockOverlap(plan, checked);
    if (conflict) {
      fail(`時刻指定予定「${plan.title}」と「${conflict.title}」が${plan.date}で重複しています。`);
    }
    checked.push(plan);
  }
}

export function validateBackupObject(input, {
  schemaVersion = SCHEMA_VERSION,
  databaseVersion = 1
} = {}) {
  if (!isRecord(input)) fail("バックアップのトップレベルがオブジェクトではありません。");
  if (input.format !== BACKUP_FORMAT) fail("timebox-appのバックアップ形式ではありません。");
  if (input.backupVersion !== BACKUP_VERSION) fail("このバックアップ形式バージョンには対応していません。");
  if (input.schemaVersion !== schemaVersion) fail("このschemaVersionには対応していません。");
  if (input.databaseVersion !== databaseVersion) fail("このdatabaseVersionには対応していません。");
  requireString(input.appVersion, "appVersion", { nonEmpty: true });
  if (!validIsoDate(input.exportedAt)) fail("書き出し日時が不正です。");
  if (!isRecord(input.data)) fail("dataがありません。");
  if (!Array.isArray(input.data.plans)) fail("plansが配列ではありません。");
  if (!Array.isArray(input.data.history)) fail("historyが配列ではありません。");
  if (input.data.plans.length > 100_000 || input.data.history.length > 100_000) fail("バックアップの件数が多すぎます。");

  const plans = input.data.plans.map((plan, index) => sanitizePlan(plan, index, schemaVersion));
  const history = input.data.history.map((entry, index) => sanitizeHistoryEntry(entry, index, schemaVersion));
  const settings = validateBackupSettings(input.data.settings);
  assertUniqueIds(plans, "予定");
  assertUniqueIds(history, "履歴");
  assertNoClockOverlaps(plans);

  return {
    format: BACKUP_FORMAT,
    backupVersion: BACKUP_VERSION,
    schemaVersion,
    databaseVersion,
    appVersion: input.appVersion,
    exportedAt: new Date(input.exportedAt).toISOString(),
    data: { plans, history, settings }
  };
}

export function createBackupDocument({
  plans,
  history,
  settings,
  schemaVersion = SCHEMA_VERSION,
  databaseVersion = 1,
  appVersion,
  exportedAt = new Date().toISOString()
}) {
  return validateBackupObject({
    format: BACKUP_FORMAT,
    backupVersion: BACKUP_VERSION,
    schemaVersion,
    databaseVersion,
    appVersion,
    exportedAt,
    data: { plans, history, settings }
  }, { schemaVersion, databaseVersion });
}

export function serializeBackup(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function parseBackupText(text, options) {
  if (typeof text !== "string" || !text.trim()) fail("バックアップファイルが空です。");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("JSONの構文が不正です。");
  }
  return validateBackupObject(parsed, options);
}

export function validateBackupFileMetadata(file) {
  if (!file) fail("JSONファイルを選択してください。");
  if (!Number.isFinite(file.size) || file.size <= 0) fail("バックアップファイルが空です。");
  if (file.size > MAX_BACKUP_FILE_BYTES) fail("バックアップファイルが大きすぎます（上限10MB）。");
  if (typeof file.name !== "string" || !file.name.toLowerCase().endsWith(".json")) {
    fail("拡張子が.jsonのバックアップファイルを選択してください。");
  }
  const type = String(file.type ?? "").toLowerCase();
  if (type && !type.includes("json") && type !== "application/octet-stream") {
    fail("JSONファイルとして認識できません。");
  }
  return true;
}

export async function readBackupFile(file, options) {
  validateBackupFileMetadata(file);
  if (typeof file.text !== "function") fail("この環境ではファイルを読み取れません。");
  const text = await file.text();
  return validateBackupObject(parseBackupText(text, options), options);
}

export function createBackupFilename(date = new Date()) {
  const part = (value) => String(value).padStart(2, "0");
  return `timebox-app-backup-${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}.json`;
}

export async function saveBackupFile({ text, filename, environment = globalThis }) {
  const navigatorRef = environment.navigator;
  const BlobClass = environment.Blob;
  const FileClass = environment.File;
  if (typeof BlobClass !== "function") throw new Error("この環境ではバックアップファイルを作成できません。");
  const blob = new BlobClass([text], { type: "application/json;charset=utf-8" });
  let shareError = null;

  if (typeof navigatorRef?.share === "function" && typeof FileClass === "function") {
    try {
      const file = new FileClass([blob], filename, { type: "application/json" });
      const shareData = { files: [file], title: "Timeboxバックアップ" };
      const canShare = typeof navigatorRef.canShare !== "function" || navigatorRef.canShare(shareData);
      if (canShare) {
        await navigatorRef.share(shareData);
        return { method: "share" };
      }
    } catch (error) {
      if (error?.name === "AbortError") return { method: "cancelled" };
      shareError = error;
    }
  }

  const documentRef = environment.document;
  const urlApi = environment.URL;
  if (!documentRef?.createElement || typeof urlApi?.createObjectURL !== "function") {
    throw shareError ?? new Error("この環境ではバックアップファイルを保存できません。");
  }
  const url = urlApi.createObjectURL(blob);
  try {
    const link = documentRef.createElement("a");
    link.href = url;
    link.download = filename;
    link.hidden = true;
    documentRef.body?.append(link);
    link.click();
    link.remove();
    return { method: "download", shareError };
  } finally {
    (environment.setTimeout ?? globalThis.setTimeout)(() => urlApi.revokeObjectURL(url), 0);
  }
}
