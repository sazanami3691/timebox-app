const BLOCKING_TIMER_STATES = new Set(["running", "paused", "expired"]);

export function isUpdateBlocked(timerStatus) {
  return BLOCKING_TIMER_STATES.has(timerStatus);
}

export function createOneTimeReload(reloadPage = () => globalThis.location?.reload()) {
  let reloaded = false;
  return () => {
    if (reloaded) return false;
    reloaded = true;
    reloadPage();
    return true;
  };
}

export function createPwaManager({ getTimerStatus = () => "idle", environment = globalThis } = {}) {
  const listeners = new Set();
  const navigatorRef = environment.navigator;
  const serviceWorker = navigatorRef?.serviceWorker;
  const reloadOnce = createOneTimeReload(() => environment.location?.reload());
  let registration = null;
  let waitingWorker = null;
  let networkEventsBound = false;
  let applyingUpdate = false;
  let state = {
    supported: Boolean(serviceWorker),
    registered: false,
    offlineReady: false,
    online: navigatorRef?.onLine !== false,
    checking: false,
    updateAvailable: false,
    message: "PWA機能を準備しています。"
  };

  function getState() {
    const timerStatus = getTimerStatus() ?? "idle";
    return Object.freeze({
      ...state,
      appVersion: globalThis.TIMEBOX_APP_VERSION ?? "不明",
      timerStatus,
      updateBlocked: isUpdateBlocked(timerStatus)
    });
  }

  function emit() {
    const snapshot = getState();
    for (const listener of listeners) listener(snapshot);
  }

  function updateState(patch) {
    state = { ...state, ...patch };
    emit();
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener(getState());
    return () => listeners.delete(listener);
  }

  function updateNetworkState(online) {
    updateState({
      online,
      message: online
        ? "オンライン表示です。通信できる場合は更新確認を利用できます。"
        : "オフラインです。保存済み予定は利用できますが、更新確認には通信が必要です。"
    });
  }

  function bindNetworkEvents() {
    if (networkEventsBound || !environment.addEventListener) return;
    networkEventsBound = true;
    environment.addEventListener("online", () => updateNetworkState(true));
    environment.addEventListener("offline", () => updateNetworkState(false));
  }

  function setWaitingWorker(worker) {
    if (!worker) return;
    waitingWorker = worker;
    updateState({
      updateAvailable: true,
      message: isUpdateBlocked(getTimerStatus())
        ? "新しいバージョンがあります。タイマー終了後に更新できます。"
        : "新しいバージョンがあります。準備ができたら更新してください。"
    });
  }

  function watchInstallingWorker(worker) {
    if (!worker?.addEventListener) return;
    worker.addEventListener("statechange", () => {
      if (worker.state !== "installed") return;
      if (serviceWorker.controller) setWaitingWorker(registration?.waiting ?? worker);
      else updateState({ offlineReady: true, message: "オフライン起動の準備ができました。" });
    });
  }

  function watchRegistration(currentRegistration) {
    if (currentRegistration.waiting && serviceWorker.controller) setWaitingWorker(currentRegistration.waiting);
    if (currentRegistration.installing) watchInstallingWorker(currentRegistration.installing);
    currentRegistration.addEventListener?.("updatefound", () => {
      if (currentRegistration.installing) watchInstallingWorker(currentRegistration.installing);
    });
  }

  async function start() {
    bindNetworkEvents();
    if (!serviceWorker) {
      updateState({ supported: false, message: "このブラウザではService Workerを利用できません。" });
      return getState();
    }
    try {
      registration = await serviceWorker.register(new URL("../sw.js", import.meta.url), { updateViaCache: "none" });
      updateState({ registered: true, message: "Service Workerを登録しました。オフライン準備を確認しています。" });
      watchRegistration(registration);
      serviceWorker.addEventListener("controllerchange", () => {
        updateState({ offlineReady: true });
        if (applyingUpdate) reloadOnce();
      });
      const readyRegistration = await serviceWorker.ready;
      updateState({
        offlineReady: Boolean(readyRegistration?.active),
        message: state.updateAvailable
          ? isUpdateBlocked(getTimerStatus())
            ? "新しいバージョンがあります。タイマー終了後に更新できます。"
            : "新しいバージョンがあります。更新を適用できます。"
          : readyRegistration?.active
            ? "オフライン起動の準備ができました。"
            : "オフライン起動を準備しています。"
      });
    } catch (error) {
      console.warn("Service Worker registration failed", error);
      const controlledOffline = Boolean(serviceWorker.controller);
      updateState({
        registered: controlledOffline,
        offlineReady: controlledOffline,
        message: controlledOffline
          ? "オフラインで起動しています。更新確認には通信が必要です。"
          : "Service Workerを登録できませんでした。オンラインで再読み込みしてください。"
      });
    }
    return getState();
  }

  async function checkForUpdate() {
    if (!state.online) {
      updateState({ message: "オフライン中は更新を確認できません。通信を確認してください。" });
      return false;
    }
    if (!registration) {
      updateState({ message: "Service Workerの準備前です。少し待ってから再試行してください。" });
      return false;
    }
    updateState({ checking: true, message: "新しいバージョンを確認しています…" });
    try {
      await registration.update();
      if (registration.waiting) setWaitingWorker(registration.waiting);
      else if (registration.installing) updateState({ message: "新しいバージョンを準備しています…" });
      else updateState({ message: "現在のバージョンが最新です。" });
      return Boolean(registration.waiting || registration.installing);
    } catch (error) {
      console.warn("Update check failed", error);
      updateState({ message: "更新確認に失敗しました。通信状態を確認してください。" });
      return false;
    } finally {
      updateState({ checking: false });
    }
  }

  function applyUpdate() {
    if (!waitingWorker) {
      updateState({ message: "適用待ちの更新はありません。" });
      return false;
    }
    if (isUpdateBlocked(getTimerStatus())) {
      updateState({ message: "タイマー終了後に更新できます。現在のタイマーを完了またはスキップしてください。" });
      return false;
    }
    applyingUpdate = true;
    updateState({ message: "更新を適用しています。完了後に1度だけ再読み込みします。" });
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
    return true;
  }

  function notifyTimerStateChanged() {
    if (state.updateAvailable) {
      updateState({
        message: isUpdateBlocked(getTimerStatus())
          ? "新しいバージョンがあります。タイマー終了後に更新できます。"
          : "新しいバージョンがあります。更新を適用できます。"
      });
    } else emit();
  }

  return Object.freeze({
    applyUpdate,
    checkForUpdate,
    getState,
    notifyTimerStateChanged,
    start,
    subscribe
  });
}
