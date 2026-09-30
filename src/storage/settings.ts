import type { CharsetId } from "../training/charset";

export interface Settings {
  charset: CharsetId;
  /** 文字速度（WPM） */
  cwpm: number;
  /** 周波数（Hz） */
  freq: number;
  /** 音量（0〜1） */
  volume: number;
  /** 単字即答の制限時間（ミリ秒） */
  limitMs: number;
  /** 1 セッションの問題数 */
  questions: number;
}

export const DEFAULT_SETTINGS: Settings = {
  charset: "alnum",
  cwpm: 25,
  freq: 650,
  volume: 0.5,
  limitMs: 1500,
  questions: 50,
};

const KEY = "morse_one.settings";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // 読めなければ既定値
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 保存できなくても動作は続ける
  }
}
