import type { CharStat } from "../training/stats";

/** 1 回の解答の記録 */
export interface Attempt {
  id?: number;
  ts: number;
  mode: "single";
  target: string;
  /** 入力した文字。時間切れなら null */
  answer: string | null;
  correct: boolean;
  /** 反応時間（ミリ秒）。時間切れなら null */
  rtMs: number | null;
  limitMs: number;
  cwpm: number;
  freq: number;
}

const DB_NAME = "morse_one";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const attempts = db.createObjectStore("attempts", { keyPath: "id", autoIncrement: true });
      attempts.createIndex("ts", "ts");
      db.createObjectStore("charStats", { keyPath: "char" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** ブラウザにデータを自動削除しないよう要求する */
export async function requestPersistence(): Promise<void> {
  try {
    await navigator.storage?.persist?.();
  } catch {
    // 非対応なら何もしない
  }
}

export async function loadCharStats(): Promise<Map<string, CharStat>> {
  const db = await openDb();
  const tx = db.transaction("charStats", "readonly");
  const req = tx.objectStore("charStats").getAll();
  await done(tx);
  return new Map((req.result as CharStat[]).map((s) => [s.char, s]));
}

/** 解答の記録と文字の成績を同じトランザクションで保存する */
export async function saveAttempt(attempt: Attempt, stat: CharStat): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(["attempts", "charStats"], "readwrite");
  tx.objectStore("attempts").add(attempt);
  tx.objectStore("charStats").put(stat);
  await done(tx);
}
