import { MORSE } from "./code";

const FROM_CODE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(MORSE).map(([ch, code]) => [code, ch]),
);

export type GapKind = "element" | "char" | "word";

export type DecodeEvent =
  /** 符号 1 個（短点・長点）。units は推定短点長を 1 とした長さ */
  | { type: "mark"; kind: "." | "-"; duration: number; units: number }
  /** キーを上げていた間 */
  | { type: "gap"; kind: GapKind; duration: number; units: number }
  /** 文字の区切り。符号表にない符号なら char は null */
  | { type: "char"; char: string | null; code: string } & CharTiming
  | { type: "word" };

/** 文字 1 つ分の符号の長さと時刻（秒） */
export interface CharTiming {
  /** 最初の符号を鳴らし始めた時刻 */
  start: number;
  /** 最後の符号を鳴らし終えた時刻 */
  end: number;
  /** 各符号の長さ */
  marks: number[];
  /** 符号内の間の長さ（marks.length − 1 個） */
  gaps: number[];
  /** 文字を確定したときの推定短点長 */
  dot: number;
}

/** 速度推定に使う直近の符号の数 */
const RECENT = 20;
/** 短点と長点の 2 群に分かれているとみなす長さの比 */
const SPLIT_RATIO = 1.8;
/**
 * 推定短点長に対してこれより短い符号は雑音として捨て、これより短い途切れは同じ符号の続きとみなす。
 * 実際の短点は整形のぶん短めに測れても 0.8 倍程度より短くはならない
 */
const MIN_PART = 0.4;
/** 短い符号を捨てるのは、速度の推定に使う符号がこれだけたまってから */
const MIN_PART_AFTER = 4;

/**
 * キーの上げ下げの時刻からモールス符号を復元する。
 * 短点長は直近の符号の長さから推定し続けるので、速度が変わっても追従する。
 * 区切りの閾値は短点長の 2 倍（符号内 / 文字間）と 5 倍（文字間 / 語間）。
 * 送り始めは推定が外れていることがあるので、文字の区切りと短点・長点は、
 * 文字を確定するときにその時点の推定で判定し直す
 */
export class MorseDecoder {
  /** 推定短点長（秒） */
  dot: number;
  private readonly recent: number[] = [];
  /** 直近の符号内の間の長さ */
  private readonly elementGaps: number[] = [];
  /** 直近の、符号内より長い間（文字間・語間）の長さ */
  private readonly longGaps: number[] = [];
  /**
   * 確定していない符号の鳴り始めと鳴り終わりの時刻。
   * prevUp はその前にキーを上げた時刻、gaps はその前の間を記録した一覧（途切れをつなぐときに戻すため）
   */
  private pending: { start: number; end: number; prevUp: number | null; gaps: number[] | null }[] = [];
  private downAt: number | null = null;
  private upAt: number | null = null;
  private wordPending = false;

  constructor(initialWpm = 20) {
    this.dot = 1.2 / initialWpm;
  }

  get wpm(): number {
    return 1.2 / this.dot;
  }

  /**
   * 文字間と語間を分ける長さ（秒）。標準は短点長の 5 倍。
   * 文字間を広げて送る（Farnsworth 方式など）と短点長からは決められないので、
   * 文字間の方が多いことを利用し、文字間・語間の中央値の 5/3 倍（標準の 3:7 の間）より長ければ語間とする
   */
  get wordThreshold(): number {
    const base = 5 * this.dot;
    if (this.longGaps.length < 4) return base;
    const sorted = [...this.longGaps].sort((a, b) => a - b);
    return Math.max(base, (5 / 3) * sorted[Math.floor(sorted.length / 2)]);
  }

  /** 文字として確定していない符号（例: ".-"） */
  get pendingCode(): string {
    return this.pending.map((m) => this.classify(m.end - m.start)).join("");
  }

  private classify(mark: number): "." | "-" {
    return mark < 2 * this.dot ? "." : "-";
  }

  keyDown(t: number): DecodeEvent[] {
    if (this.downAt !== null) return [];
    const out = this.tick(t);
    const last = this.pending.at(-1);
    if (last && last.end === this.upAt && t - last.end < MIN_PART * this.dot) {
      // ごく短い途切れ。直前の符号の続きとして、その符号をやり直す
      this.pending.pop();
      this.recent.pop();
      last.gaps?.pop();
      this.downAt = last.start;
      this.upAt = last.prevUp;
      return out;
    }
    this.downAt = t;
    return out;
  }

  keyUp(t: number): DecodeEvent[] {
    if (this.downAt === null) return [];
    const start = this.downAt;
    const duration = t - start;
    this.downAt = null;
    if (duration < MIN_PART * this.dot && this.recent.length >= MIN_PART_AFTER) {
      // ごく短い符号は雑音として捨てる（キーを上げたままだったことにする）
      return [];
    }
    const out: DecodeEvent[] = [];
    let gaps: number[] | null = null;
    if (this.upAt !== null) {
      const gap = start - this.upAt;
      const units = gap / this.dot;
      const kind = units < 2 ? "element" : gap < this.wordThreshold ? "char" : "word";
      out.push({ type: "gap", kind, duration: gap, units });
      gaps = kind === "element" ? this.elementGaps : this.longGaps;
      gaps.push(gap);
      if (gaps.length > RECENT) gaps.shift();
    }
    this.pending.push({ start, end: t, prevUp: this.upAt, gaps });
    this.upAt = t;
    this.recent.push(duration);
    if (this.recent.length > RECENT) this.recent.shift();
    this.dot = this.estimate();
    this.wordPending = true;
    out.push({ type: "mark", kind: this.classify(duration), duration, units: duration / this.dot });
    return out;
  }

  /**
   * 短点長の推定。音の立ち上がり・立ち下がりの整形や検出の閾値のせいで、符号は短めに、
   * 符号内の間は同じだけ長めに測れる。両方の平均をとって打ち消す
   */
  private estimate(): number {
    const fromMarks = estimateDot(this.recent, this.dot);
    // 送り始めに文字間を符号内の間と取り違えたものは除く
    const gaps = this.elementGaps.filter((g) => g > 0.5 * fromMarks && g < 1.6 * fromMarks);
    if (gaps.length < 3) return fromMarks;
    return (fromMarks + gaps.reduce((a, b) => a + b, 0) / gaps.length) / 2;
  }

  /** キーを上げたまま時間がたったら文字・語の区切りを出す。定期的に呼ぶ */
  tick(t: number): DecodeEvent[] {
    const out: DecodeEvent[] = [];
    if (this.downAt !== null || this.upAt === null) return out;
    const silence = t - this.upAt;
    if (this.pending.length > 0 && silence >= 2 * this.dot) out.push(...this.flush());
    if (this.wordPending && silence >= this.wordThreshold) {
      out.push({ type: "word" });
      this.wordPending = false;
    }
    return out;
  }

  /** 確定していない符号を、今の推定で区切って文字にする */
  private flush(): DecodeEvent[] {
    const out: DecodeEvent[] = [];
    const dot = this.dot;
    let group: { start: number; end: number }[] = [];
    const emit = () => {
      const marks = group.map((m) => m.end - m.start);
      const code = marks.map((d) => this.classify(d)).join("");
      const gaps = group.slice(1).map((m, i) => m.start - group[i].end);
      out.push({ type: "char", char: FROM_CODE[code] ?? null, code, start: group[0].start, end: group.at(-1)!.end, marks, gaps, dot });
    };
    this.pending.forEach((m, i) => {
      const gap = i > 0 ? m.start - this.pending[i - 1].end : 0;
      if (gap >= 2 * dot) {
        emit();
        if (gap >= this.wordThreshold) out.push({ type: "word" });
        group = [];
      }
      group.push(m);
    });
    emit();
    this.pending = [];
    return out;
  }
}

/**
 * 符号の長さの一覧から短点長を推定する。
 * 長さの比が大きく開くところで短点と長点の 2 群に分け、長点は 1/3 にして平均する。
 * 雑音による極端に短い符号や、少数の外れ値だけの群には引っ張られないようにする。
 * 1 群しかない（E や T ばかり）ときは、前回の推定に近い解釈を選ぶ
 */
export function estimateDot(marks: readonly number[], prev: number): number {
  if (marks.length === 0) return prev;
  const all = [...marks].sort((a, b) => a - b);
  // 下位 1/4 の長さ（ふつうは短点）に比べて極端に短いものは雑音として除く
  const q1 = all[Math.floor(all.length / 4)];
  const sorted = all.filter((d) => d >= MIN_PART * q1);
  // 少数の外れ値だけで 1 群を作る分け方は選ばない
  const minCluster = sorted.length >= 5 ? Math.ceil(sorted.length * 0.15) : 1;
  let split = -1;
  let bestRatio = SPLIT_RATIO;
  for (let i = minCluster - 1; i < sorted.length - minCluster; i++) {
    const ratio = sorted[i + 1] / sorted[i];
    if (ratio >= bestRatio) {
      bestRatio = ratio;
      split = i;
    }
  }
  if (split >= 0) {
    let sum = 0;
    sorted.forEach((d, i) => (sum += i <= split ? d : d / 3));
    return sum / sorted.length;
  }
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return Math.abs(Math.log(mean / prev)) <= Math.abs(Math.log(mean / 3 / prev)) ? mean : mean / 3;
}
