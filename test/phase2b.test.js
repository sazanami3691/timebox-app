import test from "node:test";
import assert from "node:assert/strict";
import { createAlertManager, createEndSoundController, timerExpirationKey } from "../js/alerts.js";
import { localDateTimeMs, MINUTE_MS } from "../js/core.js";
import {
  DEFAULT_SETTINGS,
  dueScheduleNotifications,
  normalizeSettings,
  normalizeVolume,
  scheduleNotificationMoments,
  scheduleNotificationOffsets
} from "../js/settings.js";
import { createWakeLockManager } from "../js/wake-lock.js";

const clockPlan = {
  id: "clock-1",
  date: "2026-07-22",
  title: "予定通知テスト",
  scheduleType: "clock",
  startTime: "10:00",
  status: "pending"
};

test("第2段階B設定は安全な初期値を持つ", () => {
  assert.deepEqual(normalizeSettings(), DEFAULT_SETTINGS);
  assert.equal(DEFAULT_SETTINGS.soundEnabled, true);
  assert.equal(DEFAULT_SETTINGS.soundVolume, 0.25);
  assert.equal(DEFAULT_SETTINGS.scheduleNotification, "start");
  assert.equal(DEFAULT_SETTINGS.wakeLockEnabled, false);
  assert.equal(normalizeSettings({ soundEnabled: false }).soundEnabled, false);
});

test("音量を検証し0から1へ制限する", () => {
  assert.equal(normalizeVolume(-1), 0);
  assert.equal(normalizeVolume(2), 1);
  assert.equal(normalizeVolume(0.333), 0.33);
  assert.equal(normalizeVolume(""), 0.25);
  assert.equal(normalizeVolume("invalid"), 0.25);
});

test("予定通知のなし・開始・5分前・10分前・15分前を計算する", () => {
  assert.deepEqual(scheduleNotificationOffsets("none"), []);
  assert.deepEqual(scheduleNotificationOffsets("start"), [0]);
  assert.deepEqual(scheduleNotificationOffsets("5"), [5 * MINUTE_MS, 0]);
  assert.deepEqual(scheduleNotificationOffsets("10"), [10 * MINUTE_MS, 0]);
  assert.deepEqual(scheduleNotificationOffsets("15"), [15 * MINUTE_MS, 0]);
  const startMs = localDateTimeMs(clockPlan.date, clockPlan.startTime);
  const moments = scheduleNotificationMoments(clockPlan, "5");
  assert.deepEqual(moments.map((item) => item.targetMs), [startMs - 5 * MINUTE_MS, startMs]);
});

test("完了・スキップ・時間指定予定は通知しない", () => {
  for (const plan of [
    { ...clockPlan, status: "completed" },
    { ...clockPlan, status: "skipped" },
    { ...clockPlan, scheduleType: "duration" }
  ]) assert.deepEqual(scheduleNotificationMoments(plan, "start"), []);
});

test("通知時刻直後だけを対象にし過去通知の大量発生と重複を防ぐ", () => {
  const startMs = localDateTimeMs(clockPlan.date, clockPlan.startTime);
  const due = dueScheduleNotifications([clockPlan], "start", startMs - 30_000, startMs + 1_000);
  assert.equal(due.length, 1);
  assert.equal(dueScheduleNotifications([clockPlan], "start", startMs - 30_000, startMs + 1_000, new Set([due[0].key])).length, 0);
  assert.equal(dueScheduleNotifications([clockPlan], "start", startMs - 60 * MINUTE_MS, startMs + 30 * MINUTE_MS).length, 0);
  assert.equal(dueScheduleNotifications([clockPlan], "none", startMs - 30_000, startMs + 1_000).length, 0);
});

test("1回の終了で音を一度だけ開始し停止操作で残りを取り消す", async () => {
  const scheduled = [];
  const cancelled = [];
  let chimes = 0;
  const controller = createEndSoundController({
    playChime: () => { chimes += 1; },
    setTimer: (callback, delay) => { const token = { callback, delay }; scheduled.push(token); return token; },
    clearTimer: (token) => cancelled.push(token)
  });
  assert.equal(controller.start("timer-a", 0.25), true);
  assert.equal(controller.start("timer-a", 0.25), false);
  assert.deepEqual(scheduled.map((item) => item.delay), [0, 700, 1400]);
  scheduled[0].callback();
  await Promise.resolve();
  assert.equal(chimes, 1);
  controller.stop();
  assert.equal(cancelled.length, 3);
  assert.equal(controller.start("timer-b", 0.25), true);
});

test("タイマー終了通知はgranted時だけ表示し同じ終了を重複通知しない", async () => {
  let notifications = 0;
  class FakeNotification {
    static permission = "granted";
    static requestPermission = async () => FakeNotification.permission;
    constructor() { notifications += 1; }
  }
  const savedLedgers = [];
  const environment = {
    Notification: FakeNotification,
    navigator: {},
    setTimeout: () => 1,
    clearTimeout() {}
  };
  const manager = createAlertManager({
    environment,
    getSettings: () => ({ ...DEFAULT_SETTINGS, soundEnabled: false }),
    loadLedger: async () => null,
    saveLedger: async (ledger) => savedLedgers.push(ledger)
  });
  await manager.start();
  const timer = { planId: "plan-1", title: "作業", actualStartedAt: 1000, expiredAt: 2000 };
  assert.match(timerExpirationKey(timer), /^timer:plan-1:/);
  assert.equal(await manager.handleTimerExpired(timer), true);
  assert.equal(await manager.handleTimerExpired(timer), false);
  assert.equal(notifications, 1);
  FakeNotification.permission = "default";
  assert.equal(await manager.handleTimerExpired({ ...timer, expiredAt: 3000 }), true);
  assert.equal(notifications, 1);
  assert.equal(savedLedgers.length, 2);
});

function createWakeEnvironment() {
  const documentListeners = {};
  const sentinels = [];
  const document = {
    visibilityState: "visible",
    addEventListener: (type, handler) => { documentListeners[type] = handler; }
  };
  const navigator = {
    wakeLock: {
      request: async () => {
        let releaseHandler = null;
        const sentinel = {
          released: false,
          addEventListener: (type, handler) => { if (type === "release") releaseHandler = handler; },
          release: async () => {
            sentinel.released = true;
            releaseHandler?.();
          }
        };
        sentinels.push(sentinel);
        return sentinel;
      }
    }
  };
  return { environment: { navigator, document }, document, documentListeners, sentinels };
}

test("Wake Lockはrunningで取得しpaused・expired・完了・スキップ相当で解除する", async () => {
  const fake = createWakeEnvironment();
  let status = "running";
  let enabled = true;
  const manager = createWakeLockManager({
    environment: fake.environment,
    getTimerStatus: () => status,
    getEnabled: () => enabled
  });
  assert.equal(await manager.sync(), true);
  assert.equal(manager.getState().active, true);
  status = "paused";
  assert.equal(await manager.sync(), false);
  assert.equal(manager.getState().active, false);
  status = "running";
  await manager.sync();
  status = "expired";
  await manager.sync();
  assert.equal(manager.getState().active, false);
  for (const terminal of ["idle", "completed", "skipped"]) {
    status = terminal;
    assert.equal(await manager.sync(), false);
  }
  enabled = false;
  status = "running";
  assert.equal(await manager.sync(), false);
});

test("Wake Lockは非表示で解除しvisibilitychange後にrunningなら再取得する", async () => {
  const fake = createWakeEnvironment();
  const manager = createWakeLockManager({
    environment: fake.environment,
    getTimerStatus: () => "running",
    getEnabled: () => true
  });
  manager.start();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(manager.getState().active, true);
  fake.document.visibilityState = "hidden";
  fake.documentListeners.visibilitychange();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(manager.getState().active, false);
  fake.document.visibilityState = "visible";
  fake.documentListeners.visibilitychange();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(manager.getState().active, true);
  assert.equal(fake.sentinels.length, 2);
});
