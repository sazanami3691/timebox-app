import { SCHEMA_VERSION } from "./core.js";
import {
  assertHistoryPlanTransactionSafe,
  buildEditedHistory,
  chooseLatestHistory,
  historyRevisionKey,
  planAfterHistoryDeletion,
  syncPlanFromHistory
} from "./history-edit.js";

const DB_NAME = "timebox-app";
const DB_VERSION = 1;
const STORES = Object.freeze({
  plans: "plans",
  history: "history",
  timer: "currentTimer",
  meta: "meta"
});

let databasePromise;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB操作に失敗しました。")), { once: true });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("保存処理が中止されました。")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("保存処理に失敗しました。")), { once: true });
  });
}

export function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (!("indexedDB" in globalThis)) {
      reject(new Error("このブラウザではIndexedDBを利用できません。"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORES.plans)) {
        const plans = db.createObjectStore(STORES.plans, { keyPath: "id" });
        plans.createIndex("date", "date", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.history)) {
        const history = db.createObjectStore(STORES.history, { keyPath: "id" });
        history.createIndex("date", "date", { unique: false });
        history.createIndex("planId", "planId", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.timer)) {
        db.createObjectStore(STORES.timer, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(STORES.meta)) {
        db.createObjectStore(STORES.meta, { keyPath: "key" });
      }
    });
    request.addEventListener("success", () => {
      const db = request.result;
      db.addEventListener("versionchange", () => db.close());
      resolve(db);
    }, { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("データベースを開けませんでした。")), { once: true });
    request.addEventListener("blocked", () => reject(new Error("別のタブがデータベースを使用中です。ほかのタブを閉じて再読み込みしてください。")), { once: true });
  });
  return databasePromise;
}

export async function initializeDatabase() {
  const db = await openDatabase();
  const tx = db.transaction(STORES.meta, "readwrite");
  tx.objectStore(STORES.meta).put({
    key: "schema",
    schemaVersion: SCHEMA_VERSION,
    databaseVersion: DB_VERSION,
    updatedAt: Date.now()
  });
  await transactionDone(tx);
}

export async function getPlansByDate(date) {
  const db = await openDatabase();
  const tx = db.transaction(STORES.plans, "readonly");
  const done = transactionDone(tx);
  const result = await requestResult(tx.objectStore(STORES.plans).index("date").getAll(date));
  await done;
  return result.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

export async function getHistoryByDate(date) {
  const db = await openDatabase();
  const tx = db.transaction(STORES.history, "readonly");
  const done = transactionDone(tx);
  const result = await requestResult(tx.objectStore(STORES.history).index("date").getAll(date));
  await done;
  return result.sort((a, b) => b.recordedAt - a.recordedAt);
}

export async function getSearchSnapshot() {
  const db = await openDatabase();
  const tx = db.transaction([STORES.plans, STORES.history], "readonly");
  const done = transactionDone(tx);
  const plansRequest = tx.objectStore(STORES.plans).getAll();
  const historyRequest = tx.objectStore(STORES.history).getAll();
  const [plans, history] = await Promise.all([requestResult(plansRequest), requestResult(historyRequest)]);
  await done;
  return { plans, history };
}

export async function getHistoryEntryById(id) {
  const db = await openDatabase();
  const tx = db.transaction(STORES.history, "readonly");
  const done = transactionDone(tx);
  const result = await requestResult(tx.objectStore(STORES.history).get(id));
  await done;
  return result ?? null;
}

export async function getPlanById(id) {
  const db = await openDatabase();
  const tx = db.transaction(STORES.plans, "readonly");
  const done = transactionDone(tx);
  const result = await requestResult(tx.objectStore(STORES.plans).get(id));
  await done;
  return result ?? null;
}

export async function getCurrentTimer() {
  const db = await openDatabase();
  const tx = db.transaction(STORES.timer, "readonly");
  const done = transactionDone(tx);
  const result = await requestResult(tx.objectStore(STORES.timer).get("active"));
  await done;
  return result ?? null;
}

export async function getMetaValue(key) {
  const db = await openDatabase();
  const tx = db.transaction(STORES.meta, "readonly");
  const done = transactionDone(tx);
  const result = await requestResult(tx.objectStore(STORES.meta).get(key));
  await done;
  return result?.value ?? null;
}

export async function getBackupSnapshot(settingsKey) {
  const db = await openDatabase();
  const tx = db.transaction([STORES.plans, STORES.history, STORES.meta], "readonly");
  const done = transactionDone(tx);
  const plansRequest = tx.objectStore(STORES.plans).getAll();
  const historyRequest = tx.objectStore(STORES.history).getAll();
  const settingsRequest = tx.objectStore(STORES.meta).get(settingsKey);
  const [plans, history, settingsRecord] = await Promise.all([
    requestResult(plansRequest),
    requestResult(historyRequest),
    requestResult(settingsRequest)
  ]);
  await done;
  return { plans, history, settings: settingsRecord?.value ?? null };
}

export async function saveMetaValue(key, value) {
  const db = await openDatabase();
  const tx = db.transaction(STORES.meta, "readwrite");
  tx.objectStore(STORES.meta).put({ key, value, updatedAt: Date.now() });
  await transactionDone(tx);
}

export async function savePlan(plan) {
  const db = await openDatabase();
  const tx = db.transaction(STORES.plans, "readwrite");
  tx.objectStore(STORES.plans).put(plan);
  await transactionDone(tx);
}

export async function deletePlan(id) {
  const db = await openDatabase();
  const tx = db.transaction(STORES.plans, "readwrite");
  tx.objectStore(STORES.plans).delete(id);
  await transactionDone(tx);
}

export async function saveCurrentTimer(timer) {
  const db = await openDatabase();
  const tx = db.transaction(STORES.timer, "readwrite");
  tx.objectStore(STORES.timer).put(timer);
  await transactionDone(tx);
}

export async function startCurrentTimer(timer) {
  const db = await openDatabase();
  const tx = db.transaction(STORES.timer, "readwrite");
  const store = tx.objectStore(STORES.timer);
  let conflict = false;
  const request = store.get("active");
  request.addEventListener("success", () => {
    if (request.result) {
      conflict = true;
      tx.abort();
      return;
    }
    store.add(timer);
  }, { once: true });
  try {
    await transactionDone(tx);
  } catch (error) {
    if (conflict) throw new Error("別のタイマーが動作中です。現在のタイマーを確認してください。");
    throw error;
  }
}

export async function savePlanAndTimer(plan, timer) {
  const db = await openDatabase();
  const tx = db.transaction([STORES.plans, STORES.timer], "readwrite");
  tx.objectStore(STORES.plans).put(plan);
  tx.objectStore(STORES.timer).put(timer);
  await transactionDone(tx);
}

export async function commitOutcome(plan, historyEntry) {
  const db = await openDatabase();
  const tx = db.transaction([STORES.plans, STORES.history, STORES.timer], "readwrite");
  tx.objectStore(STORES.plans).put(plan);
  tx.objectStore(STORES.history).add(historyEntry);
  tx.objectStore(STORES.timer).delete("active");
  await transactionDone(tx);
}

export async function commitManualCompletion(plan, historyEntry) {
  const db = await openDatabase();
  const tx = db.transaction([STORES.plans, STORES.history], "readwrite");
  tx.objectStore(STORES.plans).put(plan);
  tx.objectStore(STORES.history).add(historyEntry);
  await transactionDone(tx);
}

async function historyMutationContext(historyId, expectedRevision, mutate) {
  const hint = await getHistoryEntryById(historyId);
  if (!hint) throw new Error("対象の履歴は既に削除されています。画面を更新してください。");
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORES.history, STORES.plans, STORES.timer], "readwrite");
    const historyStore = tx.objectStore(STORES.history);
    const planStore = tx.objectStore(STORES.plans);
    const requests = {
      current: historyStore.get(historyId),
      related: historyStore.index("planId").getAll(hint.planId),
      plan: planStore.get(hint.planId),
      timer: tx.objectStore(STORES.timer).get("active")
    };
    const values = {};
    let pending = Object.keys(requests).length;
    let result;
    let controlledError = null;

    const finishReads = () => {
      if (--pending > 0 || controlledError) return;
      try {
        if (!values.current) throw new Error("対象の履歴は既に削除されています。画面を更新してください。");
        if (values.current.planId !== hint.planId) throw new Error("対象の履歴が別の操作で変更されました。画面を更新してください。");
        if (expectedRevision && historyRevisionKey(values.current) !== expectedRevision) {
          throw new Error("対象の履歴が別の操作で変更されました。画面を更新してやり直してください。");
        }
        result = mutate({
          current: values.current,
          related: values.related,
          plan: values.plan ?? null,
          timer: values.timer ?? null,
          historyStore,
          planStore
        });
      } catch (error) {
        controlledError = error;
        tx.abort();
      }
    };

    for (const [key, request] of Object.entries(requests)) {
      request.addEventListener("success", () => {
        values[key] = request.result;
        finishReads();
      }, { once: true });
      request.addEventListener("error", () => {
        controlledError = request.error ?? new Error("履歴の最新状態を読み込めませんでした。");
      }, { once: true });
    }
    tx.addEventListener("complete", () => resolve(result), { once: true });
    tx.addEventListener("abort", () => reject(controlledError ?? tx.error ?? new Error("履歴の更新を中止しました。")), { once: true });
    tx.addEventListener("error", () => {
      if (!controlledError) controlledError = tx.error ?? new Error("履歴の更新に失敗しました。");
    }, { once: true });
  });
}

export async function updateHistoryAndRelatedPlan({ historyId, expectedRevision, changes, now = Date.now() }) {
  return historyMutationContext(historyId, expectedRevision, ({ current, related, plan, timer, historyStore, planStore }) => {
    const edited = buildEditedHistory(current, changes);
    const proposedHistory = related.map((entry) => entry.id === current.id ? edited : entry);
    assertHistoryPlanTransactionSafe(plan, proposedHistory, timer);
    let updatedPlan = null;
    if (plan) {
      const latest = chooseLatestHistory(proposedHistory);
      updatedPlan = syncPlanFromHistory(plan, latest, now);
      planStore.put(updatedPlan);
    }
    historyStore.put(edited);
    return { history: edited, plan: updatedPlan };
  });
}

export async function deleteHistoryAndReconcilePlan({ historyId, expectedRevision, now = Date.now() }) {
  return historyMutationContext(historyId, expectedRevision, ({ current, related, plan, timer, historyStore, planStore }) => {
    assertHistoryPlanTransactionSafe(plan, related, timer);
    const remaining = related.filter((entry) => entry.id !== current.id);
    let updatedPlan = null;
    if (plan) {
      updatedPlan = planAfterHistoryDeletion(plan, remaining, now);
      planStore.put(updatedPlan);
    }
    historyStore.delete(current.id);
    return { deletedHistory: current, plan: updatedPlan };
  });
}

export async function putPlansAtomically(plans) {
  const db = await openDatabase();
  const tx = db.transaction(STORES.plans, "readwrite");
  const store = tx.objectStore(STORES.plans);
  for (const plan of plans) store.add(plan);
  await transactionDone(tx);
}

export async function replaceAllFromBackup({
  plans,
  history,
  settings,
  settingsKey,
  notificationLedgerKey
}) {
  const db = await openDatabase();
  const tx = db.transaction(
    [STORES.plans, STORES.history, STORES.timer, STORES.meta],
    "readwrite"
  );
  const done = transactionDone(tx);
  const planStore = tx.objectStore(STORES.plans);
  const historyStore = tx.objectStore(STORES.history);
  const timerStore = tx.objectStore(STORES.timer);
  const metaStore = tx.objectStore(STORES.meta);
  let timerConflict = false;

  const timerRequest = timerStore.get("active");
  timerRequest.addEventListener("success", () => {
    if (timerRequest.result) {
      timerConflict = true;
      tx.abort();
      return;
    }

    planStore.clear();
    historyStore.clear();
    timerStore.clear();
    for (const plan of plans) planStore.add(plan);
    for (const entry of history) historyStore.add(entry);
    metaStore.put({
      key: "schema",
      schemaVersion: SCHEMA_VERSION,
      databaseVersion: DB_VERSION,
      updatedAt: Date.now()
    });
    metaStore.put({ key: settingsKey, value: settings, updatedAt: Date.now() });
    metaStore.delete(notificationLedgerKey);
  }, { once: true });

  try {
    await done;
  } catch (error) {
    if (timerConflict) {
      throw new Error("実行中・一時停止中・終了待ちのタイマーがあるため、バックアップを読み込めません。先にタイマーを完了またはスキップしてください。");
    }
    throw error;
  }
}

export const databaseInfo = Object.freeze({
  name: DB_NAME,
  version: DB_VERSION,
  schemaVersion: SCHEMA_VERSION,
  stores: { ...STORES }
});
