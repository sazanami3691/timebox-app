import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { BACKUP_VERSION } from "../js/backup.js";
import { SCHEMA_VERSION } from "../js/core.js";
import { databaseInfo } from "../js/db.js";
import {
  REORDER_CANCEL_DISTANCE_PX,
  REORDER_LONG_PRESS_MS,
  buildDurationOrderChanges,
  canReorderPlan,
  isReorderTimerBlocked,
  planReorderRevision,
  reorderPlansById
} from "../js/reorder.js";
import { movedBeyondThreshold } from "../js/reorder-controller.js";
import { SETTINGS_PAGES, normalizeSettingsPage } from "../js/settings-nav.js";

const rootUrl = new URL("../", import.meta.url);
const readText = (path) => readFile(new URL(path, rootUrl), "utf8");

function plan(id, order, overrides = {}) {
  return {
    schemaVersion: 1,
    id,
    date: "2026-07-23",
    title: `予定${id}`,
    note: `メモ${id}`,
    kind: "work",
    scheduleType: "duration",
    durationMinutes: 30,
    startTime: "",
    endTime: "",
    status: "pending",
    order,
    createdAt: 1_700_000_000_000 + order,
    updatedAt: 1_700_000_001_000 + order,
    actualMs: null,
    ...overrides
  };
}

test("並べ替え対象は今日・未来のpending durationだけでタイマー中は全体禁止", () => {
  const base = plan("a", 1);
  const before = structuredClone(base);
  assert.equal(canReorderPlan(base, { selectedDate: base.date, todayDate: base.date }), true);
  assert.equal(canReorderPlan({ ...base, date: "2026-07-24" }, { selectedDate: "2026-07-24", todayDate: base.date }), true);
  assert.equal(canReorderPlan({ ...base, scheduleType: "clock" }, { selectedDate: base.date, todayDate: base.date }), false);
  assert.equal(canReorderPlan({ ...base, status: "completed" }, { selectedDate: base.date, todayDate: base.date }), false);
  assert.equal(canReorderPlan({ ...base, status: "skipped" }, { selectedDate: base.date, todayDate: base.date }), false);
  assert.equal(canReorderPlan({ ...base, date: "2026-07-22" }, { selectedDate: "2026-07-22", todayDate: base.date }), false);
  for (const status of ["running", "paused", "expired"]) {
    assert.equal(isReorderTimerBlocked(status), true);
    assert.equal(canReorderPlan(base, { selectedDate: base.date, todayDate: base.date, timerStatus: status }), false);
  }
  assert.equal(isReorderTimerBlocked("idle"), false);
  assert.deepEqual(base, before);
});

test("純粋関数は先頭・末尾・中間を移動し元配列を変更しない", () => {
  const plans = [plan("a", 1), plan("b", 2), plan("c", 3), plan("d", 4)];
  const before = structuredClone(plans);
  assert.deepEqual(reorderPlansById(plans, "a", 3).map((item) => item.id), ["b", "c", "d", "a"]);
  assert.deepEqual(reorderPlansById(plans, "d", 0).map((item) => item.id), ["d", "a", "b", "c"]);
  assert.deepEqual(reorderPlansById(plans, "b", 2).map((item) => item.id), ["a", "c", "b", "d"]);
  assert.deepEqual(reorderPlansById(plans, "b", 1).map((item) => item.id), ["a", "b", "c", "d"]);
  assert.deepEqual(plans, before);
});

test("純粋関数は存在しないID・重複ID・duration以外を拒否する", () => {
  assert.throws(() => reorderPlansById([plan("a", 1)], "missing", 0), /見つかりません/);
  assert.throws(() => reorderPlansById([plan("a", 1), plan("a", 2)], "a", 0), /重複/);
  assert.throws(() => reorderPlansById([plan("a", 1), plan("clock", 2, { scheduleType: "clock" })], "a", 1), /時間指定/);
  assert.throws(() => reorderPlansById([plan("a", 1)], "a", 3), /移動先/);
});

test("orderは1からの連番になり変更予定だけupdatedAtを更新する", () => {
  const plans = [plan("a", 1), plan("b", 2), plan("c", 3)];
  const before = structuredClone(plans);
  const result = buildDurationOrderChanges(plans, ["c", "b", "a"], 2_000_000_000_000);
  assert.deepEqual(result.orderedPlans.map((item) => [item.id, item.order]), [["c", 1], ["b", 2], ["a", 3]]);
  assert.deepEqual(result.changedPlans.map((item) => item.id), ["c", "a"]);
  assert.equal(result.orderedPlans[1].updatedAt, plans[1].updatedAt);
  assert.equal(result.changedPlans.every((item) => item.updatedAt === 2_000_000_000_000), true);
  assert.equal(result.orderedPlans[0].title, plans[2].title);
  assert.equal(result.orderedPlans[0].note, plans[2].note);
  assert.equal(result.orderedPlans[0].durationMinutes, plans[2].durationMinutes);
  assert.equal(result.expectedPlanRevisions.a, planReorderRevision(plans[0]));
  assert.deepEqual(plans, before);
});

test("長押し定数と移動キャンセル距離はスクロール優先の範囲", () => {
  assert.equal(REORDER_LONG_PRESS_MS, 400);
  assert.equal(REORDER_CANCEL_DISTANCE_PX, 10);
  assert.equal(movedBeyondThreshold(0, 0, 3, 4), false);
  assert.equal(movedBeyondThreshold(0, 0, 10, 0), true);
});

test("ドラッグ制御は長押し後だけ開始しdrop時だけ保存、終了時に自動スクロールを止める", async () => {
  const source = await readText("js/reorder-controller.js");
  assert.match(source, /setTimer\(beginDrag, longPressMs\)/);
  assert.match(source, /movedBeyondThreshold/);
  assert.match(source, /pointercancel/);
  assert.match(source, /touchmove/);
  assert.match(source, /await onDrop\(currentIds, originalIds\)/);
  assert.ok(source.indexOf("await onDrop") > source.indexOf("async function pointerUp"));
  assert.doesNotMatch(source.slice(source.indexOf("function pointerDown"), source.indexOf("function pointerMove")), /onDrop/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /stopAutoScroll\(\)/);
  assert.match(source, /saving = true/);
});

test("DB保存はplansとcurrentTimerの単一readwrite transactionで原子的に競合確認する", async () => {
  const source = await readText("js/db.js");
  const start = source.indexOf("export async function saveDurationPlanOrder");
  const end = source.indexOf("export async function deletePlan", start);
  const body = source.slice(start, end);
  assert.match(body, /\[STORES\.plans, STORES\.timer\]/);
  assert.match(body, /"readwrite"/);
  assert.match(body, /index\("date"\)\.getAll\(date\)/);
  assert.match(body, /get\("active"\)/);
  assert.match(body, /values\.timer/);
  assert.match(body, /plan\.status === "pending"/);
  assert.match(body, /plan\.scheduleType === "duration"/);
  assert.match(body, /expectedPlanRevisions/);
  assert.match(body, /tx\.abort\(\)/);
  assert.doesNotMatch(body, /STORES\.history|STORES\.meta|deleteDatabase|clear\(\)/);
});

test("設定トップは6カテゴリのbutton、詳細は同時に1つだけ表示する構造", async () => {
  const html = await readText("index.html");
  assert.match(html, /data-settings-top/);
  for (const page of SETTINGS_PAGES) {
    assert.match(html, new RegExp(`<button[^>]+data-settings-target="${page}"`));
    assert.match(html, new RegExp(`data-settings-page="${page}"[^>]*hidden`));
  }
  assert.equal((html.match(/data-settings-target=/g) ?? []).length, 6);
  assert.equal((html.match(/data-settings-page=/g) ?? []).length, 6);
  assert.match(html, /settings-chevron/);
  assert.match(html, /data-settings-back/g);
});

test("設定ナビゲーションは不正ページをtopへ戻し戻り先フォーカスを管理する", async () => {
  assert.equal(normalizeSettingsPage("update"), "update");
  assert.equal(normalizeSettingsPage("unknown"), "top");
  const source = await readText("js/settings-nav.js");
  assert.match(source, /returnTarget/);
  assert.match(source, /returnTarget\.focus/);
  assert.match(source, /currentPage === "top"/);
  assert.match(source, /page\.hidden = page\.dataset\.settingsPage !== currentPage/);
  assert.match(source, /scrollTop = 0/);
  assert.match(source, /handleEscape/);
});

test("移動後も既存設定コントロールとバックアップダイアログを維持する", async () => {
  const html = await readText("index.html");
  for (const id of [
    "check-update-button", "apply-update-button", "sound-enabled", "sound-volume", "test-sound-button",
    "enable-notification-button", "test-notification-button", "schedule-notification", "wake-lock-enabled",
    "export-backup-button", "backup-file-input", "backup-restore-dialog", "app-version", "database-name"
  ]) assert.equal((html.match(new RegExp(`id="${id}"`, "g")) ?? []).length, 1, `${id} must exist exactly once`);
});

test("版数・APP_SHELL・永続化形式はC3要件と互換", async () => {
  const version = /TIMEBOX_APP_VERSION = "([^"]+)"/.exec(await readText("app-version.js"))?.[1];
  const packageJson = JSON.parse(await readText("package.json"));
  const sw = await readText("sw.js");
  assert.equal(version, "1.5.0");
  assert.equal(packageJson.version, version);
  assert.match(sw, /timebox-app-shell-/);
  for (const file of ["js/reorder.js", "js/reorder-controller.js", "js/settings-nav.js"]) {
    assert.match(sw, new RegExp(`"\\./${file.replace("/", "\\/")}"`));
    await stat(new URL(file, rootUrl));
  }
  assert.equal(databaseInfo.version, 1);
  assert.equal(databaseInfo.schemaVersion, 1);
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(BACKUP_VERSION, 1);
});

test("カードUIはduration pendingの候補だけにハンドルを作りfinishedを除外する", async () => {
  const source = await readText("js/app.js");
  const start = source.indexOf("function buildPlanCard");
  const end = source.indexOf("function actionButton", start);
  const body = source.slice(start, end);
  assert.match(body, /!finished/);
  assert.match(body, /plan\.status === "pending"/);
  assert.match(body, /plan\.scheduleType === "duration"/);
  assert.match(body, /reorder-handle/);
  assert.doesNotMatch(body, /scheduleType === "clock"[^\n]*reorder-handle/);
});
