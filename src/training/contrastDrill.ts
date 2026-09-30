import type { MorsePlayer } from "../audio/player";
import { farnsworth } from "../audio/timing";
import type { Attempt } from "../storage/db";
import type { Settings } from "../storage/settings";

export interface ContrastResult {
  target: string;
  answer: string;
  correct: boolean;
  rtMs: number;
}

export interface ContrastSummary {
  pair: [string, string];
  results: ContrastResult[];
  correct: number;
  /** 正解の平均反応時間（ミリ秒） */
  avgRtMs: number | null;
}

export type ContrastEvent =
  /** 最初に 2 つの符号を順に聞かせる。which は再生中の文字（null: 終了） */
  | { type: "intro"; which: string | null }
  | { type: "question"; index: number; total: number }
  | ({ type: "result"; index: number; total: number } & ContrastResult)
  | { type: "replay"; which: string | null }
  | { type: "finished"; summary: ContrastSummary };

export interface ContrastDeps {
  player: MorsePlayer;
  settings: Settings;
  pair: [string, string];
  questions: number;
  save: (attempt: Attempt) => Promise<void>;
  onEvent: (e: ContrastEvent) => void;
}

const GAP = 500;
const NEXT_DELAY = 350;
const AFTER_MISS_DELAY = 1000;
/** 同じ文字が続く上限。偏りで当てずっぽうが効かないようにする */
const MAX_RUN = 3;

/** 聞き分け練習：取り違えやすい 2 文字だけを出題し、2 択で答える */
export class ContrastDrill {
  private readonly results: ContrastResult[] = [];
  private index = 0;
  private target = "";
  private run = 0;
  private endPerf = 0;
  private accepting = false;
  private aborted = false;

  constructor(private readonly deps: ContrastDeps) {}

  private get timing() {
    const { cwpm } = this.deps.settings;
    return farnsworth(cwpm, cwpm);
  }

  private get tone() {
    const { freq, volume } = this.deps.settings;
    return { freq, volume };
  }

  async start(): Promise<void> {
    const { player, pair, onEvent } = this.deps;
    for (const c of pair) {
      if (this.aborted) return;
      onEvent({ type: "intro", which: c });
      await player.play(c, this.timing, this.tone).done;
      await sleep(GAP);
    }
    if (this.aborted) return;
    onEvent({ type: "intro", which: null });
    await sleep(GAP);
    this.next();
  }

  input(ch: string): void {
    const answer = ch.toUpperCase();
    if (this.accepting && this.deps.pair.includes(answer)) void this.resolve(answer);
  }

  abort(): void {
    this.aborted = true;
    this.accepting = false;
    this.deps.player.stop();
  }

  private next(): void {
    if (this.aborted) return;
    const { pair, questions, player, onEvent } = this.deps;
    if (this.index >= questions) {
      this.finish();
      return;
    }
    let target = pair[Math.floor(Math.random() * 2)];
    if (target === this.target && this.run >= MAX_RUN) target = pair[0] === target ? pair[1] : pair[0];
    this.run = target === this.target ? this.run + 1 : 1;
    this.target = target;

    onEvent({ type: "question", index: this.index, total: questions });
    this.endPerf = player.play(target, this.timing, this.tone).endPerf;
    this.accepting = true;
  }

  private async resolve(answer: string): Promise<void> {
    this.accepting = false;
    const { settings, questions, player, save, onEvent } = this.deps;
    const rtMs = Math.max(0, Math.round(performance.now() - this.endPerf));
    const correct = answer === this.target;

    save({
      ts: Date.now(),
      mode: "contrast",
      target: this.target,
      answer,
      correct,
      rtMs,
      cwpm: settings.cwpm,
      freq: settings.freq,
    }).catch((e) => console.error("failed to save attempt", e));

    const result: ContrastResult = { target: this.target, answer, correct, rtMs };
    this.results.push(result);
    onEvent({ type: "result", index: this.index, total: questions, ...result });

    player.stop();
    if (correct) {
      await sleep(NEXT_DELAY);
    } else {
      // 正解の符号 → 自分の答えの符号の順に聞き比べる
      for (const c of [this.target, answer]) {
        await sleep(GAP);
        if (this.aborted) return;
        onEvent({ type: "replay", which: c });
        await player.play(c, this.timing, this.tone).done;
      }
      onEvent({ type: "replay", which: null });
      await sleep(AFTER_MISS_DELAY);
    }
    if (this.aborted) return;
    this.index++;
    this.next();
  }

  private finish(): void {
    const hits = this.results.filter((r) => r.correct);
    this.deps.onEvent({
      type: "finished",
      summary: {
        pair: this.deps.pair,
        results: this.results,
        correct: hits.length,
        avgRtMs: hits.length ? Math.round(hits.reduce((a, r) => a + r.rtMs, 0) / hits.length) : null,
      },
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
