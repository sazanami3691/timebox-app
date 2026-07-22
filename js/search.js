export const SEARCH_RESULT_LIMIT = 200;

export function normalizeSearchText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().normalize("NFKC").toLocaleLowerCase("ja-JP");
}

function includesQuery(record, query) {
  return normalizeSearchText(record?.title).includes(query)
    || normalizeSearchText(record?.note).includes(query);
}

function stableId(left, right) {
  return String(left.id).localeCompare(String(right.id));
}

function comparePlans(left, right) {
  return right.date.localeCompare(left.date)
    || Number(left.order) - Number(right.order)
    || stableId(left, right);
}

function compareHistory(left, right) {
  return right.date.localeCompare(left.date)
    || Number(right.recordedAt) - Number(left.recordedAt)
    || stableId(left, right);
}

function planResult(plan) {
  return {
    type: "plan",
    id: plan.id,
    date: plan.date,
    title: plan.title,
    note: plan.note ?? "",
    kind: plan.kind,
    status: plan.status,
    scheduleType: plan.scheduleType,
    durationMinutes: plan.durationMinutes ?? null,
    startTime: plan.startTime ?? null,
    endTime: plan.endTime ?? null,
    order: plan.order
  };
}

function historyResult(entry) {
  return {
    type: "history",
    id: entry.id,
    planId: entry.planId,
    date: entry.date,
    title: entry.title,
    note: entry.note ?? "",
    kind: entry.kind,
    outcome: entry.outcome,
    actualMs: entry.actualMs,
    recordedAt: entry.recordedAt
  };
}

export function searchRecords(plans, history, rawQuery, { limit = SEARCH_RESULT_LIMIT } = {}) {
  const query = normalizeSearchText(rawQuery);
  if (!query) {
    return { query, plans: [], history: [], planCount: 0, historyCount: 0, totalCount: 0, shownCount: 0, limited: false };
  }
  const matchedPlans = (Array.isArray(plans) ? plans : [])
    .filter((plan) => includesQuery(plan, query))
    .map(planResult)
    .sort(comparePlans);
  const matchedHistory = (Array.isArray(history) ? history : [])
    .filter((entry) => includesQuery(entry, query))
    .map(historyResult)
    .sort(compareHistory);
  const planCount = matchedPlans.length;
  const historyCount = matchedHistory.length;
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : SEARCH_RESULT_LIMIT;
  let remaining = safeLimit;
  const visiblePlans = matchedPlans.slice(0, remaining);
  remaining -= visiblePlans.length;
  const visibleHistory = matchedHistory.slice(0, remaining);
  const totalCount = planCount + historyCount;
  const shownCount = visiblePlans.length + visibleHistory.length;
  return {
    query,
    plans: visiblePlans,
    history: visibleHistory,
    planCount,
    historyCount,
    totalCount,
    shownCount,
    limited: shownCount < totalCount
  };
}

export function noteExcerpt(value, maxLength = 160) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}
