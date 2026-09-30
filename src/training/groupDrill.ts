import type { MorsePlayer } from "../audio/player";
import { farnsworth } from "../audio/timing";
import type { Attempt } from "../storage/db";
import type { Settings } from "../storage/settings";
import { adaptEwpm, EWPM_WINDOW } from "./adaptive";
import { charsetChars } from "./charset";
import type { ConfusionTracker } from "./confusion";
import { pickChar, shuffle } from "./picker";
import { newStat, updateStat, type CharStat } from "./stats";

export const GROUP_LEN = 5;
/** 聞き取れなかった文字の入力 */
export const UNKNOWN = "_";

export interface GroupResult {
  target: string;
  /** 入力。聞き取れなかった位置は UNKNOWN */
  typed: string;
  /** 位置ごとの正誤 */
  marks: boolean[];
  ewpm: number;
}

export interface GroupSummary {
  results: GroupResult[];
  correct: number;
  total: number;
  startEwpm: number;
  endEwpm: number;
}

export type GroupEvent =
  | { type: "group"; index: number; total: number; ewpm: number; charGapSec: number }
  | { type: "typed"; typed: string }
  | { type: "played" }
  | ({ type: "checked"; index: number; total: number } & GroupResult)
  | { type: "ewpm"; ewpm: number }
  | { type: "finished"; summary: GroupSummary };

export interface GroupDeps {
  player: MorsePlayer;
  settings: Settings;
  stats: Map<string, CharStat>;
  confusions: ConfusionTracker;
  save: (attempts: Attempt[], stats: CharStat[]) => Promise<void>;
  onEvent: (e: GroupEvent) => void;
}

/** 全問正解のとき次のグループへ進むまでの間（ミリ秒） */
const NEXT_DELAY = 1200;

/** 位置ごとに採点する */
export function gradeGroup(target: string, typed: string): boolean[] {
  return [...target].map((c, i) => typed[i] === c);
}

/** 5 文字グループ受信モード：5 文字を聞いて書き取る */
export class GroupDrill {
  private readonly chars: string[];
  private readonly results: GroupResult[] = [];
  private readonly startEwpm: number;
  private ewpm: number;
  private index = 0;
  private target = "";
  private typed = "";
  private playing = false;
  private submitted = false;
  /** 採点済みで次へ進むのを待っている */
  private reviewing = false;
  private aborted = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** 直前のグループで取り違え・聞き逃した文字。次のグループに混ぜる */
  private followUps: string[] = [];

  constructor(private readonly deps: GroupDeps) {
    this.chars = charsetChars(deps.settings.charset);
    this.ewpm = Math.min(deps.settings.ewpm, deps.settings.cwpm);
    this.startEwpm = this.ewpm;
  }

  private get timing() {
    return farnsworth(this.deps.settings.cwpm, this.ewpm);
  }

  private get tone() {
    const { freq, volume } = this.deps.settings;
    return { freq, volume };
  }

  start(): void {
    this.nextGroup();
  }

  input(ch: string): void {
    if (this.submitted || this.reviewing || this.typed.length >= GROUP_LEN) return;
    this.typed += ch.toUpperCase();
    this.deps.onEvent({ type: "typed", typed: this.typed });
    if (this.typed.length === GROUP_LEN) this.submit();
  }

  unknown(): void {
    this.input(UNKNOWN);
  }

  backspace(): void {
    if (this.submitted || this.reviewing || this.typed.length === 0) return;
    this.typed = this.typed.slice(0, -1);
    this.deps.onEvent({ type: "typed", typed: this.typed });
  }

  /** 入力を確定する。足りない位置は不明扱い */
  submit(): void {
    if (this.submitted || this.reviewing) return;
    this.submitted = true;
    this.typed = this.typed.padEnd(GROUP_LEN, UNKNOWN);
    this.deps.onEvent({ type: "typed", typed: this.typed });
    this.maybeCheck();
  }

  /** 採点後に同じグループをもう一度聞く */
  replay(): void {
    if (!this.reviewing) return;
    clearTimeout(this.timer);
    this.deps.player.play(this.target, this.timing, this.tone);
  }

  /** 採点後に次のグループへ進む */
  next(): void {
    if (!this.reviewing) return;
    clearTimeout(this.timer);
    this.deps.player.stop();
    this.reviewing = false;
    this.index++;
    this.adapt();
    this.nextGroup();
  }

  abort(): void {
    this.aborted = true;
    clearTimeout(this.timer);
    this.deps.player.stop();
  }

  private nextGroup(): void {
    if (this.aborted) return;
    const { settings, stats, player, onEvent } = this.deps;
    if (this.index >= settings.groups) {
      this.finish();
      return;
    }

    const picked: string[] = [];
    for (let i = 0; i < GROUP_LEN; i++) {
      picked.push(
        pickChar(this.chars, stats, {
          limitMs: settings.limitMs,
          now: Date.now(),
          exclude: picked.at(-1),
        }),
      );
    }
    // 復習する文字をランダムな位置に入れる
    const positions = shuffle([...picked.keys()]);
    this.followUps.forEach((c, i) => (picked[positions[i]] = c));
    this.followUps = [];
    const target = picked.join("");
    this.target = target;
    this.typed = "";
    this.submitted = false;
    this.playing = true;

    const timing = this.timing;
    onEvent({ type: "group", index: this.index, total: settings.groups, ewpm: this.ewpm, charGapSec: timing.charGap });
    onEvent({ type: "typed", typed: "" });

    const pb = player.play(target, timing, this.tone);
    void pb.done.then(() => {
      if (this.aborted || this.target !== target || !this.playing) return;
      this.playing = false;
      onEvent({ type: "played" });
      this.maybeCheck();
    });
  }

  /** 再生が終わり、入力も確定したら採点する */
  private maybeCheck(): void {
    if (this.playing || !this.submitted || this.reviewing) return;
    this.reviewing = true;

    const { settings, stats, save, onEvent } = this.deps;
    const marks = gradeGroup(this.target, this.typed);
    const ts = Date.now();
    this.queueFollowUps(marks, ts);
    const attempts: Attempt[] = [];
    const updated = new Map<string, CharStat>();
    [...this.target].forEach((c, i) => {
      const answer = this.typed[i] === UNKNOWN ? null : this.typed[i];
      const stat = updateStat(stats.get(c) ?? newStat(c), { correct: marks[i], rtMs: null, ts });
      stats.set(c, stat);
      updated.set(c, stat);
      attempts.push({
        ts,
        mode: "group",
        target: c,
        answer,
        correct: marks[i],
        rtMs: null,
        ewpm: this.ewpm,
        cwpm: settings.cwpm,
        freq: settings.freq,
      });
    });
    save(attempts, [...updated.values()]).catch((e) => console.error("failed to save attempts", e));

    const result: GroupResult = { target: this.target, typed: this.typed, marks, ewpm: this.ewpm };
    this.results.push(result);
    onEvent({ type: "checked", index: this.index, total: settings.groups, ...result });

    // 全問正解なら自動で次へ。間違いがあれば次へ進む操作を待つ
    if (marks.every(Boolean)) this.timer = setTimeout(() => this.next(), NEXT_DELAY);
  }

  /**
   * 取り違えがあれば最初の組み合わせの 2 文字を、なければ聞き逃した文字を最大 2 つ、
   * 次のグループに入れる
   */
  private queueFollowUps(marks: boolean[], ts: number): void {
    const missed: string[] = [];
    let pair: string[] | null = null;
    marks.forEach((ok, i) => {
      if (ok) return;
      const target = this.target[i];
      const typed = this.typed[i];
      missed.push(target);
      if (typed === UNKNOWN) return;
      this.deps.confusions.add(target, typed, ts);
      if (!pair && this.chars.includes(typed)) pair = [target, typed];
    });
    this.followUps = pair ?? [...new Set(missed)].slice(0, 2);
  }

  /** EWPM_WINDOW グループごとに実効速度を見直す */
  private adapt(): void {
    const { settings, onEvent } = this.deps;
    if (!settings.autoEwpm || this.index % EWPM_WINDOW !== 0) return;
    const marks = this.results.slice(-EWPM_WINDOW).flatMap((r) => r.marks);
    const accuracy = marks.filter(Boolean).length / marks.length;
    const next = adaptEwpm(this.ewpm, accuracy, settings.cwpm);
    if (next !== this.ewpm) {
      this.ewpm = next;
      onEvent({ type: "ewpm", ewpm: next });
    }
  }

  private finish(): void {
    const marks = this.results.flatMap((r) => r.marks);
    this.deps.onEvent({
      type: "finished",
      summary: {
        results: this.results,
        correct: marks.filter(Boolean).length,
        total: marks.length,
        startEwpm: this.startEwpm,
        endEwpm: this.ewpm,
      },
    });
  }
}
