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
  commitManualCompletion,
  commitOutcome,
  deletePlan,
  getCurrentTimer,
  getHistoryByDate,
  getPlansByDate,
  initializeDatabase,
  putPlansAtomically,
  saveCurrentTimer,
  savePlan,
  savePlanAndTimer,
  startCurrentTimer
} from "./db.js";
import { createPwaManager } from "./pwa.js";

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
  timerSyncing: false
};

const pwaManager = createPwaManager({ getTimerStatus: () => state.timer?.status ?? "idle" });

const loading = $("#loading");
const app = $("#app");
const screenLabel = $("#screen-label");
const headerDate = $("#header-date");
const timerReturnButton = $("#timer-return-button");
const menuTimerButton = $("#menu-timer-button");
const scheduleView = $("#schedule-view");
const timerView = $("#timer-view");
const historyView = $("#history-view");
const settingsView = $("#settings-view");
const planDialog = $("#plan-dialog");
const planForm = $("#plan-form");
const lateStartDialog = $("#late-start-dialog");
const manualDialog = $("#manual-dialog");
const expiredCompleteDialog = $("#expired-complete-dialog");
const confirmDialog = $("#confirm-dialog");
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
  } else if (state.view === "settings") {
    screenLabel.textContent = "設定・アプリ情報";
    headerDate.textContent = `バージョン ${globalThis.TIMEBOX_APP_VERSION ?? "不明"}`;
  } else {
    screenLabel.textContent = state.selectedDate === today() ? "今日の予定" : "日付別予定";
    headerDate.textContent = formatDateLabel(state.selectedDate);
  }
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
  settingsView.hidden = view !== "settings";
  if (view === "schedule") await loadSchedule(state.selectedDate);
  if (view === "history") await loadHistory(state.historyDate);
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
  $("#timer-status").textContent = expired ? "終了待ち" : state.timer.status === "paused" ? "一時停止中" : "実行中";
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
    const top = createElement("div", "card-top");
    const title = createElement("div", "card-title");
    title.append(createElement("strong", "", entry.title), createElement("small", "", entry.kind === "work" ? "作業" : "休憩"));
    top.append(title, createElement("span", `status-badge ${entry.outcome}`, entry.outcome === "completed" ? "✓ 完了" : "– スキップ"));
    card.append(top, createElement("div", "card-meta", `実績：${formatDuration(entry.actualMs)} / 記録：${new Date(entry.recordedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}`));
    if (entry.note) card.append(createElement("p", "card-note", entry.note));
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
    const synced = reduceTimer(state.timer, { type: "sync" }, Date.now());
    const changed = synced.status !== state.timer.status;
    state.timer = synced;
    if (changed) pwaManager.notifyTimerStateChanged();
    if (persist && changed && synced.status === "expired") await saveCurrentTimer(synced);
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
  try {
    const next = reduceTimer(state.timer, { type }, Date.now());
    await saveCurrentTimer(next);
    state.timer = next;
    pwaManager.notifyTimerStateChanged();
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
    event.preventDefault();
    if (topDialog === confirmDialog) $("#confirm-cancel-button").click();
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
    await syncTimer();
    if (state.timer?.status === "expired") openDialog(expiredCompleteDialog, "#complete-overtime-button");
    else await finalizeTimer("completed");
  });
  $("#skip-timer-button").addEventListener("click", async () => {
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
  $("#check-update-button").addEventListener("click", () => pwaManager.checkForUpdate());
  $("#apply-update-button").addEventListener("click", () => pwaManager.applyUpdate());
  $("#update-banner-button").addEventListener("click", () => pwaManager.applyUpdate());
  for (const eventName of ["pageshow", "focus"]) window.addEventListener(eventName, () => syncTimer());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncTimer(); });
}

async function initialize() {
  pwaManager.subscribe(renderPwaState);
  bindEvents();
  try {
    await initializeDatabase();
    state.timer = await getCurrentTimer();
    if (state.timer) {
      state.timer = reduceTimer(state.timer, { type: "sync" }, Date.now());
      await saveCurrentTimer(state.timer);
    }
    pwaManager.notifyTimerStateChanged();
    await loadSchedule(state.selectedDate);
    loading.hidden = true;
    app.hidden = false;
    await showView(state.timer ? "timer" : "schedule");
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
initialize();
