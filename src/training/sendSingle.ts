import type { DecodeEvent } from "../audio/decoder";
import { ADAPT_WINDOW, adaptLimit } from "./adaptive";
import { pickChar } from "./picker";
import { newStat, updateStat, type CharStat } from "./stats";

/**
 * fast: 目標時間内に送り始めて正しく送った / hinted: 符号を表示してから送った /
 * wrong: 最初に違う符号を送った / timeout: 正しく送れないまま打ち切った
 */
export type SendSingleVerdict = "fast" | "hinted" | "wrong" | "timeout";

/** 1 問の結果（最初の 1 回で付ける。誤りのあとの送り直しは成績に入れない） */
export interface SendSingleResult {
  target: string;
  /** 最初に送った文字（符号表にない符号は符号のまま）。送らなければ null */
  sent: string | null;
  verdict: SendSingleVerdict;
  /** 表示してから最初の符号を送り始めるまで（ミリ秒）。fast のときだけ */
  rtMs: number | null;
  /** 出題時の目標時間（ミリ秒） */
  limitMs: number;
}

/**
 * question: 答えを待っている / retry: 誤り・ヒントのあと、正しく送るのを待っている /
 * correct: 正しく送れて、次の問題を待っている / finished: 終わった
 */
export type SendSinglePhase = "question" | "retry" | "correct" | "finished";

export interface SendSingleOptions {
  chars: readonly string[];
  /** 文字ごとの成績。結果のたびに更新する */
  stats: Map<string, CharStat>;
  limitMs: number;
  questions: number;
  random?: () => number;
  /** 最初の 1 回の結果が出たとき（保存用） */
  onResult?: (r: SendSingleResult, stat: CharStat) => void;
}

/** 正しく送ってから次の問題を出すまで（秒）。すぐ正解したとき / 誤り・ヒントのあと */
const NEXT_DELAY = 0.35;
const AFTER_MISS_DELAY = 0.9;
/** 符号を表示したあと、これだけ（秒）無音が続いたら打ち切る */
const RETRY_GIVE_UP = 8;
/** 誤った文字を復習として出し直すまでの問題数 */
const FOLLOW_UP_AFTER = 3;

/**
 * 単字即答（送信）: 文字を 1 つ表示し、その符号を送ってもらう（単語カードのように符号を覚える）。
 * 目標時間を過ぎても送り始めなければ符号を表示する。違う符号を送ったら符号を表示し、正しく送るまで繰り返す。
 * 成績は最初の 1 回で付け、目標時間は ADAPT_WINDOW 問ごとに見直す。時刻は入力の時刻（秒）
 */
export class SendSingleDrill {
  phase: SendSinglePhase = "question";
  readonly results: SendSingleResult[] = [];
  limitMs: number;
  target = "";
  /** 符号を表示しているか */
  showCode = false;
  /** 直前に送った文字（表示用）。まだなければ null */
  lastSent: string | null = null;
  private shownAt = 0;
  /** 最後に送った（または表示した）時刻。送り直しの打ち切りに使う */
  private lastActivity = 0;
  private correctAt = 0;
  private result: SendSingleResult | null = null;
  private readonly followUps: { char: string; due: number }[] = [];

  constructor(private readonly opts: SendSingleOptions) {
    this.limitMs = opts.limitMs;
  }

  /** 今の問題の番号（0 から） */
  get index(): number {
    return this.results.length - (this.result ? 1 : 0);
  }

  get total(): number {
    return this.opts.questions;
  }

  /** 最初の問題を出す */
  start(now: number): void {
    this.ask(now);
  }

  /** 復号のイベントを処理する。表示を更新すべき変化があれば true */
  handle(events: readonly DecodeEvent[], now: number): boolean {
    let changed = false;
    for (const e of events) {
      if (e.type !== "char" || this.phase === "finished" || this.phase === "correct") continue;
      // 問題を出す前に送り始めていた文字（前の問題の続きなど）は数えない
      if (e.start < this.shownAt) continue;
      const sent = e.char ?? e.code;
      this.lastSent = sent;
      this.lastActivity = now;
      changed = true;
      const ok = e.char === this.target;
      if (!this.result) {
        const rtMs = Math.max(0, Math.round((e.start - this.shownAt) * 1000));
        const verdict: SendSingleVerdict = !ok ? "wrong" : this.showCode ? "hinted" : "fast";
        this.record({ target: this.target, sent, verdict, rtMs: verdict === "fast" ? rtMs : null, limitMs: this.limitMs });
      }
      if (ok) {
        this.phase = "correct";
        this.correctAt = now;
      } else {
        this.phase = "retry";
        this.showCode = true;
      }
    }
    return changed;
  }

  /**
   * 時間の経過による変化を処理する。busy は送っている途中（キーを下げている、または確定していない符号がある）か。
   * 定期的に呼ぶ。表示を更新すべき変化があれば true
   */
  tick(now: number, busy: boolean): boolean {
    if (busy) this.lastActivity = now;
    switch (this.phase) {
      case "question": {
        const elapsed = (now - this.shownAt) * 1000;
        if (!this.showCode && !busy && elapsed >= this.limitMs) {
          this.showCode = true;
          this.lastActivity = now;
          return true;
        }
        return this.showCode && !busy && now - this.lastActivity >= RETRY_GIVE_UP ? this.giveUp(now) : false;
      }
      case "retry":
        return !busy && now - this.lastActivity >= RETRY_GIVE_UP ? this.giveUp(now) : false;
      case "correct": {
        const fast = this.results.at(-1)?.verdict === "fast";
        if (now - this.correctAt < (fast ? NEXT_DELAY : AFTER_MISS_DELAY)) return false;
        this.next(now);
        return true;
      }
      case "finished":
        return false;
    }
  }

  /** 正しく送れないまま打ち切って次へ */
  private giveUp(now: number): boolean {
    if (!this.result) this.record({ target: this.target, sent: null, verdict: "timeout", rtMs: null, limitMs: this.limitMs });
    this.next(now);
    return true;
  }

  private record(r: SendSingleResult): void {
    this.result = r;
    this.results.push(r);
    const { stats, onResult } = this.opts;
    const stat = updateStat(stats.get(r.target) ?? newStat(r.target), {
      correct: r.verdict === "fast",
      rtMs: r.rtMs,
      ts: Date.now(),
    });
    stats.set(r.target, stat);
    onResult?.(r, stat);
    if (r.verdict !== "fast") this.followUps.push({ char: r.target, due: this.results.length + FOLLOW_UP_AFTER });
    if (this.results.length % ADAPT_WINDOW === 0) {
      const recent = this.results.slice(-ADAPT_WINDOW);
      this.limitMs = adaptLimit(this.limitMs, recent.filter((x) => x.verdict === "fast").length / recent.length);
    }
  }

  private next(now: number): void {
    if (this.results.length >= this.opts.questions) {
      this.phase = "finished";
      return;
    }
    this.ask(now);
  }

  private ask(now: number): void {
    const due = this.followUps.findIndex((f) => f.due <= this.results.length && f.char !== this.target);
    const followUp = due >= 0 ? this.followUps.splice(due, 1)[0].char : null;
    this.target = followUp ?? pickChar(this.opts.chars, this.opts.stats, {
      limitMs: this.limitMs,
      now: Date.now(),
      exclude: this.target,
      random: this.opts.random,
    });
    this.phase = "question";
    this.showCode = false;
    this.lastSent = null;
    this.result = null;
    this.shownAt = now;
    this.lastActivity = now;
  }
}

/** 記録から文字ごとの成績を作る（古い順に積み上げる） */
export function sendSingleStats(attempts: readonly { ts: number; target: string; verdict: SendSingleVerdict; rtMs: number | null }[]): Map<string, CharStat> {
  const stats = new Map<string, CharStat>();
  for (const a of [...attempts].sort((x, y) => x.ts - y.ts)) {
    stats.set(a.target, updateStat(stats.get(a.target) ?? newStat(a.target), {
      correct: a.verdict === "fast",
      rtMs: a.rtMs,
      ts: a.ts,
    }));
  }
  return stats;
}
