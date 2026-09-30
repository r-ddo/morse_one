import type { MorsePlayer } from "../audio/player";
import { MORSE } from "../audio/code";
import { farnsworth } from "../audio/timing";
import type { Attempt } from "../storage/db";
import type { Settings } from "../storage/settings";
import { ADAPT_WINDOW, adaptLimit, giveUpMs } from "./adaptive";
import { charsetChars } from "./charset";
import { pickChar } from "./picker";
import { newStat, updateStat, type CharStat } from "./stats";

/** fast: 目標時間内に正解 / slow: 目標時間を過ぎて正解 / wrong: 誤答 / timeout: 打ち切り */
export type Verdict = "fast" | "slow" | "wrong" | "timeout";

export interface DrillResult {
  target: string;
  answer: string | null;
  verdict: Verdict;
  rtMs: number | null;
  /** 出題時の目標時間（ミリ秒） */
  limitMs: number;
}

export interface DrillSummary {
  results: DrillResult[];
  /** 正解数（遅い正解を含む） */
  correct: number;
  /** 目標時間内の正解数 */
  fast: number;
  /** 正解の平均反応時間（ミリ秒） */
  avgRtMs: number | null;
  /** 終了時の目標時間（ミリ秒） */
  limitMs: number;
}

export type DrillEvent =
  | { type: "question"; index: number; total: number; limitMs: number }
  | ({ type: "result"; index: number; total: number } & DrillResult)
  | { type: "limit"; limitMs: number }
  /** 答え合わせの音を再生中（target: 正解の符号 / answer: 自分の答えの符号 / null: 再生終了） */
  | { type: "replay"; which: "target" | "answer" | null }
  | { type: "finished"; summary: DrillSummary };

export interface DrillDeps {
  player: MorsePlayer;
  settings: Settings;
  /** 文字ごとの成績。解答のたびに更新される */
  stats: Map<string, CharStat>;
  save: (attempt: Attempt, stat: CharStat) => Promise<void>;
  onEvent: (e: DrillEvent) => void;
}

/** 目標時間内の正解後に次の問題へ進むまでの間（ミリ秒） */
const NEXT_DELAY = 350;
/** 聞き比べ・聞き直しの音の間（ミリ秒） */
const COMPARE_GAP = 400;
/** 遅い正解・誤答後に次の問題へ進むまでの間（ミリ秒） */
const AFTER_MISS_DELAY = 1200;

/** 単字即答モード：1 文字を聞いてすぐ入力する */
export class SingleDrill {
  private readonly chars: string[];
  private readonly results: DrillResult[] = [];
  private limitMs: number;
  private index = 0;
  private target = "";
  private endPerf = 0;
  private accepting = false;
  private aborted = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: DrillDeps) {
    this.chars = charsetChars(deps.settings.charset);
    this.limitMs = deps.settings.limitMs;
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
      limitMs: this.limitMs,
      now: Date.now(),
      exclude: this.target,
    });
    onEvent({ type: "question", index: this.index, total: settings.questions, limitMs: this.limitMs });

    const pb = player.play(this.target, this.timing, this.tone);
    this.endPerf = pb.endPerf;
    this.accepting = true;
    const wait = Math.max(0, pb.endPerf + giveUpMs(this.limitMs) - performance.now());
    this.timer = setTimeout(() => void this.resolve(null), wait);
  }

  private async resolve(answer: string | null): Promise<void> {
    if (!this.accepting) return;
    this.accepting = false;
    clearTimeout(this.timer);

    const { settings, stats, player, save, onEvent } = this.deps;
    const limitMs = this.limitMs;
    const rtMs = answer === null ? null : Math.max(0, Math.round(performance.now() - this.endPerf));
    const correct = answer === this.target;
    const verdict: Verdict =
      answer === null ? "timeout" : !correct ? "wrong" : rtMs! <= limitMs ? "fast" : "slow";
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
        limitMs,
        cwpm: settings.cwpm,
        freq: settings.freq,
      },
      stat,
    ).catch((e) => console.error("failed to save attempt", e));

    const result: DrillResult = { target: this.target, answer, verdict, rtMs, limitMs };
    this.results.push(result);
    onEvent({ type: "result", index: this.index, total: settings.questions, ...result });

    player.stop();
    if (verdict === "fast") {
      await sleep(NEXT_DELAY);
    } else {
      // 正解の符号を聞き直す。誤答なら続けて自分の答えの符号を鳴らして聞き比べる
      await sleep(COMPARE_GAP);
      if (this.aborted) return;
      onEvent({ type: "replay", which: "target" });
      await player.play(this.target, this.timing, this.tone).done;
      if (verdict === "wrong" && answer !== null && MORSE[answer]) {
        onEvent({ type: "replay", which: null });
        await sleep(COMPARE_GAP);
        if (this.aborted) return;
        onEvent({ type: "replay", which: "answer" });
        await player.play(answer, this.timing, this.tone).done;
      }
      if (this.aborted) return;
      onEvent({ type: "replay", which: null });
      await sleep(AFTER_MISS_DELAY);
    }
    if (this.aborted) return;

    this.index++;
    this.adapt();
    this.next();
  }

  /** ADAPT_WINDOW 問ごとに目標時間を見直す */
  private adapt(): void {
    if (!this.deps.settings.autoLimit || this.index % ADAPT_WINDOW !== 0) return;
    const recent = this.results.slice(-ADAPT_WINDOW);
    const fastRate = recent.filter((r) => r.verdict === "fast").length / recent.length;
    const next = adaptLimit(this.limitMs, fastRate);
    if (next !== this.limitMs) {
      this.limitMs = next;
      this.deps.onEvent({ type: "limit", limitMs: next });
    }
  }

  private finish(): void {
    const hits = this.results.filter((r) => r.verdict === "fast" || r.verdict === "slow");
    const rts = hits.map((r) => r.rtMs).filter((v): v is number => v !== null);
    this.deps.onEvent({
      type: "finished",
      summary: {
        results: this.results,
        correct: hits.length,
        fast: hits.filter((r) => r.verdict === "fast").length,
        avgRtMs: rts.length ? Math.round(rts.reduce((a, b) => a + b, 0) / rts.length) : null,
        limitMs: this.limitMs,
      },
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
