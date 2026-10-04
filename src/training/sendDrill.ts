import type { DecodeEvent } from "../audio/decoder";
import type { SendRecord } from "../storage/db";
import { evaluateSend, isCorrection, markString, type SendResult, type SentChar } from "./sendScoring";

/**
 * warmup: VVV を送って周波数と速度の推定を合わせている。V を正しく復号できたら、その周波数と速度で固定してよい
 * ready: 準備ができ、お題の最初の文字を待っている
 * sending: お題を送っている
 */
export type SendPhase = "warmup" | "ready" | "sending" | "finished";

/** 準備が済んだとみなす、慣らしで正しく復号した V の数 */
const WARMUP_VS = 2;
/** 準備のあと、お題を始める前に置く無音（秒） */
const READY_SILENCE = 1;
/** お題を送り終えてから終了するまでの無音（秒） */
const FINISH_SILENCE = 3;

/** 送信練習の進行。復号のイベントを受け取り、準備 → 送信 → 終了と進める */
export class SendSession {
  readonly target: string;
  phase: SendPhase = "warmup";
  private readonly sent: SentChar[] = [];
  private warmupVs = 0;
  /** 最後にキーを上げた時刻（秒） */
  private lastActivity = 0;
  private cached: SendResult | null = null;
  /** お題の最初の文字を鳴らし始めた時刻（秒）。制限時間はここから数える */
  private startedAt: number | null = null;

  /** limitSec: 制限時間（秒）。指定すると模擬試験として、送れなかった字を未送信として採点する */
  constructor(
    readonly groups: readonly string[],
    private readonly opts: { limitSec?: number } = {},
  ) {
    this.target = groups.join("");
  }

  get limitSec(): number | null {
    return this.opts.limitSec ?? null;
  }

  /** お題を送り始めてからの時間（秒）。制限時間を超えない */
  elapsed(now: number): number {
    if (this.startedAt === null) return 0;
    return Math.min(now - this.startedAt, this.opts.limitSec ?? Infinity);
  }

  /** 制限時間を過ぎたか */
  timeUp(now: number): boolean {
    return this.opts.limitSec !== undefined && this.startedAt !== null && now - this.startedAt >= this.opts.limitSec;
  }

  /** お題として受け付けた文字（訂正符号を含む） */
  get chars(): readonly SentChar[] {
    return this.sent;
  }

  /** 復号のイベントを処理する。表示を更新すべき変化があれば true */
  handle(events: readonly DecodeEvent[], now: number): boolean {
    let changed = false;
    for (const e of events) {
      if (e.type === "mark") this.lastActivity = now;
      if (e.type !== "char") continue;
      if (this.phase === "warmup") {
        if (e.char === "V") this.warmupVs++;
      } else if (this.phase === "ready" || this.phase === "sending") {
        this.startedAt ??= e.start;
        // 制限時間を過ぎてから鳴らし始めた文字は数えない
        if (this.opts.limitSec !== undefined && e.start > this.startedAt + this.opts.limitSec) continue;
        this.phase = "sending";
        this.sent.push(e);
        this.cached = null;
        changed = true;
      }
    }
    return changed;
  }

  /** 無音が続いたときの状態の変化を処理する。定期的に呼ぶ。状態が変わったら true */
  tick(now: number, keyDown: boolean): boolean {
    if (keyDown) {
      this.lastActivity = now;
      return false;
    }
    const silence = now - this.lastActivity;
    if (this.phase === "warmup" && this.warmupVs >= WARMUP_VS) {
      if (silence >= READY_SILENCE) return this.setPhase("ready");
    } else if (this.phase === "sending" && this.sentCount >= this.target.length && silence >= FINISH_SILENCE) {
      return this.setPhase("finished");
    }
    return false;
  }

  /** 慣らしを省略してお題を始める */
  skipWarmup(): void {
    if (this.phase === "warmup") this.phase = "ready";
  }

  finish(): void {
    this.phase = "finished";
    this.cached = null;
  }

  /** 訂正符号を除いた、送った字数 */
  get sentCount(): number {
    return this.sent.filter((c) => !isCorrection(c.code)).length;
  }

  get result(): SendResult {
    this.cached ??= evaluateSend(this.target, this.sent, {
      timed: this.opts.limitSec !== undefined,
      live: this.phase !== "finished",
    });
    return this.cached;
  }

  /** お題のうち、送り終えたところの次の位置 */
  get position(): number {
    const marks = this.result.score.marks;
    for (let t = marks.length - 1; t >= 0; t--) if (marks[t] === "ok" || marks[t] === "wrong") return t + 1;
    return 0;
  }

  toRecord(fields: {
    mode: SendRecord["mode"];
    charset: string;
    wpm: number;
    minutes?: number;
    targetCpm?: number;
    ts?: number;
  }): SendRecord {
    const { score, quality } = this.result;
    return {
      ts: fields.ts ?? Date.now(),
      mode: fields.mode,
      target: this.target,
      sent: this.sent.map((c) => c.char ?? c.code),
      charset: fields.charset,
      wrong: score.wrong,
      missing: score.missing,
      extra: score.extra,
      unclear: score.unclear,
      unsent: score.unsent,
      corrections: score.corrections,
      longCharGaps: score.longCharGaps,
      longWordGaps: score.longWordGaps,
      deduction: score.deduction,
      points: score.points,
      cpm: quality.cpm,
      wpm: fields.wpm,
      dashRatio: quality.dashRatio,
      charGap: quality.charGap?.mean ?? null,
      charGapCv: quality.charGap?.cv ?? null,
      wordGap: quality.wordGap?.mean ?? null,
      wordGapCv: quality.wordGap?.cv ?? null,
      ...(fields.minutes !== undefined ? { minutes: fields.minutes } : {}),
      ...(fields.targetCpm !== undefined ? { targetCpm: fields.targetCpm } : {}),
      marks: markString(score),
      sentAt: score.sentAt,
    };
  }

  private setPhase(phase: SendPhase): boolean {
    this.phase = phase;
    this.cached = null;
    return true;
  }
}

/**
 * 送信のお題。文字セットから選び（weights を渡せばその重みで、なければ一様に）、同じ文字は続けない
 */
export function sendGroups(
  count: number,
  chars: readonly string[],
  random = Math.random,
  groupLen = 5,
  weights?: readonly number[],
): string[] {
  const total = weights?.reduce((a, b) => a + b, 0) ?? chars.length;
  const pick = (): string => {
    if (!weights) return chars[Math.floor(random() * chars.length)];
    let r = random() * total;
    for (let i = 0; i < chars.length; i++) if ((r -= weights[i]) < 0) return chars[i];
    return chars[chars.length - 1];
  };
  const groups: string[] = [];
  let prev = "";
  for (let g = 0; g < count; g++) {
    let group = "";
    for (let i = 0; i < groupLen; i++) {
      let c: string;
      do c = pick();
      while (c === prev && chars.length > 1);
      group += c;
      prev = c;
    }
    groups.push(group);
  }
  return groups;
}
