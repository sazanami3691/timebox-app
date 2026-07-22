import { noteExcerpt, searchRecords } from "./search.js";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function durationLabel(ms) {
  const minutes = Math.round(Math.max(0, Number(ms) || 0) / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}時間${minutes % 60 ? `${minutes % 60}分` : ""}` : `${minutes}分`;
}

function resultCard(result, openResult) {
  const card = element("article", `search-result-card ${result.type}`);
  const top = element("div", "card-top");
  const title = element("div", "card-title");
  title.append(element("strong", "", result.title), element("small", "", result.type === "plan" ? "予定" : "履歴"));
  top.append(title, element("span", "type-badge", result.kind === "work" ? "作業" : "休憩"));
  card.append(top);
  const stateText = result.type === "plan"
    ? `${result.status} / ${result.scheduleType === "clock" ? `${result.startTime}〜${result.endTime}` : `${result.durationMinutes}分`}`
    : `${result.outcome} / 実績 ${durationLabel(result.actualMs)} / 記録 ${new Date(result.recordedAt).toLocaleString("ja-JP")}`;
  card.append(element("p", "card-meta", `${result.date} / ${stateText}`));
  if (result.note) card.append(element("p", "card-note search-note", noteExcerpt(result.note)));
  const button = element("button", "", "該当日を開く");
  button.type = "button";
  button.addEventListener("click", () => openResult(result));
  const actions = element("div", "card-actions");
  actions.append(button);
  card.append(actions);
  return card;
}

export function createSearchViewController({ getSnapshot, onOpenPlan, onOpenHistory, onError }) {
  const form = document.querySelector("#search-form");
  const input = document.querySelector("#search-query");
  const submit = document.querySelector("#search-submit-button");
  const clear = document.querySelector("#search-clear-button");
  const status = document.querySelector("#search-status");
  const summary = document.querySelector("#search-summary");
  const planList = document.querySelector("#search-plan-results");
  const historyList = document.querySelector("#search-history-results");
  let busy = false;
  let lastQuery = "";

  function setBusy(value) {
    busy = value;
    submit.disabled = value;
    clear.disabled = value;
    input.disabled = value;
    submit.textContent = value ? "検索中…" : "検索";
  }

  function render(result) {
    planList.replaceChildren();
    historyList.replaceChildren();
    summary.textContent = result.limited
      ? `${result.totalCount}件中、先頭${result.shownCount}件を表示しています。予定${result.planCount}件、履歴${result.historyCount}件。`
      : `${result.totalCount}件（予定${result.planCount}件、履歴${result.historyCount}件）`;
    status.textContent = result.totalCount ? "検索が完了しました。" : "一致する予定・履歴はありません。";
    for (const item of result.plans) planList.append(resultCard(item, onOpenPlan));
    for (const item of result.history) historyList.append(resultCard(item, onOpenHistory));
    if (!result.plans.length) planList.append(element("p", "empty-state", "一致する予定はありません。"));
    if (!result.history.length) historyList.append(element("p", "empty-state", "一致する履歴はありません。"));
  }

  async function run(query = input.value) {
    if (busy) return false;
    const trimmed = String(query ?? "").trim();
    if (!trimmed) {
      status.textContent = "検索語を入力してください。";
      summary.textContent = "";
      planList.replaceChildren();
      historyList.replaceChildren();
      input.focus();
      return false;
    }
    setBusy(true);
    status.textContent = "全期間の予定と履歴を読み込んでいます…";
    try {
      const snapshot = await getSnapshot();
      lastQuery = trimmed;
      render(searchRecords(snapshot.plans, snapshot.history, trimmed));
      return true;
    } catch (error) {
      status.textContent = error?.message || "検索に失敗しました。";
      onError(error, "検索データを読み込めませんでした。");
      return false;
    } finally {
      setBusy(false);
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void run();
  });
  clear.addEventListener("click", () => {
    if (busy) return;
    input.value = "";
    lastQuery = "";
    summary.textContent = "";
    status.textContent = "検索語を入力し、検索ボタンを押してください。";
    planList.replaceChildren();
    historyList.replaceChildren();
    input.focus();
  });

  return {
    focus: () => input.focus(),
    refresh: () => lastQuery ? run(lastQuery) : Promise.resolve(false),
    hasResults: () => Boolean(lastQuery)
  };
}
