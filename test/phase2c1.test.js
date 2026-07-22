import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  MAX_BACKUP_FILE_BYTES,
  createBackupDocument,
  createBackupFilename,
  parseBackupText,
  saveBackupFile,
  serializeBackup,
  validateBackupFileMetadata,
  validateBackupObject
} from "../js/backup.js";
import { SCHEMA_VERSION } from "../js/core.js";

const rootUrl = new URL("../", import.meta.url);
const readText = (path) => readFile(new URL(path, rootUrl), "utf8");

function validPlan(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "plan-1",
    date: "2026-07-23",
    title: "バックアップ確認",
    note: "メモ",
    kind: "work",
    scheduleType: "duration",
    durationMinutes: 30,
    startTime: "09:00",
    endTime: "09:30",
    status: "pending",
    order: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
    actualMs: null,
    ...overrides
  };
}

function validHistory(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "history-1",
    planId: "deleted-plan-is-allowed",
    date: "2026-07-23",
    title: "完了済み作業",
    note: "履歴メモ",
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

function validSettings(overrides = {}) {
  return {
    soundEnabled: true,
    soundVolume: 0.25,
    scheduleNotification: "start",
    wakeLockEnabled: false,
    ...overrides
  };
}

function validBackup(overrides = {}) {
  return {
    format: BACKUP_FORMAT,
    backupVersion: BACKUP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    databaseVersion: 1,
    appVersion: "1.3.0",
    exportedAt: "2026-07-23T03:04:05.000Z",
    data: {
      plans: [validPlan()],
      history: [validHistory()],
      settings: validSettings()
    },
    ...overrides
  };
}

test("バックアップ生成は固定形式・版・全対象を含み対象外を含めない", () => {
  const plans = [validPlan()];
  const history = [validHistory()];
  const settings = validSettings();
  const before = structuredClone({ plans, history, settings });
  const backup = createBackupDocument({
    plans,
    history,
    settings,
    appVersion: "1.3.0",
    exportedAt: "2026-07-23T03:04:05.000Z"
  });
  assert.equal(backup.format, BACKUP_FORMAT);
  assert.equal(backup.backupVersion, 1);
  assert.equal(backup.schemaVersion, SCHEMA_VERSION);
  assert.equal(backup.databaseVersion, 1);
  assert.equal(backup.appVersion, "1.3.0");
  assert.ok(Number.isFinite(Date.parse(backup.exportedAt)));
  assert.equal(backup.data.plans.length, 1);
  assert.equal(backup.data.history.length, 1);
  assert.deepEqual(backup.data.settings, settings);
  assert.equal("currentTimer" in backup.data, false);
  assert.equal("notification-ledger" in backup.data, false);
  assert.deepEqual({ plans, history, settings }, before);
});

test("正常なJSONは読み戻せ、アプリ版の違いだけでは拒否しない", () => {
  const input = validBackup({ appVersion: "1.1.0" });
  const parsed = parseBackupText(serializeBackup(input));
  assert.equal(parsed.appVersion, "1.1.0");
  assert.deepEqual(parsed.data.plans, input.data.plans);
  assert.deepEqual(parsed.data.history, input.data.history);
});

test("不正JSON・トップレベル・形式・未対応版・data形状を拒否する", () => {
  assert.throws(() => parseBackupText("{"), /JSONの構文/);
  assert.throws(() => parseBackupText("[]"), /トップレベル/);
  assert.throws(() => validateBackupObject(validBackup({ format: "other" })), /バックアップ形式/);
  assert.throws(() => validateBackupObject(validBackup({ backupVersion: 99 })), /形式バージョン/);
  assert.throws(() => validateBackupObject(validBackup({ schemaVersion: 99 })), /schemaVersion/);
  assert.throws(() => validateBackupObject(validBackup({ databaseVersion: 99 })), /databaseVersion/);
  assert.throws(() => validateBackupObject(validBackup({ data: null })), /data/);
  assert.throws(() => validateBackupObject(validBackup({ data: { plans: {}, history: [], settings: {} } })), /plansが配列/);
  assert.throws(() => validateBackupObject(validBackup({ data: { plans: [], history: {}, settings: {} } })), /historyが配列/);
  assert.throws(() => validateBackupObject(validBackup({ data: { plans: [], history: [], settings: [] } })), /settingsがオブジェクト/);
});

test("予定の必須値・日付・時刻・種類・方式・状態を厳格に検証する", () => {
  const rejected = [
    validPlan({ id: "" }),
    validPlan({ title: "" }),
    validPlan({ date: "2026-02-30" }),
    validPlan({ kind: "other" }),
    validPlan({ scheduleType: "other" }),
    validPlan({ status: "running" }),
    validPlan({ durationMinutes: 0 }),
    validPlan({ scheduleType: "clock", startTime: "10:00", endTime: "09:00" }),
    validPlan({ order: Number.NaN })
  ];
  for (const plan of rejected) {
    assert.throws(() => validateBackupObject(validBackup({ data: { ...validBackup().data, plans: [plan] } })));
  }
});

test("予定と履歴の重複IDおよび時刻指定予定の重複を拒否する", () => {
  const clock = validPlan({ id: "clock-1", scheduleType: "clock", startTime: "10:00", endTime: "11:00" });
  const overlapping = validPlan({ id: "clock-2", scheduleType: "clock", startTime: "10:30", endTime: "11:30" });
  assert.throws(() => validateBackupObject(validBackup({ data: { ...validBackup().data, plans: [validPlan(), validPlan()] } })), /重複ID/);
  assert.throws(() => validateBackupObject(validBackup({ data: { ...validBackup().data, history: [validHistory(), validHistory()] } })), /重複ID/);
  assert.throws(() => validateBackupObject(validBackup({ data: { ...validBackup().data, plans: [clock, overlapping] } })), /重複/);
});

test("履歴の型・日付・種類・結果・実績・日時を検証し孤立planIdは許可する", () => {
  const accepted = validateBackupObject(validBackup());
  assert.equal(accepted.data.history[0].planId, "deleted-plan-is-allowed");
  for (const entry of [
    validHistory({ id: "" }),
    validHistory({ planId: "" }),
    validHistory({ date: "2026-13-01" }),
    validHistory({ kind: "other" }),
    validHistory({ outcome: "pending" }),
    validHistory({ actualMs: -1 }),
    validHistory({ recordedAt: Number.NaN })
  ]) {
    assert.throws(() => validateBackupObject(validBackup({ data: { ...validBackup().data, history: [entry] } })));
  }
});

test("設定は不正型・範囲外・未知の通知値を拒否し欠落項目だけ既定値で補う", () => {
  for (const settings of [
    validSettings({ soundEnabled: "true" }),
    validSettings({ soundVolume: 1.1 }),
    validSettings({ scheduleNotification: "30" }),
    validSettings({ wakeLockEnabled: 1 })
  ]) {
    assert.throws(() => validateBackupObject(validBackup({ data: { ...validBackup().data, settings } })));
  }
  assert.deepEqual(validateBackupObject(validBackup({ data: { ...validBackup().data, settings: {} } })).data.settings, validSettings());
});

test("未知プロパティやprototype用キーを永続化対象へ残さない", () => {
  const input = validBackup();
  input.data.plans[0].unexpected = "remove";
  input.data.plans[0]["__proto__"] = { polluted: true };
  input.data.history[0].unexpected = "remove";
  input.data.settings.unexpected = "remove";
  const validated = validateBackupObject(input);
  assert.equal(Object.hasOwn(validated.data.plans[0], "unexpected"), false);
  assert.equal(Object.hasOwn(validated.data.plans[0], "__proto__"), false);
  assert.equal(Object.hasOwn(validated.data.history[0], "unexpected"), false);
  assert.equal(Object.hasOwn(validated.data.settings, "unexpected"), false);
});

test("ファイルはJSON・空でない・10MB以下だけを受理する", () => {
  assert.throws(() => validateBackupFileMetadata(null), /選択/);
  assert.throws(() => validateBackupFileMetadata({ name: "backup.json", type: "application/json", size: 0 }), /空/);
  assert.throws(() => validateBackupFileMetadata({ name: "backup.json", type: "application/json", size: MAX_BACKUP_FILE_BYTES + 1 }), /大きすぎ/);
  assert.throws(() => validateBackupFileMetadata({ name: "backup.txt", type: "text/plain", size: 10 }), /.json/);
  assert.equal(validateBackupFileMetadata({ name: "backup.json", type: "application/json", size: 10 }), true);
});

test("ファイル名はUTC変換せずローカル日時を使う", () => {
  const date = new Date(2026, 6, 23, 4, 5, 6);
  assert.equal(createBackupFilename(date), "timebox-app-backup-20260723-040506.json");
});

test("書き出しはFile共有を優先し、失敗時はBlob URLを破棄するダウンロードへ戻る", async () => {
  let shared = 0;
  class FakeBlob { constructor(parts, options) { this.parts = parts; this.type = options.type; } }
  class FakeFile extends FakeBlob { constructor(parts, name, options) { super(parts, options); this.name = name; } }
  const sharedResult = await saveBackupFile({
    text: "{}",
    filename: "backup.json",
    environment: {
      Blob: FakeBlob,
      File: FakeFile,
      navigator: { canShare: () => true, share: async () => { shared += 1; } }
    }
  });
  assert.equal(sharedResult.method, "share");
  assert.equal(shared, 1);

  const cancelledResult = await saveBackupFile({
    text: "{}",
    filename: "backup.json",
    environment: {
      Blob: FakeBlob,
      File: FakeFile,
      navigator: {
        canShare: () => true,
        share: async () => { const error = new Error("cancelled"); error.name = "AbortError"; throw error; }
      }
    }
  });
  assert.equal(cancelledResult.method, "cancelled");

  let clicked = 0;
  let revoked = 0;
  const link = { click: () => { clicked += 1; }, remove() {} };
  const fallbackResult = await saveBackupFile({
    text: "{}",
    filename: "backup.json",
    environment: {
      Blob: FakeBlob,
      File: FakeFile,
      navigator: { canShare: () => true, share: async () => { throw new Error("share failed"); } },
      document: { createElement: () => link, body: { append() {} } },
      URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => { revoked += 1; } },
      setTimeout: (callback) => callback()
    }
  });
  assert.equal(fallbackResult.method, "download");
  assert.equal(clicked, 1);
  assert.equal(revoked, 1);
});

test("DB全置換は4ストアの単一transactionでタイマーを先に確認しmeta全消去をしない", async () => {
  const source = await readText("js/db.js");
  const start = source.indexOf("export async function replaceAllFromBackup");
  const body = source.slice(start);
  assert.match(body, /\[STORES\.plans, STORES\.history, STORES\.timer, STORES\.meta\]/);
  assert.match(body, /timerStore\.get\("active"\)/);
  assert.ok(body.indexOf('timerStore.get("active")') < body.indexOf("planStore.clear()"));
  assert.match(body, /planStore\.clear\(\)/);
  assert.match(body, /historyStore\.clear\(\)/);
  assert.match(body, /timerStore\.clear\(\)/);
  assert.match(body, /metaStore\.delete\(notificationLedgerKey\)/);
  assert.doesNotMatch(body, /metaStore\.clear\(\)|deleteDatabase|localStorage|caches\./);
});

test("画面処理は検証後だけプレビューし、確定時だけDB全置換を呼ぶ", async () => {
  const source = await readText("js/app.js");
  const selection = source.slice(source.indexOf("async function handleBackupFileSelection"), source.indexOf("async function restoreBackup"));
  assert.match(selection, /await readBackupFile/);
  assert.ok(selection.indexOf("await readBackupFile") < selection.indexOf("showBackupPreview"));
  assert.doesNotMatch(selection, /replaceAllFromBackup/);
  const restore = source.slice(source.indexOf("async function restoreBackup"), source.indexOf("async function showView"));
  assert.match(restore, /await replaceAllFromBackup/);
  assert.match(restore, /backupReloadScheduled/);
  assert.match(source, /input\.value = ""/);
  assert.match(source, /state\.backupBusy/);
});

test("PWA版は1.3.0でbackupモジュールをキャッシュし、既存更新保留を維持する", async () => {
  const version = /TIMEBOX_APP_VERSION = "([^"]+)"/.exec(await readText("app-version.js"))?.[1];
  const packageJson = JSON.parse(await readText("package.json"));
  const sw = await readText("sw.js");
  assert.equal(version, "1.3.0");
  assert.equal(packageJson.version, version);
  assert.match(sw, /"\.\/js\/backup\.js"/);
  assert.match(sw, /SKIP_WAITING/);
  assert.doesNotMatch(sw.slice(sw.indexOf('addEventListener("install"'), sw.indexOf('addEventListener("activate"')), /skipWaiting/);
});
