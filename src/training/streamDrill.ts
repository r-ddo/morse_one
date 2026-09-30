import { MORSE } from "../audio/code";
import { charEndTimes, type MorsePlayer } from "../audio/player";
import { averageCodeUnits, timingForCharRate, type Timing } from "../audio/timing";
import type { Attempt } from "../storage/db";
import type { Settings } from "../storage/settings";
import { adaptCpm } from "./adaptive";
import { charsetChars } from "./charset";
import type { ConfusionTracker } from "./confusion";
import { UNKNOWN } from "./groupDrill";
import { pickChar } from "./picker";
import { scoreExam, type ExamScore } from "./scoring";
import { newStat, updateStat, type CharStat } from "./stats";
import { makeGroups } from "./text";

export interface StreamSummary {
  groups: string[];
  typed: string;
  score: ExamScore;
  cpm: number;
  nextCpm: number;
  allowedLag: number;
  /** 最大の遅れ（字） */
  maxLag: number;
  /** 許容した遅れを超えた回数 */
  overCount: number;
}

export type StreamEvent =
  | { type: "start"; total: number; cpm: number; timing: Timing }
  | { type: "typed"; typed: string }
  /** played: 鳴り終わった字数 */
  | { type: "lag"; played: number; lag: number; over: boolean }
  | { type: "played" }
  | { type: "finished"; summary: StreamSummary };

export interface StreamDeps {
  player: MorsePlayer;
  settings: Settings;
  stats: Map<string, CharStat>;
  confusions: ConfusionTracker;
  save: (attempts: Attempt[], stats: CharStat[]) => Promise<void>;
  onEvent: (e: StreamEvent) => void;
}

const TICK_MS = 100;

/** 遅れ受信モード：グループ間で止めずに流し続け、聞きながら入力する */
export class StreamDrill {
  private groups: string[] = [];
  private target = "";
  private typed = "";
  /** 各文字が鳴り終わる時刻（performance.now() 基準） */
  private charEndPerf: number[] = [];
  private cpm = 0;
  private playing = false;
  private maxLag = 0;
  private overCount = 0;
  private over = false;
  private finished = false;
  private ticker: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: StreamDeps) {}

  start(): void {
    const { settings, stats, player, onEvent } = this.deps;
    const chars = charsetChars(settings.charset);
    this.groups = makeGroups(settings.streamGroups, (prev) =>
      pickChar(chars, stats, { limitMs: settings.limitMs, now: Date.now(), exclude: prev }),
    );
    this.target = this.groups.join("");
    this.cpm = settings.streamCpm;

    const timing = timingForCharRate(settings.cwpm, this.cpm, averageCodeUnits(chars.map((c) => MORSE[c])));
    const text = this.groups.join(" ");
    const pb = player.play(text, timing, { freq: settings.freq, volume: settings.volume });
    this.charEndPerf = charEndTimes(text, timing).map((t) => pb.startPerf + t * 1000);
    this.playing = true;
    onEvent({ type: "start", total: this.target.length, cpm: this.cpm, timing });
    onEvent({ type: "typed", typed: "" });

    this.ticker = setInterval(() => this.tick(), TICK_MS);
    void pb.done.then(() => {
      if (this.finished) return;
      this.playing = false;
      onEvent({ type: "played" });
      this.maybeFinish();
    });
  }

  input(ch: string): void {
    if (this.finished || this.typed.length >= this.target.length) return;
    this.typed += ch.toUpperCase();
    this.deps.onEvent({ type: "typed", typed: this.typed });
    this.tick();
    this.maybeFinish();
  }

  unknown(): void {
    this.input(UNKNOWN);
  }

  backspace(): void {
    if (this.finished || this.typed.length === 0) return;
    this.typed = this.typed.slice(0, -1);
    this.deps.onEvent({ type: "typed", typed: this.typed });
  }

  /** 入力を終えて採点する（再生中なら止める） */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    clearInterval(this.ticker);
    this.deps.player.stop();
    this.grade();
  }

  abort(): void {
    this.finished = true;
    clearInterval(this.ticker);
    this.deps.player.stop();
  }

  private tick(): void {
    if (this.finished) return;
    const now = performance.now();
    let played = 0;
    while (played < this.charEndPerf.length && this.charEndPerf[played] <= now) played++;
    const lag = Math.max(0, played - this.typed.length);
    const over = lag > this.deps.settings.allowedLag;
    if (over && !this.over) this.overCount++;
    this.over = over;
    this.maxLag = Math.max(this.maxLag, lag);
    this.deps.onEvent({ type: "lag", played, lag, over });
  }

  private maybeFinish(): void {
    if (!this.playing && this.typed.length >= this.target.length) this.finish();
  }

  private grade(): void {
    const { settings, stats, confusions, save, onEvent } = this.deps;
    const score = scoreExam(this.target, this.typed, UNKNOWN);
    const ts = Date.now();
    const attempts: Attempt[] = [];
    const updated = new Map<string, CharStat>();
    [...this.target].forEach((c, i) => {
      const correct = score.marks[i] === "ok";
      const answer = score.typedAt[i];
      if (score.marks[i] === "wrong" && answer) confusions.add(c, answer, ts);
      const stat = updateStat(stats.get(c) ?? newStat(c), { correct, rtMs: null, ts });
      stats.set(c, stat);
      updated.set(c, stat);
      attempts.push({
        ts,
        mode: "stream",
        target: c,
        answer,
        correct,
        rtMs: null,
        cpm: this.cpm,
        cwpm: settings.cwpm,
        freq: settings.freq,
      });
    });
    save(attempts, [...updated.values()]).catch((e) => console.error("failed to save attempts", e));

    const ok = score.marks.filter((m) => m === "ok").length;
    const accuracy = ok / this.target.length;
    const nextCpm = settings.autoStreamCpm
      ? adaptCpm(this.cpm, accuracy, this.overCount === 0)
      : this.cpm;
    onEvent({
      type: "finished",
      summary: {
        groups: this.groups,
        typed: this.typed,
        score,
        cpm: this.cpm,
        nextCpm,
        allowedLag: settings.allowedLag,
        maxLag: this.maxLag,
        overCount: this.overCount,
      },
    });
  }
}
