import { MORSE } from "../audio/code";
import { charEndTimes, type MorsePlayer } from "../audio/player";
import { averageCodeUnits, timingForCharRate } from "../audio/timing";
import type { Settings } from "../storage/settings";
import { charsetChars } from "./charset";
import { GROUP_LEN } from "./groupDrill";
import { makeGroups } from "./text";

/** 試験開始の合図（字数に数えない） */
const START_SIGNAL = "HR HR";
/** 終わりの合図 */
const END_SIGNAL = "AR";

export type MockEvent =
  /** startPerf / endPerf: 本文の開始・終了時刻（performance.now() 基準） */
  | { type: "start"; groups: string[]; startPerf: number; endPerf: number }
  | { type: "finished"; groups: string[] };

export interface MockDeps {
  player: MorsePlayer;
  settings: Settings;
  onEvent: (e: MockEvent) => void;
}

/** 模擬試験の字数。5 字単位に丸める */
export function mockLength(cpm: number, minutes: number): number {
  return Math.max(GROUP_LEN, Math.round((cpm * minutes) / GROUP_LEN) * GROUP_LEN);
}

/** 模擬試験：試験と同じ速度・長さで一様ランダムな暗語を流す。書き取りは紙で行う */
export class MockExam {
  private aborted = false;

  constructor(private readonly deps: MockDeps) {}

  start(): void {
    const { settings, player, onEvent } = this.deps;
    const chars = charsetChars(settings.charset);
    const count = mockLength(settings.mockCpm, settings.mockMinutes) / GROUP_LEN;
    const groups = makeGroups(count, () => chars[Math.floor(Math.random() * chars.length)]);

    const timing = timingForCharRate(settings.cwpm, settings.mockCpm, averageCodeUnits(chars.map((c) => MORSE[c])));
    const text = [START_SIGNAL, ...groups, END_SIGNAL].join(" ");
    const pb = player.play(text, timing, { freq: settings.freq, volume: settings.volume });
    const ends = charEndTimes(text, timing);
    const signalLen = START_SIGNAL.replaceAll(" ", "").length;
    // 本文の最初の文字の鳴り始め ≒ 開始合図の最後の文字の終わり + 語間
    const startPerf = pb.startPerf + (ends[signalLen - 1] + timing.wordGap) * 1000;
    const endPerf = pb.startPerf + ends[ends.length - 1 - END_SIGNAL.length] * 1000;
    onEvent({ type: "start", groups, startPerf, endPerf });

    void pb.done.then(() => {
      if (!this.aborted) onEvent({ type: "finished", groups });
    });
  }

  abort(): void {
    this.aborted = true;
    this.deps.player.stop();
  }
}
