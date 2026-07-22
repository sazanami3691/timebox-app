import { MINUTE_MS, localDateTimeMs } from "./core.js";

export const SETTINGS_META_KEY = "phase2b-settings";
export const NOTIFICATION_LEDGER_META_KEY = "notification-ledger";
export const SCHEDULE_NOTIFICATION_MODES = Object.freeze(["none", "start", "5", "10", "15"]);
export const DEFAULT_SETTINGS = Object.freeze({
  soundEnabled: true,
  soundVolume: 0.25,
  scheduleNotification: "start",
  wakeLockEnabled: false
});

const LEDGER_MAX_AGE_MS = 14 * 24 * 60 * MINUTE_MS;
const LEDGER_MAX_ENTRIES = 500;

export function normalizeVolume(value, fallback = DEFAULT_SETTINGS.soundVolume) {
  if (value === "" || value === null || value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(Math.min(1, Math.max(0, number)) * 100) / 100;
}

export function normalizeSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return Object.freeze({
    soundEnabled: typeof source.soundEnabled === "boolean" ? source.soundEnabled : DEFAULT_SETTINGS.soundEnabled,
    soundVolume: normalizeVolume(source.soundVolume),
    scheduleNotification: SCHEDULE_NOTIFICATION_MODES.includes(source.scheduleNotification)
      ? source.scheduleNotification
      : DEFAULT_SETTINGS.scheduleNotification,
    wakeLockEnabled: typeof source.wakeLockEnabled === "boolean" ? source.wakeLockEnabled : DEFAULT_SETTINGS.wakeLockEnabled
  });
}

export function scheduleNotificationOffsets(mode) {
  if (mode === "none") return [];
  if (mode === "start") return [0];
  const minutes = Number(mode);
  return [minutes * MINUTE_MS, 0];
}

export function scheduleNotificationMoments(plan, mode) {
  if (!plan || plan.scheduleType !== "clock" || plan.status !== "pending") return [];
  const startMs = localDateTimeMs(plan.date, plan.startTime);
  return scheduleNotificationOffsets(mode).map((offsetMs) => ({
    key: `plan:${plan.id}:${startMs - offsetMs}:${offsetMs}`,
    planId: plan.id,
    title: plan.title,
    targetMs: startMs - offsetMs,
    offsetMinutes: offsetMs / MINUTE_MS
  }));
}

export function dueScheduleNotifications(plans, mode, previousCheckMs, nowMs, deliveredKeys = new Set()) {
  if (!Number.isFinite(nowMs) || mode === "none") return [];
  const safePrevious = Number.isFinite(previousCheckMs) ? previousCheckMs : nowMs;
  const windowStart = Math.max(safePrevious, nowMs - 2 * MINUTE_MS);
  return plans
    .flatMap((plan) => scheduleNotificationMoments(plan, mode))
    .filter((event) => event.targetMs > windowStart && event.targetMs <= nowMs && !deliveredKeys.has(event.key))
    .sort((a, b) => a.targetMs - b.targetMs);
}

export function normalizeNotificationLedger(value, nowMs = Date.now()) {
  const source = Array.isArray(value?.entries) ? value.entries : [];
  const cutoff = nowMs - LEDGER_MAX_AGE_MS;
  const entries = source
    .filter((entry) => typeof entry?.key === "string" && Number.isFinite(entry.deliveredAt) && entry.deliveredAt >= cutoff)
    .sort((a, b) => b.deliveredAt - a.deliveredAt)
    .slice(0, LEDGER_MAX_ENTRIES);
  return { entries };
}
