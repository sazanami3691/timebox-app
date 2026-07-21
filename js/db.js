import { SCHEMA_VERSION } from "./core.js";

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

export async function getCurrentTimer() {
  const db = await openDatabase();
  const tx = db.transaction(STORES.timer, "readonly");
  const done = transactionDone(tx);
  const result = await requestResult(tx.objectStore(STORES.timer).get("active"));
  await done;
  return result ?? null;
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

export async function putPlansAtomically(plans) {
  const db = await openDatabase();
  const tx = db.transaction(STORES.plans, "readwrite");
  const store = tx.objectStore(STORES.plans);
  for (const plan of plans) store.add(plan);
  await transactionDone(tx);
}

export const databaseInfo = Object.freeze({
  name: DB_NAME,
  version: DB_VERSION,
  schemaVersion: SCHEMA_VERSION,
  stores: { ...STORES }
});
