import type { MorsePlayer } from "../audio/player";
import { MORSE } from "../audio/code";
import { farnsworth } from "../audio/timing";
import type { Attempt } from "../storage/db";
import type { Settings } from "../storage/settings";
import { charsetChars } from "./charset";
import { pickChar } from "./picker";
import { newStat, updateStat, type CharStat } from "./stats";

export interface DrillResult {
  target: string;
  answer: string | null;
  correct: boolean;
  rtMs: number | null;
}

export interface DrillSummary {
  results: DrillResult[];
  correct: number;
  /** 正答の平均反応時間（ミリ秒） */
  avgRtMs: number | null;
}

export type DrillEvent =
  | { type: "question"; index: number; total: number }
  | ({ type: "result"; index: number; total: number } & DrillResult)
  | { type: "finished"; summary: DrillSummary };

export interface DrillDeps {
  player: MorsePlayer;
  settings: Settings;
  /** 文字ごとの成績。解答のたびに更新される */
  stats: Map<string, CharStat>;
  save: (attempt: Attempt, stat: CharStat) => Promise<void>;
  onEvent: (e: DrillEvent) => void;
}

/** 正答後に次の問題へ進むまでの間（ミリ秒） */
const NEXT_DELAY = 350;
/** 聞き比べの音の間（ミリ秒） */
const COMPARE_GAP = 400;
/** 誤答後に次の問題へ進むまでの間（ミリ秒） */
const AFTER_MISS_DELAY = 800;

/** 単字即答モード：1 文字を聞いてすぐ入力する */
export class SingleDrill {
  private readonly chars: string[];
  private readonly results: DrillResult[] = [];
  private index = 0;
  private target = "";
  private endPerf = 0;
  private accepting = false;
  private aborted = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: DrillDeps) {
    this.chars = charsetChars(deps.settings.charset);
  }

  start(): void {
    this.next();
  }

  input(ch: string): void {
    if (this.accepting) void this.resolve(ch.toUpperCase());
  }

  abort(): void {
    this.aborted = true;
    this.accepting = false;
    clearTimeout(this.timer);
    this.deps.player.stop();
  }

  private get timing() {
    const { cwpm } = this.deps.settings;
    return farnsworth(cwpm, cwpm);
  }

  private get tone() {
    const { freq, volume } = this.deps.settings;
    return { freq, volume };
  }

  private next(): void {
    if (this.aborted) return;
    const { settings, stats, player, onEvent } = this.deps;
    if (this.index >= settings.questions) {
      this.finish();
      return;
    }

    this.target = pickChar(this.chars, stats, {
      limitMs: settings.limitMs,
      now: Date.now(),
      exclude: this.target,
    });
    onEvent({ type: "question", index: this.index, total: settings.questions });

    const pb = player.play(this.target, this.timing, this.tone);
    this.endPerf = pb.endPerf;
    this.accepting = true;
    const wait = Math.max(0, pb.endPerf + settings.limitMs - performance.now());
    this.timer = setTimeout(() => void this.resolve(null), wait);
  }

  private async resolve(answer: string | null): Promise<void> {
    if (!this.accepting) return;
    this.accepting = false;
    clearTimeout(this.timer);

    const { settings, stats, player, save, onEvent } = this.deps;
    const rtMs = answer === null ? null : Math.max(0, Math.round(performance.now() - this.endPerf));
    const correct = answer === this.target && rtMs !== null && rtMs <= settings.limitMs;
    const ts = Date.now();

    const stat = updateStat(stats.get(this.target) ?? newStat(this.target), { correct, rtMs, ts });
    stats.set(this.target, stat);
    save(
      {
        ts,
        mode: "single",
        target: this.target,
        answer,
        correct,
        rtMs,
        limitMs: settings.limitMs,
        cwpm: settings.cwpm,
        freq: settings.freq,
      },
      stat,
    ).catch((e) => console.error("failed to save attempt", e));

    const result: DrillResult = { target: this.target, answer, correct, rtMs };
    this.results.push(result);
    onEvent({ type: "result", index: this.index, total: settings.questions, ...result });

    player.stop();
    if (correct) {
      await sleep(NEXT_DELAY);
    } else {
      // 正解の符号、続けて自分の答えの符号を鳴らして聞き比べる
      await sleep(COMPARE_GAP);
      if (this.aborted) return;
      await player.play(this.target, this.timing, this.tone).done;
      if (answer !== null && answer !== this.target && MORSE[answer]) {
        await sleep(COMPARE_GAP);
        if (this.aborted) return;
        await player.play(answer, this.timing, this.tone).done;
      }
      await sleep(AFTER_MISS_DELAY);
    }

    this.index++;
    this.next();
  }

  private finish(): void {
    const hits = this.results.filter((r) => r.correct);
    const rts = hits.map((r) => r.rtMs).filter((v): v is number => v !== null);
    this.deps.onEvent({
      type: "finished",
      summary: {
        results: this.results,
        correct: hits.length,
        avgRtMs: rts.length ? Math.round(rts.reduce((a, b) => a + b, 0) / rts.length) : null,
      },
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
