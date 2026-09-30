import type { CharsetId } from "../training/charset";

export interface Settings {
  charset: CharsetId;
  /** 文字速度（WPM） */
  cwpm: number;
  /** 周波数（Hz） */
  freq: number;
  /** 音量（0〜1） */
  volume: number;
  /** 単字即答の目標時間（ミリ秒）。autoLimit なら練習結果に応じて自動で変わる */
  limitMs: number;
  /** 目標時間を自動で調整するか */
  autoLimit: boolean;
  /** 1 セッションの問題数 */
  questions: number;
}

export const DEFAULT_SETTINGS: Settings = {
  charset: "alnum",
  cwpm: 25,
  freq: 650,
  volume: 0.5,
  limitMs: 3000,
  autoLimit: true,
  questions: 50,
};

const KEY = "morse_one.settings";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Settings>;
      // 自動調整導入前の固定制限時間は短すぎるので引き継がない
      if (saved.autoLimit === undefined) delete saved.limitMs;
      return { ...DEFAULT_SETTINGS, ...saved };
    }
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
