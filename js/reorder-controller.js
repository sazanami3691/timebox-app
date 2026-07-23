import {
  REORDER_CANCEL_DISTANCE_PX,
  REORDER_LONG_PRESS_MS
} from "./reorder.js";

const AUTO_SCROLL_EDGE_PX = 72;
const AUTO_SCROLL_MAX_PX = 8;

export function movedBeyondThreshold(startX, startY, currentX, currentY, threshold = REORDER_CANCEL_DISTANCE_PX) {
  return Math.hypot(currentX - startX, currentY - startY) >= threshold;
}

export function createReorderController({
  list,
  onDrop,
  onError = () => {},
  environment = globalThis,
  longPressMs = REORDER_LONG_PRESS_MS,
  cancelDistancePx = REORDER_CANCEL_DISTANCE_PX
}) {
  if (!list) throw new Error("並べ替えリストが見つかりません。");
  const setTimer = environment.setTimeout?.bind(environment) ?? globalThis.setTimeout;
  const clearTimer = environment.clearTimeout?.bind(environment) ?? globalThis.clearTimeout;
  const requestFrame = environment.requestAnimationFrame?.bind(environment) ?? ((callback) => setTimer(callback, 16));
  const cancelFrame = environment.cancelAnimationFrame?.bind(environment) ?? clearTimer;
  const windowRef = environment.window ?? environment;
  let pending = null;
  let dragging = null;
  let saving = false;
  let autoScrollFrame = null;
  let pointerY = 0;

  const cardNodes = () => [...list.querySelectorAll(".plan-card[data-plan-id]")];
  const orderIds = () => cardNodes().map((card) => card.dataset.planId);

  function stopAutoScroll() {
    if (autoScrollFrame !== null) cancelFrame(autoScrollFrame);
    autoScrollFrame = null;
  }

  function updateDropPosition(clientY) {
    if (!dragging) return;
    const cards = cardNodes().filter((card) => card !== dragging.card);
    const before = cards.find((card) => clientY < card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2);
    if (before) list.insertBefore(dragging.card, before);
    else list.append(dragging.card);
  }

  function autoScrollStep() {
    autoScrollFrame = null;
    if (!dragging) return;
    const viewportHeight = Number(windowRef.innerHeight) || document.documentElement.clientHeight;
    const fromTop = pointerY;
    const fromBottom = viewportHeight - pointerY;
    let delta = 0;
    if (fromTop < AUTO_SCROLL_EDGE_PX) delta = -AUTO_SCROLL_MAX_PX * (1 - Math.max(0, fromTop) / AUTO_SCROLL_EDGE_PX);
    else if (fromBottom < AUTO_SCROLL_EDGE_PX) delta = AUTO_SCROLL_MAX_PX * (1 - Math.max(0, fromBottom) / AUTO_SCROLL_EDGE_PX);
    if (delta) {
      windowRef.scrollBy?.(0, delta);
      updateDropPosition(pointerY);
      autoScrollFrame = requestFrame(autoScrollStep);
    }
  }

  function updateAutoScroll() {
    stopAutoScroll();
    autoScrollFrame = requestFrame(autoScrollStep);
  }

  function restoreOriginalOrder() {
    if (!dragging) return;
    const byId = new Map(cardNodes().map((card) => [card.dataset.planId, card]));
    for (const id of dragging.originalIds) {
      const card = byId.get(id);
      if (card) list.append(card);
    }
  }

  function clearVisualState({ restore = false } = {}) {
    stopAutoScroll();
    if (restore) restoreOriginalOrder();
    if (dragging) {
      dragging.card.classList.remove("is-dragging");
      dragging.card.removeAttribute("aria-grabbed");
      list.classList.remove("is-reordering");
      try {
        if (dragging.handle.hasPointerCapture?.(dragging.pointerId)) dragging.handle.releasePointerCapture(dragging.pointerId);
      } catch {}
    }
    dragging = null;
  }

  function cancelPending() {
    if (!pending) return;
    clearTimer(pending.timer);
    pending = null;
  }

  function beginDrag() {
    if (!pending || saving || pending.handle.disabled || pending.handle.getAttribute("aria-disabled") === "true") {
      cancelPending();
      return;
    }
    const card = pending.handle.closest(".plan-card[data-plan-id]");
    if (!card) {
      cancelPending();
      return;
    }
    dragging = {
      card,
      handle: pending.handle,
      pointerId: pending.pointerId,
      originalIds: orderIds()
    };
    pointerY = pending.startY;
    pending = null;
    card.classList.add("is-dragging");
    card.setAttribute("aria-grabbed", "true");
    list.classList.add("is-reordering");
    try { dragging.handle.setPointerCapture?.(dragging.pointerId); } catch {}
  }

  function pointerDown(event) {
    const handle = event.target.closest?.(".reorder-handle");
    if (!handle || !list.contains(handle) || saving || event.button !== 0 || !event.isPrimary) return;
    cancelPending();
    pending = {
      handle,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      timer: setTimer(beginDrag, longPressMs)
    };
  }

  function pointerMove(event) {
    if (pending && event.pointerId === pending.pointerId) {
      if (movedBeyondThreshold(pending.startX, pending.startY, event.clientX, event.clientY, cancelDistancePx)) cancelPending();
      return;
    }
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    event.preventDefault();
    pointerY = event.clientY;
    const rect = list.getBoundingClientRect();
    if (event.clientX >= rect.left - 48 && event.clientX <= rect.right + 48) updateDropPosition(event.clientY);
    updateAutoScroll();
  }

  async function pointerUp(event) {
    if (pending && event.pointerId === pending.pointerId) {
      cancelPending();
      return;
    }
    if (!dragging || event.pointerId !== dragging.pointerId) return;
    const currentIds = orderIds();
    const originalIds = dragging.originalIds;
    const rect = list.getBoundingClientRect();
    const inside = event.clientX >= rect.left - 48 && event.clientX <= rect.right + 48
      && event.clientY >= rect.top - 72 && event.clientY <= rect.bottom + 72;
    const changed = inside && currentIds.some((id, index) => id !== originalIds[index]);
    if (!changed) {
      clearVisualState({ restore: true });
      return;
    }
    saving = true;
    clearVisualState();
    try {
      await onDrop(currentIds, originalIds);
    } catch (error) {
      onError(error);
    } finally {
      saving = false;
    }
  }

  function pointerCancel(event) {
    if (pending && event.pointerId === pending.pointerId) cancelPending();
    if (dragging && event.pointerId === dragging.pointerId) clearVisualState({ restore: true });
  }

  function touchMove(event) {
    if (dragging) event.preventDefault();
  }

  list.addEventListener("pointerdown", pointerDown);
  list.addEventListener("pointermove", pointerMove, { passive: false });
  list.addEventListener("pointerup", pointerUp);
  list.addEventListener("pointercancel", pointerCancel);
  list.addEventListener("touchmove", touchMove, { passive: false });

  return Object.freeze({
    cancel() {
      cancelPending();
      clearVisualState({ restore: true });
    },
    destroy() {
      cancelPending();
      clearVisualState({ restore: true });
      list.removeEventListener("pointerdown", pointerDown);
      list.removeEventListener("pointermove", pointerMove);
      list.removeEventListener("pointerup", pointerUp);
      list.removeEventListener("pointercancel", pointerCancel);
      list.removeEventListener("touchmove", touchMove);
    },
    isDragging: () => Boolean(dragging),
    isSaving: () => saving
  });
}
