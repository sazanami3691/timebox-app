import {
  ACTIVE_TIMER_STATES,
  MINUTE_MS,
  SCHEMA_VERSION,
  activeElapsedMs,
  aggregateDay,
  classifyClockStart,
  createId,
  createTimer,
  findClockOverlap,
  getPlanDurationMs,
  localDateString,
  outcomeActualMs,
  reduceTimer,
  shiftLocalDate,
  timerOvertimeMs,
  timerRemainingMs,
  validateCopyBatch,
  validatePlan
} from "./core.js";
import {
  createBackupDocument,
  createBackupFilename,
  readBackupFile,
  saveBackupFile,
  serializeBackup
} from "./backup.js";
import {
  commitManualCompletion,
  commitOutcome,
  databaseInfo,
  deletePlan,
  deleteHistoryAndReconcilePlan,
  getBackupSnapshot,
  getCurrentTimer,
  getHistoryEntryById,
  getHistoryByDate,
  getMetaValue,
  getPlanById,
  getPlansByDate,
  getSearchSnapshot,
  initializeDatabase,
  putPlansAtomically,
  replaceAllFromBackup,
  saveCurrentTimer,
  saveMetaValue,
  savePlan,
  savePlanAndTimer,
  startCurrentTimer,
  updateHistoryAndRelatedPlan
} from "./db.js";
import { buildEditedHistory, historyRevisionKey, validateHistoryEditInput } from "./history-edit.js";
import { createSearchViewController } from "./search-view.js";
import { createAlertManager } from "./alerts.js";
import { createPwaManager } from "./pwa.js";
import {
  DEFAULT_SETTINGS,
  NOTIFICATION_LEDGER_META_KEY,
  SETTINGS_META_KEY,
  normalizeSettings
} from "./settings.js";
import { createWakeLockManager } from "./wake-lock.js";

const $ = (selector) => document.querySelector(selector);
const today = () => localDateString(new Date());

const state = {
  selectedDate: today(),
  historyDate: today(),
  plans: [],
  history: [],
  timer: null,
  view: "schedule",
  editingPlan: null,
  duplicateMode: false,
  pendingStart: null,
  manualPlan: null,
  undoTimer: null,
  timerSyncing: false,
  scheduleNotificationChecking: false,
  scheduleNotificationCheckAt: Date.now(),
  settings: DEFAULT_SETTINGS,
  backupPreview: null,
  backupBusy: false,
  backupReloadScheduled: false,
  editingHistory: null,
  pendingHistoryEdit: null,
  deletingHistory: null,
  historyMutationBusy: false
};

let searchController;

const pwaManager = createPwaManager({ getTimerStatus: () => state.timer?.status ?? "idle" });
const alertManager = createAlertManager({
  getSettings: () => state.settings,
  loadLedger: () => getMetaValue(NOTIFICATION_LEDGER_META_KEY),
  saveLedger: (ledger) => saveMetaValue(NOTIFICATION_LEDGER_META_KEY, ledger)
});
const wakeLockManager = createWakeLockManager({
  getTimerStatus: () => state.timer?.status ?? "idle",
  getEnabled: () => state.settings.wakeLockEnabled
});

const loading = $("#loading");
const app = $("#app");
const screenLabel = $("#screen-label");
const headerDate = $("#header-date");
const timerReturnButton = $("#timer-return-button");
const menuTimerButton = $("#menu-timer-button");
const scheduleView = $("#schedule-view");
const timerView = $("#timer-view");
const historyView = $("#history-view");
const searchView = $("#search-view");
const settingsView = $("#settings-view");
const planDialog = $("#plan-dialog");
const planForm = $("#plan-form");
const lateStartDialog = $("#late-start-dialog");
const manualDialog = $("#manual-dialog");
const expiredCompleteDialog = $("#expired-complete-dialog");
const confirmDialog = $("#confirm-dialog");
const backupRestoreDialog = $("#backup-restore-dialog");
const historyEditDialog = $("#history-edit-dialog");
const historyEditConfirmDialog = $("#history-edit-confirm-dialog");
const historyDeleteDialog = $("#history-delete-dialog");
const toastRegion = $("#toast-region");

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatDateLabel(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12);
  return new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(date);
}

function formatDuration(ms, withSeconds = false) {
  const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const totalSeconds = Math.floor(safeMs / 1000);
  if (withSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  const totalMinutes = Math.round(safeMs / MINUTE_MS);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes}分`;
  return minutes ? `${hours}時間${minutes}分` : `${hours}時間`;
}

function planScheduleLabel(plan) {
  return plan.scheduleType === "clock"
    ? `${plan.startTime}〜${plan.endTime}（${formatDuration(getPlanDurationMs(plan))}）`
    : `${plan.durationMinutes}分`;
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
}

function showToast(message, { type = "info", actionLabel = "", onAction = null, duration = 5000 } = {}) {
  toastRegion.replaceChildren();
  const toast = createElement("div", `toast${type === "error" ? " error" : ""}`);
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.append(createElement("span", "", message));
  if (actionLabel && onAction) {
    const action = createElement("button", "", actionLabel);
    action.type = "button";
    action.addEventListener("click", async () => {
      toast.remove();
      await onAction();
    }, { once: true });
    toast.append(action);
  }
  toastRegion.append(toast);
  window.setTimeout(() => toast.remove(), duration);
}

function showError(error, fallback = "操作に失敗しました。") {
  console.error(error);
  showToast(error?.message || fallback, { type: "error", duration: 8000 });
}

function openDialog(dialog, focusSelector = null) {
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => (focusSelector ? dialog.querySelector(focusSelector) : null)?.focus());
}

function closeDialog(dialog) {
  if (dialog.open) dialog.close();
}

function closeMenu() {
  const menu = $("#side-menu");
  menu.classList.remove("open");
  menu.setAttribute("aria-hidden", "true");
  $("#menu-backdrop").hidden = true;
  $("#menu-button").setAttribute("aria-expanded", "false");
}

function openMenu() {
  const menu = $("#side-menu");
  menu.classList.add("open");
  menu.setAttribute("aria-hidden", "false");
  $("#menu-backdrop").hidden = false;
  $("#menu-button").setAttribute("aria-expanded", "true");
  $("#menu-close-button").focus();
}

async function loadSchedule(date = state.selectedDate) {
  state.selectedDate = date;
  state.plans = await getPlansByDate(date);
  renderSchedule();
}

async function loadHistory(date = state.historyDate) {
  state.historyDate = date;
  state.history = await getHistoryByDate(date);
  renderHistory();
}

function updateHeader() {
  const hasTimer = Boolean(state.timer && ACTIVE_TIMER_STATES.has(state.timer.status));
  timerReturnButton.hidden = !hasTimer || state.view === "timer";
  menuTimerButton.disabled = !hasTimer;
  if (state.view === "timer") {
    screenLabel.textContent = "タイマー";
    headerDate.textContent = state.timer ? formatDateLabel(state.timer.planDate) : "実行中タイマーなし";
  } else if (state.view === "history") {
    screenLabel.textContent = "日別履歴";
    headerDate.textContent = formatDateLabel(state.historyDate);
  } else if (state.view === "search") {
    screenLabel.textContent = "全期間検索";
    headerDate.textContent = "予定・履歴";
  } else if (state.view === "settings") {
    screenLabel.textContent = "設定・アプリ情報";
    headerDate.textContent = `バージョン ${globalThis.TIMEBOX_APP_VERSION ?? "不明"}`;
  } else {
    screenLabel.textContent = state.selectedDate === today() ? "今日の予定" : "日付別予定";
    headerDate.textContent = formatDateLabel(state.selectedDate);
  }
  renderBackupTimerState();
}

function renderBackupTimerState() {
  const active = Boolean(state.timer && ACTIVE_TIMER_STATES.has(state.timer.status));
  $("#backup-timer-warning").hidden = !active;
}

function renderPwaState(pwaState) {
  const networkStatus = $("#network-status");
  networkStatus.textContent = pwaState.online ? "● オンライン" : "○ オフライン";
  networkStatus.className = `network-status ${pwaState.online ? "online" : "offline"}`;
  $("#app-version").textContent = pwaState.appVersion;
  $("#settings-network-status").textContent = pwaState.online
    ? "オンライン表示（通信確認前）"
    : "オフライン";
  $("#service-worker-status").textContent = !pwaState.supported
    ? "このブラウザでは利用不可"
    : pwaState.registered ? "登録済み" : "登録準備中";
  $("#offline-ready-status").textContent = pwaState.offlineReady
    ? "準備完了（初回キャッシュ済み）"
    : "未完了（オンライン読み込みが必要）";
  $("#update-status-message").textContent = pwaState.message;

  const checkButton = $("#check-update-button");
  checkButton.disabled = !pwaState.supported || !pwaState.online || pwaState.checking;
  checkButton.textContent = pwaState.checking ? "確認中…" : "更新を確認";

  const applyButton = $("#apply-update-button");
  applyButton.hidden = !pwaState.updateAvailable;
  applyButton.disabled = pwaState.updateBlocked;
  applyButton.textContent = pwaState.updateBlocked ? "タイマー終了後に更新" : "更新する";

  const banner = $("#update-banner");
  banner.hidden = !pwaState.updateAvailable;
  banner.classList.toggle("blocked", pwaState.updateBlocked);
  $("#update-banner-message").textContent = pwaState.updateBlocked
    ? "タイマー終了後に更新できます。現在の計測と保存データは維持されます。"
    : "更新は自動適用されません。準備ができたら更新してください。";
  const bannerButton = $("#update-banner-button");
  bannerButton.disabled = pwaState.updateBlocked;
  bannerButton.textContent = pwaState.updateBlocked ? "タイマー終了後に更新" : "更新する";
}

function renderSettingsControls() {
  $("#sound-enabled").checked = state.settings.soundEnabled;
  $("#sound-volume").value = String(Math.round(state.settings.soundVolume * 100));
  $("#sound-volume-output").textContent = `${Math.round(state.settings.soundVolume * 100)}%`;
  $("#sound-volume").disabled = !state.settings.soundEnabled;
  $("#test-sound-button").disabled = !state.settings.soundEnabled;
  $("#schedule-notification").value = state.settings.scheduleNotification;
  $("#wake-lock-enabled").checked = state.settings.wakeLockEnabled;
}

function renderAlertState(alertState) {
  const permissionLabels = {
    default: "default（未選択）",
    granted: "granted（許可済み）",
    denied: "denied（拒否済み）",
    unavailable: "利用不可"
  };
  $("#notification-support-status").textContent = alertState.notificationSupported ? "利用可能" : "利用不可";
  $("#notification-permission-status").textContent = permissionLabels[alertState.notificationPermission] ?? alertState.notificationPermission;
  $("#notification-status-message").textContent = alertState.notificationMessage;
  $("#sound-status-message").textContent = !alertState.audioSupported
    ? "このブラウザまたは起動方法ではWeb Audio APIを利用できません。"
    : alertState.audioMessage;
  const enableButton = $("#enable-notification-button");
  enableButton.disabled = !alertState.notificationSupported || alertState.notificationPermission === "denied" || alertState.notificationPermission === "granted";
  enableButton.textContent = alertState.notificationPermission === "granted"
    ? "通知は有効です"
    : alertState.notificationPermission === "denied"
      ? "端末設定で確認"
      : "通知を有効にする";
  $("#test-notification-button").disabled = alertState.notificationPermission !== "granted";
  $("#test-sound-button").disabled = !alertState.audioSupported || !state.settings.soundEnabled;
}

function renderWakeLockState(wakeState) {
  $("#wake-lock-support-status").textContent = wakeState.supported ? "利用可能" : "利用不可";
  $("#wake-lock-active-status").textContent = wakeState.active ? "取得中" : "解除中";
  $("#wake-lock-status-message").textContent = wakeState.message;
  const checkbox = $("#wake-lock-enabled");
  checkbox.disabled = !wakeState.supported;
  if (!wakeState.supported) checkbox.checked = false;
}

async function updateSettings(patch) {
  const next = normalizeSettings({ ...state.settings, ...patch });
  try {
    await saveMetaValue(SETTINGS_META_KEY, next);
    state.settings = next;
    renderSettingsControls();
    alertManager.notifySettingsChanged();
    await wakeLockManager.sync();
  } catch (error) {
    renderSettingsControls();
    showError(error, "設定を保存できませんでした。変更は反映していません。");
  }
}

function setBackupStatus(message, error = false) {
  const status = $("#backup-status-message");
  status.textContent = message;
  status.classList.toggle("error", error);
}

function setBackupBusy(busy, message = "") {
  state.backupBusy = busy;
  $("#export-backup-button").disabled = busy;
  $("#backup-export-current-button").disabled = busy;
  $("#backup-replace-button").disabled = busy || !state.backupPreview;
  $("#backup-file-input").disabled = busy;
  if (message) {
    setBackupStatus(message);
    $("#backup-restore-status").textContent = message;
  }
  $("#export-backup-button").textContent = busy ? "処理中…" : "バックアップを書き出す";
  $("#backup-replace-button").textContent = busy ? "処理中…" : "全置換して読み込む";
}

async function exportBackup() {
  if (state.backupBusy) return false;
  setBackupBusy(true, "予定・履歴・設定を読み取っています…");
  try {
    const [snapshot, currentTimer] = await Promise.all([
      getBackupSnapshot(SETTINGS_META_KEY),
      getCurrentTimer()
    ]);
    const document = createBackupDocument({
      ...snapshot,
      settings: normalizeSettings(snapshot.settings ?? state.settings),
      schemaVersion: databaseInfo.schemaVersion,
      databaseVersion: databaseInfo.version,
      appVersion: globalThis.TIMEBOX_APP_VERSION ?? "unknown"
    });
    const result = await saveBackupFile({
      text: serializeBackup(document),
      filename: createBackupFilename()
    });
    if (result.method === "cancelled") {
      setBackupStatus("共有または保存をキャンセルしました。データは変更していません。");
      $("#backup-restore-status").textContent = "現在データの書き出しはキャンセルされました。復元はまだ実行していません。";
      return false;
    }
    const timerNotice = currentTimer ? " 実行中タイマーの状態はバックアップに含まれません。" : "";
    const message = `予定${document.data.plans.length}件、履歴${document.data.history.length}件、設定をバックアップしました。${timerNotice}`;
    setBackupStatus(message);
    if (backupRestoreDialog.open) $("#backup-restore-status").textContent = `${message} 復元する内容を引き続き確認できます。`;
    showToast(message);
    return true;
  } catch (error) {
    setBackupStatus(error?.message || "バックアップを書き出せませんでした。", true);
    showError(error, "バックアップを書き出せませんでした。既存データは変更していません。");
    return false;
  } finally {
    setBackupBusy(false);
  }
}

function clearBackupPreview({ close = true, message = "バックアップ操作を待っています。" } = {}) {
  state.backupPreview = null;
  $("#backup-file-input").value = "";
  $("#backup-file-name").textContent = "ファイルは選択されていません。";
  $("#backup-replace-button").disabled = true;
  setBackupStatus(message);
  if (close) closeDialog(backupRestoreDialog);
}

function showBackupPreview(document) {
  state.backupPreview = document;
  $("#backup-preview-exported-at").textContent = new Date(document.exportedAt).toLocaleString("ja-JP");
  $("#backup-preview-app-version").textContent = document.appVersion;
  $("#backup-preview-plan-count").textContent = `${document.data.plans.length}件`;
  $("#backup-preview-history-count").textContent = `${document.data.history.length}件`;
  $("#backup-restore-status").textContent = "全件の検証が完了しました。まだデータは変更していません。";
  $("#backup-replace-button").disabled = false;
  openDialog(backupRestoreDialog, "#backup-restore-cancel-button");
}

async function handleBackupFileSelection(event) {
  const input = event.currentTarget;
  const file = input.files?.[0];
  $("#backup-file-name").textContent = file?.name || "ファイルは選択されていません。";
  if (!file || state.backupBusy) {
    input.value = "";
    if (!file) setBackupStatus("JSONファイルが選択されていません。", true);
    return;
  }

  setBackupBusy(true, "バックアップファイルを検証しています…");
  try {
    const currentTimer = await getCurrentTimer();
    if (currentTimer) {
      throw new Error("実行中・一時停止中・終了待ちのタイマーがあるため、バックアップを読み込めません。先にタイマーを完了またはスキップしてください。");
    }
    const document = await readBackupFile(file, {
      schemaVersion: databaseInfo.schemaVersion,
      databaseVersion: databaseInfo.version
    });
    setBackupStatus(`「${file.name}」を検証しました。確認ダイアログで全置換を承認するまでデータは変更されません。`);
    showBackupPreview(document);
  } catch (error) {
    state.backupPreview = null;
    setBackupStatus(error?.message || "バックアップファイルを読み込めませんでした。", true);
    showError(error, "バックアップファイルを読み込めませんでした。既存データは変更していません。");
  } finally {
    input.value = "";
    setBackupBusy(false);
  }
}

async function restoreBackup() {
  if (state.backupBusy || !state.backupPreview) return;
  const preview = state.backupPreview;
  setBackupBusy(true, "実行中タイマーを再確認し、データを安全に置き換えています…");
  try {
    await replaceAllFromBackup({
      plans: preview.data.plans,
      history: preview.data.history,
      settings: preview.data.settings,
      settingsKey: SETTINGS_META_KEY,
      notificationLedgerKey: NOTIFICATION_LEDGER_META_KEY
    });
    alertManager.stopEndSound();
    state.timer = null;
    state.settings = preview.data.settings;
    renderSettingsControls();
    alertManager.notifySettingsChanged();
    pwaManager.notifyTimerStateChanged();
    await wakeLockManager.sync();
    closeDialog(backupRestoreDialog);
    setBackupStatus(`予定${preview.data.plans.length}件、履歴${preview.data.history.length}件、設定を復元しました。画面を再読み込みします。`);
    showToast("バックアップを全置換で復元しました。画面を再読み込みします。", { duration: 4000 });
    if (!state.backupReloadScheduled) {
      state.backupReloadScheduled = true;
      window.setTimeout(() => window.location.reload(), 700);
    }
  } catch (error) {
    $("#backup-restore-status").textContent = error?.message || "復元に失敗しました。既存データは変更していません。";
    setBackupStatus(error?.message || "復元に失敗しました。既存データは変更していません。", true);
    showError(error, "復元に失敗しました。トランザクションは中止され、既存データを維持しています。");
  } finally {
    setBackupBusy(false);
  }
}

async function showView(view) {
  closeMenu();
  if (view === "timer" && !state.timer) {
    showToast("実行中のタイマーはありません。");
    return;
  }
  state.view = view;
  scheduleView.hidden = view !== "schedule";
  timerView.hidden = view !== "timer";
  historyView.hidden = view !== "history";
  searchView.hidden = view !== "search";
  settingsView.hidden = view !== "settings";
  if (view === "schedule") await loadSchedule(state.selectedDate);
  if (view === "history") await loadHistory(state.historyDate);
  if (view === "search") searchController?.focus();
  if (view === "timer") renderTimer();
  updateHeader();
  window.scrollTo({ top: 0, behavior: "auto" });
}

function buildBadge(text, className = "") {
  return createElement("span", `type-badge ${className}`.trim(), text);
}

function buildPlanCard(plan, finished = false) {
  const active = state.timer?.planId === plan.id;
  const card = createElement("article", `plan-card${active ? " is-active" : ""}${finished ? ` ${plan.status}` : ""}`);
  card.dataset.planId = plan.id;
  const top = createElement("div", "card-top");
  const title = createElement("div", "card-title");
  title.append(createElement("strong", "", plan.title));
  title.append(createElement("small", "", planScheduleLabel(plan)));
  const badgeGroup = createElement("div", "card-meta");
  badgeGroup.append(buildBadge(plan.kind === "work" ? "作業" : "休憩", plan.kind === "break" ? "break" : ""));
  if (active) badgeGroup.append(createElement("span", "status-badge", state.timer.status === "running" ? "● 実行中" : state.timer.status === "paused" ? "Ⅱ 一時停止" : "! 終了待ち"));
  if (finished) badgeGroup.append(createElement("span", `status-badge ${plan.status}`, plan.status === "completed" ? "✓ 完了" : "– スキップ"));
  top.append(title, badgeGroup);
  card.append(top);
  if (plan.note) card.append(createElement("p", "card-note", plan.note));
  else if (finished) card.append(createElement("p", "card-meta", "メモなし"));
  if (finished) {
    const actual = createElement("div", "card-meta", `実績：${formatDuration(Number(plan.actualMs) || 0)}`);
    card.append(actual);
    return card;
  }

  const actions = createElement("div", "card-actions");
  if (active) {
    actions.append(actionButton("タイマーへ", "timer", plan.id, "primary"));
    actions.append(actionButton("作業名・メモ編集", "edit", plan.id));
  } else {
    const isToday = plan.date === today();
    actions.append(actionButton("開始", "start", plan.id, "primary", !isToday));
    actions.append(actionButton("手動完了", "manual", plan.id, "", !isToday));
    actions.append(actionButton("編集", "edit", plan.id));
    actions.append(actionButton("複製", "duplicate", plan.id));
    actions.append(actionButton("削除", "delete", plan.id, "danger"));
  }
  card.append(actions);
  return card;
}

function actionButton(label, action, id, className = "", disabled = false) {
  const button = createElement("button", className, label);
  button.type = "button";
  button.dataset.action = action;
  button.dataset.id = id;
  button.disabled = disabled;
  if (disabled) button.title = "タイマー開始と手動完了は対象日当日だけ利用できます。";
  return button;
}

function fillList(container, plans, emptyMessage, finished = false) {
  container.replaceChildren();
  if (!plans.length) {
    container.append(createElement("p", "empty-state", emptyMessage));
    return;
  }
  for (const plan of plans) container.append(buildPlanCard(plan, finished));
}

function renderSchedule() {
  const past = state.selectedDate < today();
  $("#selected-date").value = state.selectedDate;
  $("#schedule-title").textContent = state.selectedDate === today() ? "今日のタイムボックス" : formatDateLabel(state.selectedDate);
  $("#readonly-notice").hidden = !past;
  $("#add-plan-button").disabled = past;
  $("#copy-previous-button").disabled = past;
  const pending = state.plans.filter((plan) => plan.status === "pending");
  const finished = state.plans.filter((plan) => ["completed", "skipped"].includes(plan.status));
  const clocks = pending.filter((plan) => plan.scheduleType === "clock").sort((a, b) => a.startTime.localeCompare(b.startTime) || a.order - b.order);
  const durations = pending.filter((plan) => plan.scheduleType === "duration").sort((a, b) => a.order - b.order);
  fillList($("#clock-plan-list"), clocks, "時刻指定の予定はありません。");
  fillList($("#duration-plan-list"), durations, "時刻未指定のタスクはありません。");
  fillList($("#finished-plan-list"), finished, "完了・スキップ済みの予定はありません。", true);
  $("#finished-count").textContent = String(finished.length);
  $("#schedule-summary").textContent = `未完了 ${pending.length}件 / 完了・スキップ ${finished.length}件`;
  updateHeader();
}

function renderTimer() {
  if (!state.timer) return;
  const now = Date.now();
  const expired = state.timer.status === "expired";
  $("#timer-panel").classList.toggle("expired", expired);
  $("#timer-title").textContent = state.timer.title;
  $("#timer-status").textContent = expired ? "タイムボックス終了" : state.timer.status === "paused" ? "一時停止中" : "実行中";
  $("#timer-clock").textContent = expired ? "終了" : formatDuration(timerRemainingMs(state.timer, now) + 999, true);
  $("#timer-overtime").hidden = !expired;
  $("#timer-overtime").textContent = expired ? `+${Math.floor(timerOvertimeMs(state.timer, now) / MINUTE_MS)}分` : "";
  const kind = $("#timer-kind");
  kind.textContent = state.timer.kind === "work" ? "作業" : "休憩";
  kind.className = `type-badge${state.timer.kind === "break" ? " break" : ""}`;
  $("#timer-planned").textContent = `現在の目標 ${formatDuration(state.timer.currentTargetMs)}`;
  $("#timer-date").textContent = formatDateLabel(state.timer.planDate);
  $("#timer-note").textContent = state.timer.note || "メモなし";
  $("#pause-resume-button").textContent = state.timer.status === "paused" ? "再開" : "一時停止";
  $("#pause-resume-button").disabled = expired;
  $("#complete-timer-button").textContent = expired ? "完了して記録" : "完了";
  updateHeader();
}

function metric(label, value) {
  const box = createElement("div", "metric");
  box.append(createElement("span", "", label), createElement("strong", "", value));
  return box;
}

function renderHistory() {
  $("#history-date").value = state.historyDate;
  const aggregate = aggregateDay(state.history);
  const metrics = $("#history-metrics");
  metrics.replaceChildren(
    metric("作業 完了", `${aggregate.workCompleted}件`),
    metric("作業 スキップ", `${aggregate.workSkipped}件`),
    metric("合計作業時間", formatDuration(aggregate.workActualMs)),
    metric("作業達成率", `${Math.round(aggregate.workAchievementRate * 100)}%`),
    metric("休憩 完了", `${aggregate.breakCompleted}件`),
    metric("休憩 スキップ", `${aggregate.breakSkipped}件`)
  );
  const list = $("#history-list");
  list.replaceChildren();
  if (!state.history.length) list.append(createElement("p", "empty-state", "この日の履歴はありません。"));
  for (const entry of state.history) {
    const card = createElement("article", "history-card");
    card.dataset.historyId = entry.id;
    card.tabIndex = -1;
    const top = createElement("div", "card-top");
    const title = createElement("div", "card-title");
    title.append(createElement("strong", "", entry.title), createElement("small", "", entry.kind === "work" ? "作業" : "休憩"));
    top.append(title, createElement("span", `status-badge ${entry.outcome}`, entry.outcome === "completed" ? "✓ 完了" : "– スキップ"));
    card.append(top, createElement("div", "card-meta", `実績：${formatDuration(entry.actualMs)} / 記録：${new Date(entry.recordedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}`));
    if (entry.note) card.append(createElement("p", "card-note", entry.note));
    const actions = createElement("div", "card-actions");
    actions.append(actionButton("編集", "edit-history", entry.id), actionButton("削除", "delete-history", entry.id, "danger"));
    card.append(actions);
    list.append(card);
  }
  updateHeader();
}

function setScheduleFieldsVisibility() {
  const type = planForm.elements.scheduleType.value;
  $("#duration-fields").hidden = type !== "duration";
  $("#clock-fields").hidden = type !== "clock";
}

function openPlanEditor(plan = null, duplicate = false) {
  const activeEdit = Boolean(plan && state.timer?.planId === plan.id && !duplicate);
  state.editingPlan = plan;
  state.duplicateMode = duplicate;
  planForm.reset();
  $("#plan-form-error").hidden = true;
  $("#plan-dialog-title").textContent = duplicate ? "予定を複製" : plan ? "予定を編集" : "予定を追加";
  $("#plan-id").value = duplicate ? "" : plan?.id ?? "";
  $("#plan-title").value = plan?.title ?? "";
  $("#plan-note").value = plan?.note ?? "";
  $("#plan-kind").value = plan?.kind ?? "work";
  $("#plan-date").value = duplicate ? state.selectedDate : plan?.date ?? state.selectedDate;
  $("#plan-date").min = today();
  const scheduleType = plan?.scheduleType ?? "duration";
  planForm.elements.scheduleType.value = scheduleType;
  $("#plan-duration").value = plan?.durationMinutes ?? 30;
  $("#plan-start-time").value = plan?.startTime ?? "09:00";
  $("#plan-end-time").value = plan?.endTime ?? "09:30";
  for (const control of [$("#plan-kind"), $("#plan-date"), $("#plan-duration"), $("#plan-start-time"), $("#plan-end-time"), ...planForm.querySelectorAll("input[name='scheduleType']")]) {
    control.disabled = activeEdit;
  }
  $("#running-edit-notice").hidden = !activeEdit;
  setScheduleFieldsVisibility();
  openDialog(planDialog, "#plan-title");
}

async function submitPlan(event) {
  event.preventDefault();
  const submitButton = planForm.querySelector("button[type='submit']");
  setBusy(submitButton, true);
  try {
    const now = Date.now();
    const activeEdit = Boolean(state.editingPlan && state.timer?.planId === state.editingPlan.id && !state.duplicateMode);
    let plan;
    if (activeEdit) {
      plan = { ...state.editingPlan, title: $("#plan-title").value.trim(), note: $("#plan-note").value.trim(), updatedAt: now };
    } else {
      const id = state.editingPlan && !state.duplicateMode ? state.editingPlan.id : createId("plan");
      const date = $("#plan-date").value;
      const existingForDate = date === state.selectedDate ? state.plans : await getPlansByDate(date);
      const maxOrder = existingForDate.reduce((max, item) => Math.max(max, Number(item.order) || 0), 0);
      plan = {
        schemaVersion: SCHEMA_VERSION,
        id,
        date,
        title: $("#plan-title").value.trim(),
        note: $("#plan-note").value.trim(),
        kind: $("#plan-kind").value,
        scheduleType: planForm.elements.scheduleType.value,
        durationMinutes: Number($("#plan-duration").value),
        startTime: $("#plan-start-time").value,
        endTime: $("#plan-end-time").value,
        status: "pending",
        order: state.editingPlan && !state.duplicateMode ? state.editingPlan.order : maxOrder + 1,
        createdAt: state.editingPlan && !state.duplicateMode ? state.editingPlan.createdAt : now,
        updatedAt: now,
        actualMs: null
      };
    }
    const errors = validatePlan(plan);
    if (plan.date < today()) errors.push("過去日には予定を保存できません。");
    let plansForDate = plan.date === state.selectedDate ? state.plans : await getPlansByDate(plan.date);
    const conflict = findClockOverlap(plan, plansForDate, activeEdit || (state.editingPlan && !state.duplicateMode) ? state.editingPlan.id : null);
    if (conflict) errors.push(`「${conflict.title}」(${conflict.startTime}〜${conflict.endTime}) と時刻が重複しています。`);
    if (errors.length) {
      const errorBox = $("#plan-form-error");
      errorBox.textContent = errors.join("\n");
      errorBox.hidden = false;
      $("#plan-title").focus();
      return;
    }
    if (activeEdit) {
      const timer = { ...state.timer, title: plan.title, note: plan.note, updatedAt: now };
      await savePlanAndTimer(plan, timer);
      state.timer = timer;
    } else {
      await savePlan(plan);
    }
    closeDialog(planDialog);
    state.selectedDate = plan.date;
    await loadSchedule(plan.date);
    if (state.view === "timer") renderTimer();
    showToast(state.duplicateMode ? "予定を複製しました。" : "予定を保存しました。");
  } catch (error) {
    showError(error, "予定を保存できませんでした。");
  } finally {
    setBusy(submitButton, false);
  }
}

async function startPlan(plan, targetMs) {
  try {
    if (state.timer) {
      showToast("別のタイマーが動作中です。現在のタイマーを確認してください。", { actionLabel: "タイマーへ", onAction: () => showView("timer") });
      return;
    }
    const timer = createTimer(plan, Date.now(), targetMs);
    await startCurrentTimer(timer);
    state.timer = timer;
    pwaManager.notifyTimerStateChanged();
    await wakeLockManager.sync();
    closeDialog(lateStartDialog);
    await showView("timer");
  } catch (error) {
    showError(error, "タイマーを開始できませんでした。");
  }
}

async function requestStart(plan) {
  if (plan.date !== today()) return;
  if (state.timer) {
    showToast("別のタイマーが動作中です。現在のタイマーを確認してください。", { actionLabel: "タイマーへ", onAction: () => showView("timer") });
    return;
  }
  const decision = classifyClockStart(plan, Date.now());
  if (decision.mode !== "late-choice") {
    await startPlan(plan, decision.durationMs);
    return;
  }
  state.pendingStart = { plan, decision };
  $("#late-start-message").textContent = `${plan.startTime}〜${plan.endTime}「${plan.title}」の開始時刻を過ぎています。`;
  $("#start-full-button").textContent = `予定時間をすべて実行（${formatDuration(decision.durationMs)}）`;
  $("#start-until-end-button").textContent = `本来の終了時刻まで実行（${formatDuration(decision.untilEndMs)}）`;
  openDialog(lateStartDialog, "#start-full-button");
}

function createHistoryEntry(plan, outcome, actualMs, timer = null, source = "timer") {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: createId("history"),
    planId: plan.id,
    date: timer?.planDate ?? plan.date,
    title: plan.title,
    note: plan.note,
    kind: plan.kind,
    outcome,
    actualMs: Math.max(0, Math.round(actualMs)),
    plannedMs: getPlanDurationMs(plan),
    actualStartedAt: timer?.actualStartedAt ?? null,
    recordedAt: Date.now(),
    source
  };
}

async function finalizeTimer(outcome, options = {}) {
  if (!state.timer) return;
  alertManager.stopEndSound();
  try {
    const now = Date.now();
    const timer = reduceTimer(state.timer, { type: "sync" }, now);
    const plans = await getPlansByDate(timer.planDate);
    const plan = plans.find((item) => item.id === timer.planId);
    if (!plan) throw new Error("タイマーに対応する予定が見つかりません。データは変更していません。");
    const actualMs = outcomeActualMs(timer, now, options);
    const updatedPlan = { ...plan, status: outcome, actualMs, completedAt: now, updatedAt: now };
    const history = createHistoryEntry(plan, outcome, actualMs, timer);
    await commitOutcome(updatedPlan, history);
    state.timer = null;
    pwaManager.notifyTimerStateChanged();
    await wakeLockManager.sync();
    closeDialog(expiredCompleteDialog);
    state.selectedDate = timer.planDate;
    await loadSchedule(timer.planDate);
    await showView("schedule");
    showToast(outcome === "completed" ? "完了を記録しました。" : "スキップを記録しました。");
  } catch (error) {
    showError(error, "履歴を保存できませんでした。タイマーは解除していません。");
  }
}

async function syncTimer({ persist = true } = {}) {
  if (!state.timer || state.timerSyncing) return;
  state.timerSyncing = true;
  try {
    const previousStatus = state.timer.status;
    const synced = reduceTimer(state.timer, { type: "sync" }, Date.now());
    const changed = synced.status !== previousStatus;
    state.timer = synced;
    if (persist && changed && synced.status === "expired") await saveCurrentTimer(synced);
    if (changed) {
      pwaManager.notifyTimerStateChanged();
      await wakeLockManager.sync();
      if (previousStatus === "running" && synced.status === "expired") {
        await alertManager.handleTimerExpired(synced);
        showToast(`「${synced.title}」のタイムボックスが終了しました。`, {
          actionLabel: "タイマーへ",
          onAction: () => showView("timer"),
          duration: 10000
        });
      }
    }
    if (state.view === "timer") renderTimer();
    updateHeader();
  } catch (error) {
    showError(error, "タイマー状態を復元できませんでした。");
  } finally {
    state.timerSyncing = false;
  }
}

async function timerAction(type) {
  if (!state.timer) return;
  if (type === "extend") alertManager.stopEndSound();
  try {
    const next = reduceTimer(state.timer, { type }, Date.now());
    await saveCurrentTimer(next);
    state.timer = next;
    pwaManager.notifyTimerStateChanged();
    await wakeLockManager.sync();
    renderTimer();
  } catch (error) {
    showError(error, "タイマー操作を保存できませんでした。");
  }
}

async function deletePendingPlan(plan) {
  if (state.timer?.planId === plan.id) {
    showToast("実行中・一時停止中・終了待ちの予定は削除できません。", { type: "error" });
    return;
  }
  try {
    await deletePlan(plan.id);
    await loadSchedule(state.selectedDate);
    if (state.undoTimer) clearTimeout(state.undoTimer);
    const restore = async () => {
      try {
        await savePlan(plan);
        await loadSchedule(plan.date);
        showToast("予定を元の位置へ戻しました。");
      } catch (error) {
        showError(error, "予定を元に戻せませんでした。");
      }
    };
    showToast(`「${plan.title}」を削除しました。`, { actionLabel: "元に戻す", onAction: restore, duration: 7000 });
    state.undoTimer = window.setTimeout(() => { state.undoTimer = null; }, 7000);
  } catch (error) {
    showError(error, "予定を削除できませんでした。");
  }
}

function showConfirmation(message, confirmLabel = "続ける") {
  return new Promise((resolve) => {
    $("#confirm-message").textContent = message;
    $("#confirm-ok-button").textContent = confirmLabel;
    let settled = false;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      closeDialog(confirmDialog);
      resolve(answer);
    };
    $("#confirm-ok-button").onclick = () => finish(true);
    $("#confirm-cancel-button").onclick = () => finish(false);
    confirmDialog.addEventListener("cancel", () => finish(false), { once: true });
    openDialog(confirmDialog, "#confirm-cancel-button");
  });
}

async function copyPreviousDay() {
  if (state.selectedDate < today()) return;
  const button = $("#copy-previous-button");
  setBusy(button, true);
  try {
    const sourceDate = shiftLocalDate(state.selectedDate, -1);
    const source = await getPlansByDate(sourceDate);
    if (!source.length) {
      showToast("前日にコピーできる予定がありません。");
      return;
    }
    const destination = await getPlansByDate(state.selectedDate);
    if (destination.length) {
      const confirmed = await showConfirmation(`コピー先には既に${destination.length}件の予定があります。前日の予定${source.length}件を追加しますか？`, "追加コピー");
      if (!confirmed) return;
    }
    const validation = validateCopyBatch(source, destination, state.selectedDate);
    if (!validation.valid) {
      const details = validation.conflicts.map(({ plan, conflict }) => `「${plan.title}」と「${conflict.title}」(${conflict.startTime}〜${conflict.endTime})`).join("、");
      showToast(`時刻重複があるため全件コピーを中止しました：${details}`, { type: "error", duration: 10000 });
      return;
    }
    const now = Date.now();
    const maxOrder = destination.reduce((max, plan) => Math.max(max, Number(plan.order) || 0), 0);
    const ordered = [...source].sort((a, b) => a.order - b.order);
    const copies = ordered.map((plan, index) => ({
      ...plan,
      id: createId("plan"),
      date: state.selectedDate,
      status: "pending",
      actualMs: null,
      completedAt: null,
      order: maxOrder + index + 1,
      createdAt: now + index,
      updatedAt: now
    }));
    await putPlansAtomically(copies);
    await loadSchedule(state.selectedDate);
    showToast(`前日の予定を${copies.length}件コピーしました。`);
  } catch (error) {
    showError(error, "前日の予定をコピーできませんでした。部分保存は行っていません。");
  } finally {
    setBusy(button, false);
  }
}

function openManualDialog(plan) {
  if (plan.date !== today() || state.timer?.planId === plan.id) return;
  state.manualPlan = plan;
  $("#manual-plan-name").textContent = `「${plan.title}」をタイマーなしで完了します。`;
  $("#manual-minutes").value = "";
  $("#manual-error").hidden = true;
  openDialog(manualDialog, "#manual-minutes");
}

async function submitManual(event) {
  event.preventDefault();
  if (!state.manualPlan) return;
  const raw = $("#manual-minutes").value.trim();
  const minutes = raw === "" ? 0 : Number(raw);
  if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes < 0) {
    $("#manual-error").textContent = "実績時間は0以上の整数で入力してください。";
    $("#manual-error").hidden = false;
    return;
  }
  const submit = $("#manual-form button[type='submit']");
  setBusy(submit, true);
  try {
    const now = Date.now();
    const plan = { ...state.manualPlan, status: "completed", actualMs: minutes * MINUTE_MS, completedAt: now, updatedAt: now };
    const history = createHistoryEntry(plan, "completed", plan.actualMs, null, "manual");
    await commitManualCompletion(plan, history);
    closeDialog(manualDialog);
    await loadSchedule(plan.date);
    showToast("手動完了を記録しました。");
  } catch (error) {
    showError(error, "手動完了を保存できませんでした。");
  } finally {
    setBusy(submit, false);
  }
}

async function pollScheduleNotifications() {
  if (state.scheduleNotificationChecking) return;
  state.scheduleNotificationChecking = true;
  const now = Date.now();
  const previousCheck = state.scheduleNotificationCheckAt;
  state.scheduleNotificationCheckAt = now;
  try {
    const plans = await getPlansByDate(today());
    await alertManager.checkScheduleNotifications(plans, previousCheck, now);
  } catch (error) {
    console.warn("Schedule notification check failed", error);
  } finally {
    state.scheduleNotificationChecking = false;
  }
}

async function handleCardAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const plan = state.plans.find((item) => item.id === button.dataset.id);
  if (!plan) return;
  switch (button.dataset.action) {
    case "start": await requestStart(plan); break;
    case "manual": openManualDialog(plan); break;
    case "edit": openPlanEditor(plan); break;
    case "duplicate": openPlanEditor(plan, true); break;
    case "delete": await deletePendingPlan(plan); break;
    case "timer": await showView("timer"); break;
  }
}

function focusResultCard(attribute, id, { focusAction = false } = {}) {
  const cards = [...document.querySelectorAll(`[${attribute}]`)];
  const card = cards.find((item) => item.getAttribute(attribute) === id);
  if (!card) {
    showToast("対象のカードは更新または削除されています。", { type: "error" });
    return;
  }
  card.classList.add("target-highlight");
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  const target = focusAction ? card.querySelector("button") ?? card : card;
  target.focus({ preventScroll: true });
  window.setTimeout(() => card.classList.remove("target-highlight"), 2600);
}

async function openPlanSearchResult(result) {
  state.selectedDate = result.date;
  await showView("schedule");
  if (result.status !== "pending") $("#finished-section").open = true;
  focusResultCard("data-plan-id", result.id);
}

async function openHistorySearchResult(result) {
  state.historyDate = result.date;
  await showView("history");
  focusResultCard("data-history-id", result.id, { focusAction: true });
}

function historyEditValues() {
  return {
    title: $("#history-edit-name").value,
    note: $("#history-edit-note").value,
    kind: $("#history-edit-kind").value,
    outcome: $("#history-edit-outcome").value,
    actualMinutes: $("#history-edit-minutes").value
  };
}

function showHistoryEditError(error, target = "#history-edit-error") {
  const box = $(target);
  box.textContent = error?.message || "履歴の処理に失敗しました。";
  box.hidden = false;
}

async function openHistoryEditor(entry) {
  try {
    const latest = await getHistoryEntryById(entry.id);
    if (!latest) throw new Error("対象の履歴は既に削除されています。画面を更新してください。");
    state.editingHistory = latest;
    state.pendingHistoryEdit = null;
    $("#history-edit-error").hidden = true;
    $("#history-edit-name").value = latest.title;
    $("#history-edit-note").value = latest.note;
    $("#history-edit-kind").value = latest.kind;
    $("#history-edit-outcome").value = latest.outcome;
    $("#history-edit-minutes").value = String(Math.round(latest.actualMs / MINUTE_MS));
    $("#history-edit-date").textContent = formatDateLabel(latest.date);
    $("#history-edit-recorded-at").textContent = new Date(latest.recordedAt).toLocaleString("ja-JP");
    openDialog(historyEditDialog, "#history-edit-name");
  } catch (error) {
    showError(error, "履歴を開けませんでした。");
    await loadHistory(state.historyDate);
  }
}

function addChangeRow(list, label, before, after) {
  const row = createElement("div");
  row.append(createElement("dt", "", label), createElement("dd", "", `${before} → ${after}`));
  list.append(row);
}

async function reviewHistoryEdit(event) {
  event.preventDefault();
  if (state.historyMutationBusy || !state.editingHistory) return;
  try {
    const values = historyEditValues();
    const validated = validateHistoryEditInput(values);
    const edited = buildEditedHistory(state.editingHistory, validated);
    const relatedPlan = await getPlanById(edited.planId);
    state.pendingHistoryEdit = {
      current: state.editingHistory,
      values: validated,
      edited,
      expectedRevision: historyRevisionKey(state.editingHistory)
    };
    const changes = $("#history-edit-changes");
    changes.replaceChildren();
    addChangeRow(changes, "結果", state.editingHistory.outcome === "completed" ? "完了" : "スキップ", edited.outcome === "completed" ? "完了" : "スキップ");
    addChangeRow(changes, "実績時間", formatDuration(state.editingHistory.actualMs), formatDuration(edited.actualMs));
    addChangeRow(changes, "種類", state.editingHistory.kind === "work" ? "作業" : "休憩", edited.kind === "work" ? "作業" : "休憩");
    addChangeRow(changes, "作業名", state.editingHistory.title, edited.title);
    addChangeRow(changes, "メモ", state.editingHistory.note || "なし", edited.note || "なし");
    $("#history-edit-confirm-name").textContent = `「${state.editingHistory.title}」／${formatDateLabel(state.editingHistory.date)}`;
    $("#history-edit-plan-sync-note").textContent = relatedPlan
      ? "関連予定が存在するため、履歴と予定を1つのトランザクションで同期します。"
      : "関連予定が存在しない孤立履歴のため、履歴だけを更新します。";
    $("#history-edit-confirm-error").hidden = true;
    closeDialog(historyEditDialog);
    openDialog(historyEditConfirmDialog, "#history-edit-confirm-cancel-button");
  } catch (error) {
    showHistoryEditError(error);
  }
}

function setHistoryMutationBusy(busy) {
  state.historyMutationBusy = busy;
  for (const id of ["history-edit-save-button", "history-edit-confirm-cancel-button", "history-delete-confirm-button", "history-delete-cancel-button"]) {
    const button = $(`#${id}`);
    button.disabled = busy;
    button.setAttribute("aria-busy", String(busy));
  }
  $("#history-edit-save-button").textContent = busy ? "保存中…" : "変更を保存";
  $("#history-delete-confirm-button").textContent = busy ? "削除中…" : "履歴を削除";
}

async function refreshAfterHistoryMutation(date) {
  await loadHistory(state.historyDate);
  if (state.selectedDate === date) {
    state.plans = await getPlansByDate(date);
    if (state.view === "schedule") renderSchedule();
  }
  await searchController?.refresh();
}

async function saveHistoryEdit() {
  if (state.historyMutationBusy || !state.pendingHistoryEdit) return;
  setHistoryMutationBusy(true);
  $("#history-edit-confirm-error").hidden = true;
  const pending = state.pendingHistoryEdit;
  try {
    await updateHistoryAndRelatedPlan({
      historyId: pending.current.id,
      expectedRevision: pending.expectedRevision,
      changes: pending.values
    });
    closeDialog(historyEditConfirmDialog);
    state.editingHistory = null;
    state.pendingHistoryEdit = null;
    await refreshAfterHistoryMutation(pending.current.date);
    showToast("履歴と関連予定を更新しました。");
  } catch (error) {
    if (String(error?.message).includes("既に削除")) {
      closeDialog(historyEditConfirmDialog);
      state.editingHistory = null;
      state.pendingHistoryEdit = null;
      await refreshAfterHistoryMutation(pending.current.date);
    } else {
      showHistoryEditError(error, "#history-edit-confirm-error");
    }
    showError(error, "履歴を更新できませんでした。");
  } finally {
    setHistoryMutationBusy(false);
  }
}

async function openHistoryDelete(entry) {
  try {
    const latest = await getHistoryEntryById(entry.id);
    if (!latest) throw new Error("対象の履歴は既に削除されています。画面を更新してください。");
    state.deletingHistory = { entry: latest, expectedRevision: historyRevisionKey(latest) };
    $("#history-delete-target").textContent = `「${latest.title}」／${formatDateLabel(latest.date)}`;
    $("#history-delete-error").hidden = true;
    openDialog(historyDeleteDialog, "#history-delete-cancel-button");
  } catch (error) {
    showError(error, "削除対象を開けませんでした。");
    await loadHistory(state.historyDate);
  }
}

async function deleteHistoryEntry() {
  if (state.historyMutationBusy || !state.deletingHistory) return;
  setHistoryMutationBusy(true);
  $("#history-delete-error").hidden = true;
  const target = state.deletingHistory;
  try {
    await deleteHistoryAndReconcilePlan({ historyId: target.entry.id, expectedRevision: target.expectedRevision });
    closeDialog(historyDeleteDialog);
    state.deletingHistory = null;
    await refreshAfterHistoryMutation(target.entry.date);
    showToast("履歴を削除し、関連予定を再調整しました。");
  } catch (error) {
    if (String(error?.message).includes("既に削除")) {
      closeDialog(historyDeleteDialog);
      state.deletingHistory = null;
      await refreshAfterHistoryMutation(target.entry.date);
    } else {
      showHistoryEditError(error, "#history-delete-error");
    }
    showError(error, "履歴を削除できませんでした。");
  } finally {
    setHistoryMutationBusy(false);
  }
}

async function handleHistoryAction(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const entry = state.history.find((item) => item.id === button.dataset.id);
  if (!entry) return;
  if (button.dataset.action === "edit-history") await openHistoryEditor(entry);
  if (button.dataset.action === "delete-history") await openHistoryDelete(entry);
}

function bindEvents() {
  $("#menu-button").addEventListener("click", openMenu);
  $("#menu-close-button").addEventListener("click", closeMenu);
  $("#menu-backdrop").addEventListener("click", closeMenu);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if ($("#side-menu").classList.contains("open")) closeMenu();
    const openDialogs = [...document.querySelectorAll("dialog[open]")];
    const topDialog = openDialogs.at(-1);
    if (!topDialog) return;
    if (state.historyMutationBusy && [historyEditConfirmDialog, historyDeleteDialog].includes(topDialog)) return;
    event.preventDefault();
    if (topDialog === confirmDialog) $("#confirm-cancel-button").click();
    else if (topDialog === backupRestoreDialog) $("#backup-restore-cancel-button").click();
    else if (topDialog === historyEditConfirmDialog) $("#history-edit-confirm-cancel-button").click();
    else if (topDialog === historyDeleteDialog) $("#history-delete-cancel-button").click();
    else if (topDialog === historyEditDialog) $("#history-edit-cancel-button").click();
    else closeDialog(topDialog);
  });
  document.querySelectorAll("[data-navigation]").forEach((button) => button.addEventListener("click", async () => {
    if (button.dataset.navigation === "today") {
      state.selectedDate = today();
      await showView("schedule");
    } else await showView(button.dataset.navigation);
  }));
  timerReturnButton.addEventListener("click", () => showView("timer"));
  $("#add-plan-button").addEventListener("click", () => openPlanEditor());
  $("#clock-plan-list").addEventListener("click", handleCardAction);
  $("#duration-plan-list").addEventListener("click", handleCardAction);
  planForm.addEventListener("submit", submitPlan);
  planForm.querySelectorAll("input[name='scheduleType']").forEach((input) => input.addEventListener("change", setScheduleFieldsVisibility));
  document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => closeDialog($(`#${button.dataset.closeDialog}`))));
  $("#previous-day-button").addEventListener("click", () => loadSchedule(shiftLocalDate(state.selectedDate, -1)));
  $("#next-day-button").addEventListener("click", () => loadSchedule(shiftLocalDate(state.selectedDate, 1)));
  $("#today-button").addEventListener("click", () => loadSchedule(today()));
  $("#selected-date").addEventListener("change", (event) => event.target.value && loadSchedule(event.target.value).catch(showError));
  $("#copy-previous-button").addEventListener("click", copyPreviousDay);
  $("#start-full-button").addEventListener("click", () => state.pendingStart && startPlan(state.pendingStart.plan, state.pendingStart.decision.durationMs));
  $("#start-until-end-button").addEventListener("click", () => state.pendingStart && startPlan(state.pendingStart.plan, state.pendingStart.decision.untilEndMs));
  $("#manual-form").addEventListener("submit", submitManual);
  $("#pause-resume-button").addEventListener("click", () => timerAction(state.timer?.status === "paused" ? "resume" : "pause"));
  $("#extend-timer-button").addEventListener("click", () => timerAction("extend"));
  $("#complete-timer-button").addEventListener("click", async () => {
    alertManager.stopEndSound();
    await syncTimer();
    if (state.timer?.status === "expired") openDialog(expiredCompleteDialog, "#complete-overtime-button");
    else await finalizeTimer("completed");
  });
  $("#skip-timer-button").addEventListener("click", async () => {
    alertManager.stopEndSound();
    const confirmed = await showConfirmation("このタイムボックスをスキップしますか？計測済み時間は履歴へ記録されます。", "スキップ");
    if (confirmed) await finalizeTimer("skipped", { includeOvertime: true });
  });
  $("#complete-planned-button").addEventListener("click", () => finalizeTimer("completed", { plannedOnly: true, includeOvertime: false }));
  $("#complete-overtime-button").addEventListener("click", () => finalizeTimer("completed", { includeOvertime: true }));
  $("#back-to-schedule-button").addEventListener("click", () => showView("schedule"));
  $("#history-previous-button").addEventListener("click", () => loadHistory(shiftLocalDate(state.historyDate, -1)));
  $("#history-next-button").addEventListener("click", () => loadHistory(shiftLocalDate(state.historyDate, 1)));
  $("#history-today-button").addEventListener("click", () => loadHistory(today()));
  $("#history-date").addEventListener("change", (event) => event.target.value && loadHistory(event.target.value).catch(showError));
  $("#history-list").addEventListener("click", handleHistoryAction);
  $("#history-edit-form").addEventListener("submit", reviewHistoryEdit);
  $("#history-edit-cancel-button").addEventListener("click", () => {
    if (state.historyMutationBusy) return;
    state.editingHistory = null;
    state.pendingHistoryEdit = null;
    closeDialog(historyEditDialog);
  });
  $("#history-edit-confirm-cancel-button").addEventListener("click", () => {
    if (state.historyMutationBusy) return;
    closeDialog(historyEditConfirmDialog);
    openDialog(historyEditDialog, "#history-edit-name");
  });
  $("#history-edit-save-button").addEventListener("click", saveHistoryEdit);
  $("#history-delete-cancel-button").addEventListener("click", () => {
    if (state.historyMutationBusy) return;
    state.deletingHistory = null;
    closeDialog(historyDeleteDialog);
  });
  $("#history-delete-confirm-button").addEventListener("click", deleteHistoryEntry);
  $("#check-update-button").addEventListener("click", () => pwaManager.checkForUpdate());
  $("#apply-update-button").addEventListener("click", () => pwaManager.applyUpdate());
  $("#update-banner-button").addEventListener("click", () => pwaManager.applyUpdate());
  $("#sound-enabled").addEventListener("change", (event) => updateSettings({ soundEnabled: event.target.checked }));
  $("#sound-volume").addEventListener("input", (event) => { $("#sound-volume-output").textContent = `${event.target.value}%`; });
  $("#sound-volume").addEventListener("change", (event) => updateSettings({ soundVolume: Number(event.target.value) / 100 }));
  $("#test-sound-button").addEventListener("click", () => alertManager.testSound());
  $("#enable-notification-button").addEventListener("click", () => alertManager.requestNotificationPermission());
  $("#test-notification-button").addEventListener("click", () => alertManager.testNotification());
  $("#schedule-notification").addEventListener("change", (event) => updateSettings({ scheduleNotification: event.target.value }));
  $("#wake-lock-enabled").addEventListener("change", (event) => updateSettings({ wakeLockEnabled: event.target.checked }));
  $("#export-backup-button").addEventListener("click", exportBackup);
  $("#backup-file-input").addEventListener("change", handleBackupFileSelection);
  $("#backup-export-current-button").addEventListener("click", exportBackup);
  $("#backup-replace-button").addEventListener("click", restoreBackup);
  for (const id of ["backup-restore-close-button", "backup-restore-cancel-button"]) {
    $(`#${id}`).addEventListener("click", () => clearBackupPreview({ message: "バックアップの読み込みをキャンセルしました。データは変更していません。" }));
  }
  backupRestoreDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    clearBackupPreview({ message: "バックアップの読み込みをキャンセルしました。データは変更していません。" });
  });
  for (const eventName of ["pageshow", "focus"]) window.addEventListener(eventName, () => {
    void syncTimer();
    void pollScheduleNotifications();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      void syncTimer();
      void pollScheduleNotifications();
    }
  });
}

async function initialize() {
  pwaManager.subscribe(renderPwaState);
  alertManager.subscribe(renderAlertState);
  wakeLockManager.subscribe(renderWakeLockState);
  searchController = createSearchViewController({
    getSnapshot: getSearchSnapshot,
    onOpenPlan: openPlanSearchResult,
    onOpenHistory: openHistorySearchResult,
    onError: showError
  });
  bindEvents();
  try {
    await initializeDatabase();
    const savedSettings = await getMetaValue(SETTINGS_META_KEY);
    state.settings = normalizeSettings(savedSettings);
    if (!savedSettings) await saveMetaValue(SETTINGS_META_KEY, state.settings);
    renderSettingsControls();
    await alertManager.start();
    state.timer = await getCurrentTimer();
    if (state.timer) {
      state.timer = reduceTimer(state.timer, { type: "sync" }, Date.now());
      await saveCurrentTimer(state.timer);
    }
    pwaManager.notifyTimerStateChanged();
    wakeLockManager.start();
    await loadSchedule(state.selectedDate);
    loading.hidden = true;
    app.hidden = false;
    await showView(state.timer ? "timer" : "schedule");
    state.scheduleNotificationCheckAt = Date.now();
    void pwaManager.start();
  } catch (error) {
    console.error(error);
    loading.innerHTML = "";
    const box = createElement("div", "loading-box");
    box.setAttribute("role", "alert");
    box.append(createElement("strong", "", "保存データを読み込めませんでした。"), createElement("p", "", error?.message || "IndexedDBの初期化に失敗しました。再読み込みしてください。"));
    loading.append(box);
  }
}

window.setInterval(() => syncTimer({ persist: true }), 1000);
window.setInterval(() => pollScheduleNotifications(), 30_000);
initialize();
