import type { CharTiming } from "../audio/decoder";
import { align, type CharMark } from "./scoring";

/**
 * 電気通信術（モールス送信）の採点基準に沿った採点。
 * 誤字・脱字・冗字は 1 字 3 点、符号不明りょうは 1 字 1 点、未送信は 2 字までごとに 1 点、
 * 訂正は 3 回までごとに 1 点。品位のうち、符号間隔 6 点相当以上・語間 14 点相当以上は 1 回 1 点
 */
export const SEND_PENALTY = { wrong: 3, missing: 3, extra: 3, unclear: 1 } as const;

/** 復号した 1 文字。符号表にない符号なら char は null */
export interface SentChar extends CharTiming {
  char: string | null;
  code: string;
}

export type SendMark = CharMark | "unsent";

export interface SendScore {
  /** お題の各文字の判定。unsent は時間切れで送っていない */
  marks: SendMark[];
  /** お題の各文字に対応する送信（文字。符号表にない符号は符号のまま。対応がなければ null） */
  sentAt: (string | null)[];
  /** お題の各文字が符号不明りょうか（正しく送った文字だけ判定する） */
  unclearAt: boolean[];
  wrong: number;
  missing: number;
  extra: number;
  unclear: number;
  unsent: number;
  corrections: number;
  /** 文字間が 6 短点以上だった回数 */
  longCharGaps: number;
  /** 語間が 14 短点以上だった回数 */
  longWordGaps: number;
  deduction: number;
  /** 100 点から減点した得点（0 点未満にはしない） */
  points: number;
}

export interface Spread {
  mean: number;
  /** 変動係数（標準偏差 ÷ 平均） */
  cv: number;
  min: number;
  max: number;
  n: number;
}

/** 符号の質。長さは推定短点長を 1 とした値 */
export interface SendQuality {
  dot: Spread | null;
  dash: Spread | null;
  /** 符号内の間 */
  element: Spread | null;
  charGap: Spread | null;
  wordGap: Spread | null;
  /** 長点 ÷ 短点 */
  dashRatio: number | null;
  /** 送信速度（字/分） */
  cpm: number | null;
  /** 前半・後半の送信速度（字/分） */
  cpmHalves: [number, number] | null;
  /** 品位の目安になる注意 */
  notes: string[];
}

export interface SendResult {
  score: SendScore;
  quality: SendQuality;
}

export interface SendOptions {
  /** 時間制（模擬試験）。お題の最後のほうで送っていない字を脱字ではなく未送信とする */
  timed?: boolean;
  /** 1 組の字数（語間の判定に使う） */
  groupLen?: number;
}

/** 訂正符号 HH（短点 8 個以上） */
export function isCorrection(code: string): boolean {
  return /^\.{8,}$/.test(code);
}

/** 訂正のとき、直前の何字までを取り消したとみなすか */
const MAX_UNDO = 5;
/** 品位で減点する間隔（短点単位） */
const LONG_CHAR_GAP = 6;
const LONG_WORD_GAP = 14;
/** 注意を出す目安 */
const TIGHT_CHAR_GAP = 2.5;
const SHORT_WORD_GAP = 5;
const UNEVEN_CV = 0.25;
const DASH_RATIO_RANGE: [number, number] = [2.5, 3.6];
const SPEED_CHANGE = 0.15;

interface Kept {
  c: SentChar;
  /** 直前に訂正符号があった（その前との間隔は評価しない） */
  afterCorrection: boolean;
}

/** 送信をお題に対応付けて採点し、符号の質を分析する */
export function evaluateSend(target: string, sent: readonly SentChar[], opts: SendOptions = {}): SendResult {
  const groupLen = opts.groupLen ?? 5;
  const { kept, corrections } = applyCorrections(target, sent);
  const steps = alignSent(target, kept.map((k) => k.c));

  const n = target.length;
  const marks: SendMark[] = new Array(n);
  const sentAt: (string | null)[] = new Array(n).fill(null);
  const unclearAt: boolean[] = new Array(n).fill(false);
  /** 送信の各文字が対応したお題の位置 */
  const targetOf: (number | null)[] = new Array(kept.length).fill(null);
  let wrong = 0;
  let missing = 0;
  let extra = 0;
  let unclear = 0;
  for (const { t, s } of steps) {
    if (t === null) {
      extra++;
      continue;
    }
    if (s === null) {
      marks[t] = "missing";
      missing++;
      continue;
    }
    const c = kept[s].c;
    targetOf[s] = t;
    sentAt[t] = c.char ?? c.code;
    if (c.char === target[t]) {
      marks[t] = "ok";
      if (isUnclear(c)) {
        unclearAt[t] = true;
        unclear++;
      }
    } else {
      marks[t] = "wrong";
      wrong++;
    }
  }

  // 時間切れで送れなかった末尾は、脱字ではなく未送信
  let unsent = 0;
  if (opts.timed) {
    for (let t = n - 1; t >= 0 && marks[t] === "missing"; t--) {
      marks[t] = "unsent";
      unsent++;
    }
    missing -= unsent;
  }

  // 文字と文字の間。お題の組の先頭に対応した文字の前は語間
  const charGaps: number[] = [];
  const wordGaps: number[] = [];
  for (let i = 1; i < kept.length; i++) {
    if (kept[i].afterCorrection) continue;
    const c = kept[i].c;
    const units = (c.start - kept[i - 1].c.end) / c.dot;
    const t = targetOf[i];
    const isWord = t !== null ? t % groupLen === 0 : units >= SHORT_WORD_GAP;
    (isWord ? wordGaps : charGaps).push(units);
  }
  const longCharGaps = charGaps.filter((u) => u >= LONG_CHAR_GAP).length;
  const longWordGaps = wordGaps.filter((u) => u >= LONG_WORD_GAP).length;

  const deduction =
    (wrong * SEND_PENALTY.wrong + missing * SEND_PENALTY.missing + extra * SEND_PENALTY.extra) +
    unclear * SEND_PENALTY.unclear +
    Math.ceil(unsent / 2) +
    Math.ceil(corrections / 3) +
    longCharGaps +
    longWordGaps;

  return {
    score: {
      marks,
      sentAt,
      unclearAt,
      wrong,
      missing,
      extra,
      unclear,
      unsent,
      corrections,
      longCharGaps,
      longWordGaps,
      deduction,
      points: Math.max(0, 100 - deduction),
    },
    quality: analyze(kept.map((k) => k.c), charGaps, wordGaps),
  };
}

function alignSent(target: string, chars: readonly SentChar[]) {
  return align(target.length, chars.length, {
    pair: (t, s) => (chars[s].char === target[t] ? 0 : SEND_PENALTY.wrong),
    skipTarget: () => SEND_PENALTY.missing,
    skipInput: () => SEND_PENALTY.extra,
  });
}

function alignCost(target: string, chars: readonly SentChar[]): number {
  let cost = 0;
  for (const { t, s } of alignSent(target, chars)) {
    if (t === null) cost += SEND_PENALTY.extra;
    else if (s === null) cost += SEND_PENALTY.missing;
    else if (chars[s].char !== target[t]) cost += SEND_PENALTY.wrong;
  }
  return cost;
}

/**
 * 訂正符号を取り除き、その直前の何字かを取り消す。取り消す字数は、
 * 規則上は 2、3 字前に戻って送り直すはずだが、実際に何字戻ったかは分からないので、
 * 訂正符号ごとに先頭から順に 0〜MAX_UNDO 字を試し、お題との減点が最小になる字数を選ぶ
 */
function applyCorrections(target: string, sent: readonly SentChar[]): { kept: Kept[]; corrections: number } {
  let kept: Kept[] = [];
  let corrections = 0;
  let afterCorrection = false;
  sent.forEach((c, i) => {
    if (!isCorrection(c.code)) {
      kept.push({ c, afterCorrection });
      afterCorrection = false;
      return;
    }
    corrections++;
    afterCorrection = true;
    // 以降の訂正符号は取り除くだけにして評価する
    const rest = sent.slice(i + 1).filter((x) => !isCorrection(x.code));
    let best = 0;
    let bestCost = Infinity;
    for (let k = 0; k <= Math.min(MAX_UNDO, kept.length); k++) {
      const chars = [...kept.slice(0, kept.length - k).map((x) => x.c), ...rest];
      const cost = alignCost(target, chars);
      if (cost < bestCost) {
        bestCost = cost;
        best = k;
      }
    }
    kept = kept.slice(0, kept.length - best);
  });
  return { kept, corrections };
}

/** 1 符号の中に、すぐ近くの長点の 1/2〜2/3 の長さの符号があるか */
export function isUnclear(c: CharTiming): boolean {
  const isDash = c.marks.map((d) => d >= 2 * c.dot);
  return c.marks.some((d, i) => {
    let nearest = -1;
    for (let j = 0; j < c.marks.length; j++) {
      if (j === i || !isDash[j]) continue;
      if (nearest < 0 || Math.abs(j - i) < Math.abs(nearest - i)) nearest = j;
    }
    if (nearest < 0) return false;
    const ratio = d / c.marks[nearest];
    return ratio >= 1 / 2 && ratio <= 2 / 3;
  });
}

function spread(xs: readonly number[]): Spread | null {
  if (xs.length === 0) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { mean, cv: mean > 0 ? sd / mean : 0, min: Math.min(...xs), max: Math.max(...xs), n: xs.length };
}

function analyze(chars: readonly SentChar[], charGaps: number[], wordGaps: number[]): SendQuality {
  const dots: number[] = [];
  const dashes: number[] = [];
  const elements: number[] = [];
  for (const c of chars) {
    c.marks.forEach((d) => (d >= 2 * c.dot ? dashes : dots).push(d / c.dot));
    c.gaps.forEach((g) => elements.push(g / c.dot));
  }
  const dot = spread(dots);
  const dash = spread(dashes);
  const dashRatio = dot && dash ? dash.mean / dot.mean : null;
  const charGap = spread(charGaps);
  const wordGap = spread(wordGaps);

  const cpmOf = (from: number, to: number) => {
    const sec = chars[to].start - chars[from].start;
    return sec > 0 ? ((to - from) * 60) / sec : null;
  };
  const cpm = chars.length >= 2 ? cpmOf(0, chars.length - 1) : null;
  let cpmHalves: [number, number] | null = null;
  if (chars.length >= 10) {
    const half = Math.floor(chars.length / 2);
    const first = cpmOf(0, half);
    const second = cpmOf(half, chars.length - 1);
    if (first !== null && second !== null) cpmHalves = [first, second];
  }

  const notes: string[] = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const tight = charGaps.filter((u) => u < TIGHT_CHAR_GAP).length;
  if (tight > 0) notes.push(`文字間が ${TIGHT_CHAR_GAP} 短点未満のところが ${tight} か所あります（無間隔ぎみ）`);
  const short = wordGaps.filter((u) => u < SHORT_WORD_GAP).length;
  if (short > 0) notes.push(`語間が ${SHORT_WORD_GAP} 短点未満のところが ${short} か所あります（語間が短い）`);
  if (charGap && charGap.n >= 4 && charGap.cv > UNEVEN_CV) notes.push(`文字間がそろっていません（ばらつき ${pct(charGap.cv)}）`);
  if (wordGap && wordGap.n >= 3 && wordGap.cv > UNEVEN_CV) notes.push(`語間がそろっていません（ばらつき ${pct(wordGap.cv)}）`);
  if (dashRatio !== null && (dashRatio < DASH_RATIO_RANGE[0] || dashRatio > DASH_RATIO_RANGE[1])) {
    notes.push(`長点が短点の ${dashRatio.toFixed(1)} 倍です（標準は 3 倍）`);
  }
  if (cpmHalves) {
    const change = cpmHalves[1] / cpmHalves[0] - 1;
    if (Math.abs(change) > SPEED_CHANGE) {
      notes.push(`後半の速度が前半より ${pct(Math.abs(change))} ${change > 0 ? "速く" : "遅く"}なっています`);
    }
  }
  return { dot, dash, element: spread(elements), charGap, wordGap, dashRatio, cpm, cpmHalves, notes };
}
