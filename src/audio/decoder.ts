import { MORSE } from "./code";

const FROM_CODE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(MORSE).map(([ch, code]) => [code, ch]),
);

export type GapKind = "element" | "char" | "word";

export type DecodeEvent =
  /** 符号 1 個（短点・長点）。units は推定短点長を 1 とし、伸びを補正した長さ */
  | { type: "mark"; kind: "." | "-"; duration: number; units: number }
  /** キーを上げていた間。units は推定短点長を 1 とし、伸びを補正した長さ */
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
  /** 各符号の長さ（測ったまま） */
  marks: number[];
  /** 符号内の間の長さ（marks.length − 1 個、測ったまま） */
  gaps: number[];
  /** 文字を確定したときの推定短点長 */
  dot: number;
  /** 文字を確定したときの推定の伸び。符号はこれだけ長く、間はこれだけ短く測れている */
  bias: number;
}

/** 速度推定に使う直近の符号の数 */
const RECENT = 20;
/** 短点と長点（符号内の間と文字間）の 2 群に分かれているとみなす長さの比 */
const SPLIT_RATIO = 1.8;
/** 推定短点長に対してこれより短い符号は雑音として捨てる */
const MIN_PART = 0.4;
/** 短い符号を捨てるのは、速度の推定に使う符号がこれだけたまってから */
const MIN_PART_AFTER = 4;
/** 伸びの推定の範囲（短点長に対する割合） */
const BIAS_RANGE: [number, number] = [-0.5, 0.7];

/**
 * キーの上げ下げの時刻からモールス符号を復元する。
 *
 * 短点長は直近の符号と間の長さから推定し続けるので、速度が変わっても追従する。
 * スピーカーの音をマイクで拾うと、残響や検出の遅れで符号は一定量だけ長く、間は同じだけ短く測れる
 * （音の整形のせいで逆になることもある）。この「伸び」も推定して判定を補正する。
 * 区切りの閾値は、補正した長さで短点長の 2 倍（符号内 / 文字間）と 5 倍（文字間 / 語間）。
 * 送り始めは推定が外れていることがあるので、文字の区切りと短点・長点は、
 * 文字を確定するときにその時点の推定で判定し直す
 */
export class MorseDecoder {
  /** 推定短点長（秒） */
  dot: number;
  /** 推定の伸び（秒） */
  bias = 0;
  private readonly recentMarks: number[] = [];
  /** 直近の間の長さ（符号内・文字間・語間すべて） */
  private readonly recentGaps: number[] = [];
  /** 直近の、符号内より長い間（文字間・語間）の長さ */
  private readonly longGaps: number[] = [];
  /** 確定していない符号の鳴り始めと鳴り終わりの時刻 */
  private pending: { start: number; end: number }[] = [];
  private downAt: number | null = null;
  private upAt: number | null = null;
  private wordPending = false;

  constructor(initialWpm = 20) {
    this.dot = 1.2 / initialWpm;
  }

  get wpm(): number {
    return 1.2 / this.dot;
  }

  /** 符号内の間と文字間を分ける、測ったままの間の長さ（秒） */
  private get charThreshold(): number {
    return 2 * this.dot - this.bias;
  }

  /**
   * 文字間と語間を分ける、測ったままの間の長さ（秒）。標準は短点長の 5 倍。
   * 文字間を広げて送る（Farnsworth 方式など）と短点長からは決められないので、
   * 文字間の方が多いことを利用し、文字間・語間の中央値の 5/3 倍（標準の 3:7 の間）より長ければ語間とする
   */
  get wordThreshold(): number {
    const base = 5 * this.dot - this.bias;
    if (this.longGaps.length < 4) return base;
    const sorted = [...this.longGaps].sort((a, b) => a - b);
    return Math.max(base, (5 / 3) * sorted[Math.floor(sorted.length / 2)]);
  }

  /** 文字として確定していない符号（例: ".-"） */
  get pendingCode(): string {
    return this.pending.map((m) => this.classify(m.end - m.start)).join("");
  }

  private classify(mark: number): "." | "-" {
    return mark < 2 * this.dot + this.bias ? "." : "-";
  }

  keyDown(t: number): DecodeEvent[] {
    if (this.downAt !== null) return [];
    const out = this.tick(t);
    this.downAt = t;
    return out;
  }

  /** accept が false なら、その符号は外の音として捨てる（キーを上げたままだったことにする） */
  keyUp(t: number, accept = true): DecodeEvent[] {
    if (this.downAt === null) return [];
    const start = this.downAt;
    const duration = t - start;
    this.downAt = null;
    if (!accept) return [];
    if (duration < MIN_PART * this.dot && this.recentMarks.length >= MIN_PART_AFTER) {
      // ごく短い符号は雑音として捨てる（キーを上げたままだったことにする）
      return [];
    }
    const out: DecodeEvent[] = [];
    if (this.upAt !== null) {
      const gap = start - this.upAt;
      const kind = gap < this.charThreshold ? "element" : gap < this.wordThreshold ? "char" : "word";
      out.push({ type: "gap", kind, duration: gap, units: (gap + this.bias) / this.dot });
      push(this.recentGaps, gap, RECENT * 2);
      if (kind !== "element") push(this.longGaps, gap, RECENT);
    }
    this.pending.push({ start, end: t });
    this.upAt = t;
    push(this.recentMarks, duration, RECENT);
    this.estimate();
    this.wordPending = true;
    out.push({ type: "mark", kind: this.classify(duration), duration, units: (duration - this.bias) / this.dot });
    return out;
  }

  /**
   * 短点長と伸びの推定。短点は「短点長 + 伸び」、符号内の間は「短点長 − 伸び」に測れるので、
   * 両者の平均が短点長、差の半分が伸びになる。符号内の間がまだなければ、長点との差から求める
   */
  private estimate(): void {
    const prevDotLike = this.dot + this.bias;
    const marks = splitClusters(withoutTiny(this.recentMarks));
    let dotLike: number | null = null;
    let dashLike: number | null = null;
    if (marks.high.length > 0 && marks.low.length > 0) {
      dotLike = mean(marks.low);
      dashLike = mean(marks.high);
    } else {
      // 1 群しかない（E や T ばかり）ときは、前回の推定に近い解釈を選ぶ
      const m = mean(marks.low);
      const asDot = Math.abs(Math.log(m / prevDotLike));
      const asDash = Math.abs(Math.log(m / (3 * this.dot + this.bias)));
      if (asDot <= asDash) dotLike = m;
      else dashLike = m;
    }

    // 間を 2 群に分けた短い方が符号内の間。短点と比べてありえない長さなら使わない
    const gaps = splitClusters(this.recentGaps);
    const ref = dotLike ?? prevDotLike;
    const elementGap = gaps.low.length > 0 && mean(gaps.low) < 1.6 * ref ? mean(gaps.low) : null;

    let dot: number;
    let bias: number;
    if (dotLike !== null && elementGap !== null) {
      dot = (dotLike + elementGap) / 2;
      bias = (dotLike - elementGap) / 2;
    } else if (dotLike !== null && dashLike !== null) {
      dot = (dashLike - dotLike) / 2;
      bias = dotLike - dot;
    } else if (dotLike !== null) {
      bias = this.bias;
      dot = dotLike - bias;
    } else {
      bias = this.bias;
      dot = (dashLike! - bias) / 3;
    }
    if (!(dot > 0)) return;
    this.dot = dot;
    this.bias = Math.min(BIAS_RANGE[1] * dot, Math.max(BIAS_RANGE[0] * dot, bias));
  }

  /** キーを上げたまま時間がたったら文字・語の区切りを出す。定期的に呼ぶ */
  tick(t: number): DecodeEvent[] {
    const out: DecodeEvent[] = [];
    if (this.downAt !== null || this.upAt === null) return out;
    const silence = t - this.upAt;
    if (this.pending.length > 0 && silence >= this.charThreshold) out.push(...this.flush());
    if (this.wordPending && silence >= this.wordThreshold) {
      out.push({ type: "word" });
      this.wordPending = false;
    }
    return out;
  }

  /** 確定していない符号を、今の推定で区切って文字にする */
  private flush(): DecodeEvent[] {
    const out: DecodeEvent[] = [];
    const { dot, bias, charThreshold } = this;
    let group: { start: number; end: number }[] = [];
    const emit = () => {
      const marks = group.map((m) => m.end - m.start);
      const code = marks.map((d) => this.classify(d)).join("");
      const gaps = group.slice(1).map((m, i) => m.start - group[i].end);
      out.push({ type: "char", char: FROM_CODE[code] ?? null, code, start: group[0].start, end: group.at(-1)!.end, marks, gaps, dot, bias });
    };
    this.pending.forEach((m, i) => {
      const gap = i > 0 ? m.start - this.pending[i - 1].end : 0;
      if (gap >= charThreshold) {
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

function push(list: number[], value: number, max: number): void {
  list.push(value);
  if (list.length > max) list.shift();
}

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** 下位 1/4 の長さ（ふつうは短点）に比べて極端に短いもの（雑音）を除く */
function withoutTiny(values: readonly number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length / 4)];
  return sorted.filter((d) => d >= MIN_PART * q1);
}

/**
 * 長さの比が一番大きく開くところで 2 群に分ける。比が SPLIT_RATIO に届かなければ全部 low。
 * 少数の外れ値だけで 1 群を作る分け方は選ばない
 */
export function splitClusters(values: readonly number[]): { low: number[]; high: number[] } {
  const sorted = [...values].sort((a, b) => a - b);
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
  return split < 0 ? { low: sorted, high: [] } : { low: sorted.slice(0, split + 1), high: sorted.slice(split + 1) };
}

/**
 * 符号の長さの一覧から短点長を推定する（伸びは考えない）。
 * 短点と長点の 2 群に分け、長点は 1/3 にして平均する。1 群しかないときは、前回の推定に近い解釈を選ぶ
 */
export function estimateDot(marks: readonly number[], prev: number): number {
  if (marks.length === 0) return prev;
  const { low, high } = splitClusters(withoutTiny(marks));
  if (high.length > 0) return (low.reduce((a, b) => a + b, 0) + high.reduce((a, b) => a + b / 3, 0)) / (low.length + high.length);
  const m = mean(low);
  return Math.abs(Math.log(m / prev)) <= Math.abs(Math.log(m / 3 / prev)) ? m : m / 3;
}
