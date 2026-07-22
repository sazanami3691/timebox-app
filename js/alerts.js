import {
  dueScheduleNotifications,
  normalizeNotificationLedger
} from "./settings.js";

export function createEndSoundController({
  playChime,
  setTimer = globalThis.setTimeout?.bind(globalThis),
  clearTimer = globalThis.clearTimeout?.bind(globalThis)
}) {
  const handledKeys = new Set();
  let timers = [];

  function stop() {
    for (const timer of timers) clearTimer?.(timer);
    timers = [];
  }

  function start(key, volume) {
    if (!key || handledKeys.has(key)) return false;
    handledKeys.add(key);
    stop();
    timers = [0, 700, 1400].map((delay) => setTimer?.(() => {
      Promise.resolve(playChime(volume)).catch(() => {});
    }, delay));
    return true;
  }

  return Object.freeze({ start, stop });
}

function createWebAudioChime(environment, onReadyChange) {
  const AudioContextClass = environment.AudioContext ?? environment.webkitAudioContext;
  const activeOscillators = new Set();
  let context = null;

  async function ensureContext() {
    if (!AudioContextClass) throw new Error("このブラウザではWeb Audio APIを利用できません。");
    if (!context) context = new AudioContextClass();
    if (context.state === "suspended") await context.resume();
    onReadyChange(context.state === "running");
    return context;
  }

  async function play(volume) {
    const audioContext = await ensureContext();
    const startAt = audioContext.currentTime;
    const gain = audioContext.createGain();
    const oscillator = audioContext.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(660, startAt);
    oscillator.frequency.setValueAtTime(880, startAt + 0.16);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), startAt + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.38);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.addEventListener("ended", () => activeOscillators.delete(oscillator), { once: true });
    activeOscillators.add(oscillator);
    oscillator.start(startAt);
    oscillator.stop(startAt + 0.4);
  }

  async function unlock() {
    await ensureContext();
  }

  function stop() {
    for (const oscillator of activeOscillators) {
      try { oscillator.stop(); } catch {}
    }
    activeOscillators.clear();
  }

  return Object.freeze({ play, stop, unlock, supported: Boolean(AudioContextClass) });
}

export function timerExpirationKey(timer) {
  return `timer:${timer?.planId ?? "unknown"}:${timer?.actualStartedAt ?? "unknown"}:${timer?.expiredAt ?? timer?.endAt ?? "unknown"}`;
}

export function createAlertManager({
  environment = globalThis,
  getSettings,
  loadLedger = async () => null,
  saveLedger = async () => {}
}) {
  const listeners = new Set();
  const NotificationClass = environment.Notification;
  let ledger = normalizeNotificationLedger(null);
  let ledgerKeys = new Set();
  let audioReady = false;
  let notificationMessage = "通知機能を準備しています。";
  let audioMessage = "「音をテスト」を押して、音声を利用できる状態にしてください。";
  let testSequence = 0;

  const audio = createWebAudioChime(environment, (ready) => {
    audioReady = ready;
    if (ready) audioMessage = "音声を利用できる状態です。";
    emit();
  });
  const sound = createEndSoundController({
    playChime: (volume) => audio.play(volume),
    setTimer: environment.setTimeout?.bind(environment) ?? globalThis.setTimeout?.bind(globalThis),
    clearTimer: environment.clearTimeout?.bind(environment) ?? globalThis.clearTimeout?.bind(globalThis)
  });

  function notificationPermission() {
    return NotificationClass?.permission ?? "unavailable";
  }

  function getState() {
    return Object.freeze({
      audioSupported: audio.supported,
      audioReady,
      notificationSupported: Boolean(NotificationClass),
      notificationPermission: notificationPermission(),
      notificationMessage,
      audioMessage
    });
  }

  function emit() {
    const snapshot = getState();
    for (const listener of listeners) listener(snapshot);
  }

  function setNotificationMessage(nextMessage) {
    notificationMessage = nextMessage;
    emit();
  }

  function setAudioMessage(nextMessage) {
    audioMessage = nextMessage;
    emit();
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener(getState());
    return () => listeners.delete(listener);
  }

  async function persistLedger() {
    ledger = normalizeNotificationLedger(ledger);
    ledgerKeys = new Set(ledger.entries.map((entry) => entry.key));
    try {
      await saveLedger(ledger);
    } catch (error) {
      console.warn("Notification ledger save failed", error);
      setNotificationMessage("通知済み情報を保存できませんでした。この画面を開いている間は重複を防止します。");
    }
  }

  function recordDelivered(key, deliveredAt = Date.now()) {
    if (ledgerKeys.has(key)) return false;
    ledger.entries.unshift({ key, deliveredAt });
    ledgerKeys.add(key);
    return true;
  }

  async function showNotification(title, options) {
    if (!NotificationClass || notificationPermission() !== "granted") return false;
    try {
      const registration = await environment.navigator?.serviceWorker?.getRegistration?.();
      if (registration?.showNotification) await registration.showNotification(title, options);
      else new NotificationClass(title, options);
      return true;
    } catch (error) {
      console.warn("Notification display failed", error);
      setNotificationMessage("通知を表示できませんでした。画面上の案内は引き続き利用できます。");
      return false;
    }
  }

  async function start() {
    ledger = normalizeNotificationLedger(await loadLedger());
    ledgerKeys = new Set(ledger.entries.map((entry) => entry.key));
    const permission = notificationPermission();
    setNotificationMessage(!NotificationClass
      ? "この環境では通知を利用できません。終了画面と終了音は引き続き利用できます。"
      : permission === "denied"
        ? "通知は拒否されています。iPadまたはブラウザの設定で許可状態を確認してください。"
        : permission === "granted"
          ? "通知は許可済みです。テスト通知で端末側の表示を確認できます。"
          : "通知権限は「通知を有効にする」ボタンから設定できます。");
    return getState();
  }

  async function requestNotificationPermission() {
    if (!NotificationClass) {
      setNotificationMessage("このブラウザまたは起動方法では通知を利用できません。");
      return "unavailable";
    }
    if (notificationPermission() === "denied") {
      setNotificationMessage("通知は拒否されています。iPadまたはブラウザの設定で許可状態を確認してください。");
      return "denied";
    }
    try {
      const permission = notificationPermission() === "granted"
        ? "granted"
        : await NotificationClass.requestPermission();
      setNotificationMessage(permission === "granted"
        ? "通知が有効になりました。ホーム画面版とiPad側の通知設定も確認してください。"
        : permission === "denied"
          ? "通知は許可されませんでした。再要求せず、端末側の設定変更を待ちます。"
          : "通知の許可はまだ選択されていません。");
      return permission;
    } catch (error) {
      console.warn("Notification permission request failed", error);
      setNotificationMessage("通知権限を確認できませんでした。起動方法と端末設定を確認してください。");
      return notificationPermission();
    }
  }

  async function testNotification() {
    if (notificationPermission() !== "granted") {
      setNotificationMessage("通知テストには先に通知の許可が必要です。");
      return false;
    }
    const shown = await showNotification("Timebox通知テスト", {
      body: "通知は利用可能です。",
      icon: new URL("../icons/icon-192.png", import.meta.url).href,
      tag: `timebox-test-${Date.now()}`
    });
    if (shown) setNotificationMessage("テスト通知を送信しました。表示されない場合はiPad側の通知設定を確認してください。");
    return shown;
  }

  async function testSound() {
    if (!audio.supported) {
      setAudioMessage("このブラウザでは終了音を利用できません。");
      return false;
    }
    try {
      await audio.unlock();
      sound.start(`test:${Date.now()}:${testSequence += 1}`, getSettings().soundVolume);
      setAudioMessage("終了音を3回テスト再生しています。停止する場合は終了音をオフにしてください。");
      return true;
    } catch (error) {
      console.warn("Audio test failed", error);
      setAudioMessage("音声を開始できませんでした。消音設定と端末の音量を確認してください。");
      return false;
    }
  }

  function stopEndSound() {
    sound.stop();
    audio.stop();
  }

  async function handleTimerExpired(timer) {
    const key = timerExpirationKey(timer);
    if (!recordDelivered(key)) return false;
    await persistLedger();
    const settings = getSettings();
    if (settings.soundEnabled) sound.start(key, settings.soundVolume);
    await showNotification("Timebox終了", {
      body: `「${timer.title}」が終了しました。`,
      icon: new URL("../icons/icon-192.png", import.meta.url).href,
      tag: key,
      renotify: false
    });
    if (settings.soundEnabled) setAudioMessage("タイムボックス終了音を再生しました。");
    if (notificationPermission() === "granted") setNotificationMessage("タイムボックス終了通知を送信しました。");
    return true;
  }

  async function checkScheduleNotifications(plans, previousCheckMs, nowMs) {
    if (notificationPermission() !== "granted") return 0;
    const due = dueScheduleNotifications(
      plans,
      getSettings().scheduleNotification,
      previousCheckMs,
      nowMs,
      ledgerKeys
    );
    let delivered = 0;
    for (const event of due) {
      const body = event.offsetMinutes > 0
        ? `「${event.title}」は${event.offsetMinutes}分後に開始予定です。`
        : `「${event.title}」の開始時刻です。`;
      if (await showNotification("Timebox予定", {
        body,
        icon: new URL("../icons/icon-192.png", import.meta.url).href,
        tag: event.key,
        renotify: false
      })) {
        recordDelivered(event.key, nowMs);
        delivered += 1;
      }
    }
    if (delivered) await persistLedger();
    return delivered;
  }

  function notifySettingsChanged() {
    if (!getSettings().soundEnabled) {
      stopEndSound();
      setAudioMessage("終了音はオフです。");
    } else {
      setAudioMessage(audioReady
        ? "音声を利用できる状態です。"
        : "「音をテスト」を押して、音声を利用できる状態にしてください。");
    }
  }

  return Object.freeze({
    checkScheduleNotifications,
    getState,
    handleTimerExpired,
    notifySettingsChanged,
    requestNotificationPermission,
    start,
    stopEndSound,
    subscribe,
    testNotification,
    testSound
  });
}
