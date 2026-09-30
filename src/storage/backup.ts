import type { Attempt, MockResult, StoredData } from "./db";
import type { Settings } from "./settings";
import type { CharStat } from "../training/stats";

export const BACKUP_APP = "morse_one";
export const BACKUP_VERSION = 1;

export interface Backup extends StoredData {
  app: typeof BACKUP_APP;
  version: number;
  exportedAt: string;
  settings: Settings;
}

export function makeBackup(data: StoredData, settings: Settings, now = new Date()): Backup {
  return { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: now.toISOString(), settings, ...data };
}

export function backupFileName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `morse_one-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.json`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function isAttempt(v: unknown): v is Attempt {
  return isObject(v) && typeof v.ts === "number" && typeof v.target === "string" && typeof v.correct === "boolean";
}

function isCharStat(v: unknown): v is CharStat {
  return isObject(v) && typeof v.char === "string" && typeof v.attempts === "number" && typeof v.accEma === "number";
}

function isMock(v: unknown): v is MockResult {
  return isObject(v) && typeof v.ts === "number" && typeof v.score === "number";
}

/** バックアップファイルの内容を検証する。問題があれば日本語のメッセージで例外を投げる */
export function parseBackup(text: string): Backup {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("JSON として読めません");
  }
  if (!isObject(json) || json.app !== BACKUP_APP) throw new Error("morse_one のバックアップではありません");
  if (typeof json.version !== "number" || json.version > BACKUP_VERSION) {
    throw new Error("新しいバージョンのアプリで作られたバックアップです");
  }
  const { attempts, charStats, mocks, settings } = json;
  if (!Array.isArray(attempts) || !attempts.every(isAttempt)) throw new Error("解答の記録が壊れています");
  if (!Array.isArray(charStats) || !charStats.every(isCharStat)) throw new Error("文字ごとの成績が壊れています");
  if (!Array.isArray(mocks) || !mocks.every(isMock)) throw new Error("模擬試験の記録が壊れています");
  if (!isObject(settings)) throw new Error("設定が壊れています");
  return json as unknown as Backup;
}
