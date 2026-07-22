export const REORDER_LONG_PRESS_MS = 400;
export const REORDER_CANCEL_DISTANCE_PX = 10;

const ACTIVE_TIMER_STATES = new Set(["running", "paused", "expired"]);

function assertPlanList(plans) {
  if (!Array.isArray(plans)) throw new Error("並べ替え対象が不正です。");
  const ids = plans.map((plan) => plan?.id);
  if (ids.some((id) => typeof id !== "string" || !id)) throw new Error("予定IDが不正です。");
  if (new Set(ids).size !== ids.length) throw new Error("並べ替え対象に重複IDがあります。");
  if (plans.some((plan) => plan.status !== "pending" || plan.scheduleType !== "duration")) {
    throw new Error("時間指定の未完了予定だけ並べ替えできます。");
  }
}

export function isReorderTimerBlocked(timerStatus) {
  return ACTIVE_TIMER_STATES.has(timerStatus);
}

export function canReorderPlan(plan, {
  selectedDate,
  todayDate,
  timerStatus = "idle"
} = {}) {
  return Boolean(
    plan
    && plan.status === "pending"
    && plan.scheduleType === "duration"
    && typeof selectedDate === "string"
    && selectedDate === plan.date
    && typeof todayDate === "string"
    && selectedDate >= todayDate
    && !isReorderTimerBlocked(timerStatus)
  );
}

export function planReorderRevision(plan) {
  if (!plan || typeof plan !== "object") throw new Error("予定が不正です。");
  return JSON.stringify([
    plan.schemaVersion,
    plan.id,
    plan.date,
    plan.title,
    plan.note,
    plan.kind,
    plan.scheduleType,
    plan.durationMinutes,
    plan.startTime,
    plan.endTime,
    plan.status,
    plan.order,
    plan.createdAt,
    plan.actualMs,
    Object.hasOwn(plan, "completedAt") ? plan.completedAt : null,
    plan.updatedAt
  ]);
}

export function reorderPlansById(plans, movedId, targetIndex) {
  assertPlanList(plans);
  const sourceIndex = plans.findIndex((plan) => plan.id === movedId);
  if (sourceIndex < 0) throw new Error("移動する予定が見つかりません。");
  if (!Number.isSafeInteger(targetIndex) || targetIndex < 0 || targetIndex >= plans.length) {
    throw new Error("移動先が不正です。");
  }
  const result = plans.map((plan) => ({ ...plan }));
  if (sourceIndex === targetIndex) return result;
  const [moved] = result.splice(sourceIndex, 1);
  result.splice(targetIndex, 0, moved);
  return result;
}

export function buildDurationOrderChanges(plans, orderedPlanIds, now = Date.now()) {
  assertPlanList(plans);
  if (!Array.isArray(orderedPlanIds) || orderedPlanIds.length !== plans.length) {
    throw new Error("並べ替え対象の件数が一致しません。");
  }
  if (new Set(orderedPlanIds).size !== orderedPlanIds.length) throw new Error("並べ替え順に重複IDがあります。");
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("更新日時が不正です。");
  const byId = new Map(plans.map((plan) => [plan.id, plan]));
  if (orderedPlanIds.some((id) => !byId.has(id))) throw new Error("並べ替え対象の予定集合が一致しません。");

  const orderedPlans = orderedPlanIds.map((id, index) => {
    const original = byId.get(id);
    const order = index + 1;
    return original.order === order ? { ...original } : { ...original, order, updatedAt: now };
  });
  return {
    orderedPlans,
    changedPlans: orderedPlans.filter((plan) => plan.order !== byId.get(plan.id).order),
    expectedPlanRevisions: Object.fromEntries(plans.map((plan) => [plan.id, planReorderRevision(plan)]))
  };
}
