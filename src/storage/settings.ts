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
  /** 単字即答の 1 セッションの問題数 */
  questions: number;
  /** グループ受信の実効速度（WPM）。autoEwpm なら練習結果に応じて自動で変わる */
  ewpm: number;
  /** 実効速度を自動で調整するか */
  autoEwpm: boolean;
  /** グループ受信の 1 セッションのグループ数 */
  groups: number;
  /** 遅れ受信の速度（字/分）。autoStreamCpm なら練習結果に応じて自動で変わる */
  streamCpm: number;
  /** 遅れ受信の速度を自動で調整するか */
  autoStreamCpm: boolean;
  /** 遅れ受信の 1 セッションのグループ数 */
  streamGroups: number;
  /** 遅れ受信で許容する遅れ（字） */
  allowedLag: number;
  /** 模擬試験の速度（字/分） */
  mockCpm: number;
  /** 模擬試験の長さ（分） */
  mockMinutes: number;
  /** 送信練習のお題の字数（5 字 1 組） */
  sendChars: number;
  /** 送信の模擬試験の目標速度（字/分） */
  sendMockCpm: number;
  /** 送信の模擬試験の長さ（分） */
  sendMockMinutes: number;
  /** グループ送信で、送信の苦手な文字を多めに出すか */
  sendFocusWeak: boolean;
  /** 送信練習の入力。練習機の音をマイクで拾うか、画面（キーボード）のパドルを使うか */
  sendInput: "mic" | "paddle";
  /** 画面のパドルの速度（WPM） */
  paddleWpm: number;
  /** 画面のパドルの左右を入れ替える（既定は左が短点） */
  paddleSwap: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  charset: "alnum",
  cwpm: 25,
  freq: 650,
  volume: 0.5,
  limitMs: 3000,
  autoLimit: true,
  questions: 50,
  ewpm: 5,
  autoEwpm: true,
  groups: 10,
  streamCpm: 30,
  autoStreamCpm: true,
  streamGroups: 10,
  allowedLag: 1,
  mockCpm: 40,
  mockMinutes: 3,
  // 試験（欧文暗語 80 字/分）の 1 分間分
  sendChars: 80,
  sendMockCpm: 80,
  sendMockMinutes: 5,
  sendFocusWeak: true,
  sendInput: "mic",
  paddleWpm: 20,
  paddleSwap: false,
};

const KEY = "morse_one.settings";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Settings>;
      // 自動調整導入前の固定制限時間は短すぎるので引き継がない
      if (saved.autoLimit === undefined) delete saved.limitMs;
      // 組数で指定していたころの設定。字数での指定（既定 80 字）に切り替える
      delete (saved as { sendGroups?: number }).sendGroups;
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
