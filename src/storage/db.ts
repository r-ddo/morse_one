import { ConfusionTracker } from "../training/confusion";
import type { CharStat } from "../training/stats";

/** 1 回の解答の記録 */
export interface Attempt {
  id?: number;
  ts: number;
  mode: "single" | "group" | "contrast" | "stream";
  target: string;
  /** 入力した文字。時間切れ・不明なら null */
  answer: string | null;
  /** 文字が合っていれば true（目標時間を過ぎていても） */
  correct: boolean;
  /** 反応時間（ミリ秒）。単字即答・聞き分けのみ。時間切れなら null */
  rtMs: number | null;
  /** 出題時の目標時間（ミリ秒）。単字即答のみ */
  limitMs?: number;
  /** 実効速度（WPM）。グループ受信のみ */
  ewpm?: number;
  /** 速度（字/分）。遅れ受信のみ */
  cpm?: number;
  cwpm: number;
  freq: number;
}

const DB_NAME = "morse_one";
const DB_VERSION = 2;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (e.oldVersion < 1) {
        const attempts = db.createObjectStore("attempts", { keyPath: "id", autoIncrement: true });
        attempts.createIndex("ts", "ts");
        db.createObjectStore("charStats", { keyPath: "char" });
      }
      if (e.oldVersion < 2) {
        db.createObjectStore("mocks", { keyPath: "id", autoIncrement: true });
      }
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
export async function saveAttempts(attempts: Attempt[], stats: CharStat[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(["attempts", "charStats"], "readwrite");
  for (const a of attempts) tx.objectStore("attempts").add(a);
  for (const s of stats) tx.objectStore("charStats").put(s);
  await done(tx);
}

export function saveAttempt(attempt: Attempt, stat: CharStat): Promise<void> {
  return saveAttempts([attempt], [stat]);
}

/** 単字即答・グループ受信の誤答から取り違えを集計する（聞き分け練習の 2 択は含めない） */
export async function loadConfusions(): Promise<ConfusionTracker> {
  const db = await openDb();
  const tx = db.transaction("attempts", "readonly");
  const req = tx.objectStore("attempts").getAll();
  await done(tx);
  const tracker = new ConfusionTracker();
  for (const a of req.result as Attempt[]) {
    if (a.mode !== "contrast" && a.answer !== null && !a.correct) tracker.add(a.target, a.answer, a.ts);
  }
  return tracker;
}

/** 模擬試験（紙に書き取って自己採点）の結果 */
export interface MockResult {
  id?: number;
  ts: number;
  /** 速度（字/分） */
  cpm: number;
  minutes: number;
  chars: number;
  charset: string;
  wrong: number;
  missing: number;
  extra: number;
  /** 抹消・訂正の数 */
  corrections: number;
  score: number;
}

export async function saveMock(result: MockResult): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("mocks", "readwrite");
  tx.objectStore("mocks").add(result);
  await done(tx);
}

/** 新しい順 */
export async function loadMocks(): Promise<MockResult[]> {
  const db = await openDb();
  const tx = db.transaction("mocks", "readonly");
  const req = tx.objectStore("mocks").getAll();
  await done(tx);
  return (req.result as MockResult[]).sort((a, b) => b.ts - a.ts);
}
