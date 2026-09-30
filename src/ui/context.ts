import type { MorsePlayer } from "../audio/player";
import type { Settings } from "../storage/settings";
import type { ConfusionTracker } from "../training/confusion";
import type { CharStat } from "../training/stats";

/** 実行中の練習。物理キーボードの入力を受け取る */
export interface ActiveDrill {
  /** 処理したキーなら true */
  key(e: KeyboardEvent): boolean;
  abort(): void;
}

/** 各画面から使うアプリの機能 */
export interface ScreenContext {
  readonly player: MorsePlayer;
  readonly settings: Settings;
  updateSettings(patch: Partial<Settings>): void;
  readonly stats: Map<string, CharStat>;
  readonly confusions: ConfusionTracker;
  render(...children: (Node | null | false)[]): void;
  setActive(active: ActiveDrill | null): void;
  stopDrill(): void;
  showHome(): void;
}
