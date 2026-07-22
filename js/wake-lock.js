export function createWakeLockManager({
  environment = globalThis,
  getTimerStatus = () => "idle",
  getEnabled = () => false
} = {}) {
  const listeners = new Set();
  const navigatorRef = environment.navigator;
  const documentRef = environment.document;
  const supported = Boolean(navigatorRef?.wakeLock?.request);
  let sentinel = null;
  let requestPromise = null;
  let started = false;
  let releasingIntentionally = false;
  let message = supported
    ? "画面点灯維持はオフです。"
    : "このブラウザまたは起動方法ではScreen Wake Lock APIを利用できません。";

  function getState() {
    return Object.freeze({ supported, active: Boolean(sentinel && !sentinel.released), message });
  }

  function emit() {
    const snapshot = getState();
    for (const listener of listeners) listener(snapshot);
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener(getState());
    return () => listeners.delete(listener);
  }

  async function release(reason = "画面点灯維持を解除しました。") {
    const current = sentinel;
    sentinel = null;
    if (current && !current.released) {
      releasingIntentionally = true;
      try { await current.release(); } catch {}
      releasingIntentionally = false;
    }
    message = reason;
    emit();
  }

  async function sync() {
    if (!supported) {
      emit();
      return false;
    }
    const visible = documentRef?.visibilityState !== "hidden";
    const shouldHold = getEnabled() && getTimerStatus() === "running" && visible;
    if (!shouldHold) {
      const reason = !getEnabled()
        ? "画面点灯維持はオフです。"
        : getTimerStatus() !== "running"
          ? "実行中タイマーがないため画面点灯維持を解除しています。"
          : "画面が非表示のため画面点灯維持を解除しています。";
      await release(reason);
      return false;
    }
    if (sentinel && !sentinel.released) {
      message = "実行中タイマーの画面点灯を維持しています。";
      emit();
      return true;
    }
    if (requestPromise) return requestPromise;
    requestPromise = (async () => {
      try {
        sentinel = await navigatorRef.wakeLock.request("screen");
        const acquired = sentinel;
        acquired.addEventListener?.("release", () => {
          if (sentinel === acquired) sentinel = null;
          if (!releasingIntentionally) message = "OSまたはブラウザにより画面点灯維持が解除されました。画面復帰時に再取得します。";
          emit();
        }, { once: true });
        const stillNeeded = getEnabled() && getTimerStatus() === "running" && documentRef?.visibilityState !== "hidden";
        if (!stillNeeded) {
          await release("状態が変わったため画面点灯維持を解除しました。");
          return false;
        }
        message = "実行中タイマーの画面点灯を維持しています。";
        emit();
        return true;
      } catch (error) {
        sentinel = null;
        console.warn("Wake Lock request failed", error);
        message = "画面点灯維持を開始できませんでした。タイマーは終了予定時刻から正しく復帰します。";
        emit();
        return false;
      } finally {
        requestPromise = null;
      }
    })();
    return requestPromise;
  }

  function start() {
    if (started) return;
    started = true;
    documentRef?.addEventListener?.("visibilitychange", () => { void sync(); });
    void sync();
  }

  return Object.freeze({ getState, release, start, subscribe, sync });
}
