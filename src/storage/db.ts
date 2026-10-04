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
const DB_VERSION = 3;

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
      if (e.oldVersion < 3) {
        db.createObjectStore("sends", { keyPath: "id", autoIncrement: true });
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

/** 送信練習の結果 */
export interface SendRecord {
  id?: number;
  ts: number;
  mode: "group" | "mock";
  /** お題（空白なし） */
  target: string;
  /** 復号した文字。符号表にない符号は符号のまま（訂正符号を含む） */
  sent: string[];
  charset: string;
  wrong: number;
  missing: number;
  extra: number;
  unclear: number;
  unsent: number;
  corrections: number;
  longCharGaps: number;
  longWordGaps: number;
  deduction: number;
  points: number;
  /** 送信速度（字/分） */
  cpm: number | null;
  /** 推定した符号の速度（WPM） */
  wpm: number;
  dashRatio: number | null;
  /** 文字間・語間の平均（短点単位）とばらつき（変動係数） */
  charGap: number | null;
  charGapCv: number | null;
  wordGap: number | null;
  wordGapCv: number | null;
  /** 模擬試験の長さ（分） */
  minutes?: number;
}

export async function saveSend(record: SendRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction("sends", "readwrite");
  tx.objectStore("sends").add(record);
  await done(tx);
}

/** 新しい順 */
export async function loadSends(): Promise<SendRecord[]> {
  const db = await openDb();
  const tx = db.transaction("sends", "readonly");
  const req = tx.objectStore("sends").getAll();
  await done(tx);
  return (req.result as SendRecord[]).sort((a, b) => b.ts - a.ts);
}

export async function loadAttempts(): Promise<Attempt[]> {
  const db = await openDb();
  const tx = db.transaction("attempts", "readonly");
  const req = tx.objectStore("attempts").getAll();
  await done(tx);
  return req.result as Attempt[];
}

export interface StoredData {
  attempts: Attempt[];
  charStats: CharStat[];
  mocks: MockResult[];
  sends: SendRecord[];
}

export async function loadAll(): Promise<StoredData> {
  const db = await openDb();
  const tx = db.transaction(["attempts", "charStats", "mocks", "sends"], "readonly");
  const attempts = tx.objectStore("attempts").getAll();
  const charStats = tx.objectStore("charStats").getAll();
  const mocks = tx.objectStore("mocks").getAll();
  const sends = tx.objectStore("sends").getAll();
  await done(tx);
  return {
    attempts: attempts.result as Attempt[],
    charStats: charStats.result as CharStat[],
    mocks: mocks.result as MockResult[],
    sends: sends.result as SendRecord[],
  };
}

/** 保存されているデータをすべて置き換える（1 つのトランザクションで行い、失敗したら元のまま） */
export async function replaceAll(data: StoredData): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(["attempts", "charStats", "mocks", "sends"], "readwrite");
  const attempts = tx.objectStore("attempts");
  const charStats = tx.objectStore("charStats");
  const mocks = tx.objectStore("mocks");
  const sends = tx.objectStore("sends");
  attempts.clear();
  charStats.clear();
  mocks.clear();
  sends.clear();
  for (const a of data.attempts) attempts.put(a);
  for (const s of data.charStats) charStats.put(s);
  for (const m of data.mocks) mocks.put(m);
  for (const r of data.sends) sends.put(r);
  await done(tx);
}
