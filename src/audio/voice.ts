import { MORSE } from "./code";
import type { DecodeEvent } from "./decoder";
import { MicCapture, type MicProcessing } from "./mic";

const FROM_CODE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(MORSE).map(([ch, code]) => [code, ch]),
);

/** 声の検出の調整値（送信実験で変えられる） */
export interface VoiceTuning {
  /** 声ありとみなす、雑音に対する強さ（dB） */
  onDb: number;
  /** 音節の山からこれだけ下がって（dB）また上がれば、次の音節の出だしとみなす（「タラ」の「ラ」） */
  dipDb: number;
  /** 文字の区切りとみなす無音の長さ（秒） */
  charGap: number;
}

export const DEFAULT_TUNING: VoiceTuning = { onDb: 15, dipDb: 6, charGap: 0.12 };

/** 解析の間隔と、強さを測る窓の長さ（秒） */
const HOP = 0.005;
const WINDOW_HOPS = 4;
/** 声なしに戻る、雑音に対する強さ（dB） */
const OFF_DB = 8;
/** 下がりから上がり直したとみなす量（dB） */
const RISE_DB = 3;
/** これより短い音節や変化は無視する（秒） */
const MIN_SYLLABLE = 0.05;
const MIN_CHANGE = 0.01;
/** 声の帯域（Hz）。「t」の破裂音（高い帯域）で閉鎖の無音が埋まらないよう、上は低めにする */
const BAND: [number, number] = [150, 1500];

/** 音節 1 つの出だしか終わり（時刻は入力の先頭からの秒） */
export interface VoiceEvent {
  down: boolean;
  t: number;
  /** 終わりのときだけ。次の音節の出だし（下がり）で終わったか。false なら声が途切れた */
  split?: boolean;
  /** 終わりのときだけ。その音節の山からの下がり（dB） */
  dipDb?: number;
}

/** 解析フレーム 1 つ分の結果（表示用） */
export interface VoiceFrame {
  t: number;
  /** 声の帯域の強さ（dBFS） */
  db: number;
  /** 雑音の強さ（dBFS） */
  noiseDb: number;
  /** 声ありと判定したか */
  on: boolean;
  /** このフレームで音節が始まったか */
  onset: boolean;
}

/**
 * 「タ」「ラ」と唱える声から、音節の出だしと終わりを検出する。
 * 声の帯域の強さ（dB）を HOP 秒ごとに求め、
 * - 雑音より onDb 強くなったら声あり（音節の始まり）、雑音 + OFF_DB を下回ったら声なし（音節の終わり）
 * - 声ありのまま、音節の山から dipDb 下がって RISE_DB 上がり直したら、いちばん下がったところで次の音節が始まったとする。
 *   「タ」は「t」の閉鎖でほぼ無音になるので前者、「ラ」は舌が触れて少し弱まるだけなので後者で拾う
 */
export class VoiceDetector {
  tuning: VoiceTuning;
  private readonly hopLen: number;
  private readonly filters: Biquad[];
  private readonly hops: number[] = [];
  private sinceHop = 0;
  private acc = 0;
  private count = 0;
  private noise: number | null = null;
  private state = false;
  private pending = 0;
  private start = 0;
  /** 今の音節の山の強さと、山のあとの一番下がったところ */
  private peak = -Infinity;
  private dip: { db: number; t: number } | null = null;

  constructor(readonly sampleRate: number, tuning: VoiceTuning = DEFAULT_TUNING) {
    this.tuning = tuning;
    this.hopLen = Math.round(sampleRate * HOP);
    this.filters = [highpass(sampleRate, BAND[0]), highpass(sampleRate, BAND[0]), lowpass(sampleRate, BAND[1]), lowpass(sampleRate, BAND[1])];
  }

  get time(): number {
    return this.count / this.sampleRate;
  }

  get voiced(): boolean {
    return this.state;
  }

  process(samples: Float32Array): { events: VoiceEvent[]; frames: VoiceFrame[] } {
    const events: VoiceEvent[] = [];
    const frames: VoiceFrame[] = [];
    for (let i = 0; i < samples.length; i++) {
      let x = samples[i];
      for (const f of this.filters) x = f.run(x);
      this.acc += x * x;
      this.count++;
      if (++this.sinceHop === this.hopLen) {
        this.hops.push(this.acc / this.hopLen);
        if (this.hops.length > WINDOW_HOPS) this.hops.shift();
        this.sinceHop = 0;
        this.acc = 0;
        this.analyze(events, frames);
      }
    }
    return { events, frames };
  }

  private analyze(events: VoiceEvent[], frames: VoiceFrame[]): void {
    const power = this.hops.reduce((a, b) => a + b, 0) / this.hops.length;
    const db = 10 * Math.log10(power + 1e-12);
    // 窓の中央の時刻
    const t = this.time - (this.hops.length * HOP) / 2;
    this.noise ??= db;
    const { onDb, dipDb } = this.tuning;
    const raw = this.state ? db > this.noise + OFF_DB : db > this.noise + onDb;
    if (!this.state && !raw) {
      // 雑音は下がるときは速く、上がるときはゆっくり追う
      this.noise += (db < this.noise ? HOP / 0.05 : HOP / 3) * (db - this.noise);
    }
    let onset = false;
    const minChange = Math.round(MIN_CHANGE / HOP);
    if (raw !== this.state) {
      if (++this.pending >= minChange) {
        const at = t - ((this.pending - 1) * HOP);
        this.pending = 0;
        this.state = raw;
        if (raw) {
          this.begin(at, db);
          events.push({ down: true, t: at });
          onset = true;
        } else {
          events.push({ down: false, t: at, split: false, dipDb: this.peak - db });
        }
      }
    } else {
      this.pending = 0;
      if (this.state) {
        if (this.dip === null) {
          this.peak = Math.max(this.peak, db);
          if (db < this.peak - dipDb) this.dip = { db, t };
        } else if (db < this.dip.db) {
          this.dip = { db, t };
        } else if (db > this.dip.db + RISE_DB && this.dip.t - this.start >= MIN_SYLLABLE) {
          const depth = this.peak - this.dip.db;
          events.push({ down: false, t: this.dip.t, split: true, dipDb: depth });
          events.push({ down: true, t: this.dip.t });
          this.begin(this.dip.t, db);
          onset = true;
        } else if (db >= this.peak - dipDb / 2) {
          // 少し揺れただけで山に戻った
          this.dip = null;
          this.peak = Math.max(this.peak, db);
        }
      }
    }
    frames.push({ t, db, noiseDb: this.noise, on: this.state, onset });
  }

  private begin(t: number, db: number): void {
    this.start = t;
    this.peak = db;
    this.dip = null;
  }
}

/** 音節 1 つ（秒） */
export interface Syllable {
  start: number;
  end: number;
  /** 次の音節の出だしで終わったか（「タラ」の「タ」） */
  split: boolean;
  dipDb: number;
}

/** 文字 1 つ分の音節（記録・表示用） */
export interface VoiceChar {
  char: string | null;
  code: string;
  syllables: Syllable[];
  /** 各音節の長さ（次の音節の出だしまで。最後は声の終わりまで） */
  lengths: number[];
  /** 短点と長点を分けた長さ */
  threshold: number;
  /** 前の文字の最後の音節の終わりからの無音（最初は null） */
  gapBefore: number | null;
}

/** 短点・長点の長さの推定に使う直近の音節の数 */
const RECENT = 24;
/** 短点と長点の 2 群に分かれているとみなす長さの比（声は 3 倍にはならない） */
const SPLIT_RATIO = 1.4;

/**
 * 音節の並びからモールス符号を復元する。
 * 音節の長さ（次の音節の出だしまで）を短い群と長い群に分けて短点・長点とし、
 * charGap 以上の無音で文字を区切る（語の区切りはその 3.5 倍）
 */
export class VoiceDecoder {
  /** 短点と長点を分ける長さ（秒） */
  threshold = 0.2;
  /** 推定した短点・長点の長さ（秒） */
  dotLen = 0.12;
  dashLen = 0.3;
  charGap: number;
  private readonly recent: number[] = [];
  private pending: Syllable[] = [];
  private downAt: number | null = null;
  private lastEnd: number | null = null;
  private wordPending = false;
  private gapBefore: number | null = null;

  constructor(charGap = DEFAULT_TUNING.charGap, private readonly onChar?: (c: VoiceChar) => void) {
    this.charGap = charGap;
  }

  /** 短点の長さを 1.2 / WPM の短点長とみなした速度（目安） */
  get wpm(): number {
    return 1.2 / this.dotLen;
  }

  /** 送信実験の統計の表示用（伸びは推定しない） */
  get dot(): number {
    return this.dotLen;
  }

  get bias(): number {
    return 0;
  }

  get wordGap(): number {
    return Math.max(0.4, 3.5 * this.charGap);
  }

  get pendingCode(): string {
    return lengthsOf(this.pending).map((d) => this.classify(d)).join("");
  }

  private classify(d: number): "." | "-" {
    return d < this.threshold ? "." : "-";
  }

  keyDown(t: number): DecodeEvent[] {
    if (this.downAt !== null) return [];
    const out = this.tick(t);
    this.downAt = t;
    return out;
  }

  keyUp(t: number, split: boolean, dipDb: number): DecodeEvent[] {
    if (this.downAt === null) return [];
    const start = this.downAt;
    this.downAt = null;
    // 短すぎる声は雑音として捨てる（直前の音節につながっていたら、その音節を伸ばす）
    if (t - start < MIN_SYLLABLE) {
      const last = this.pending.at(-1);
      if (last && last.split && last.end === start) Object.assign(last, { end: t, split });
      return [];
    }
    this.pending.push({ start, end: t, split, dipDb });
    this.lastEnd = t;
    this.wordPending = true;
    return [];
  }

  tick(t: number): DecodeEvent[] {
    const out: DecodeEvent[] = [];
    if (this.downAt !== null || this.lastEnd === null) return out;
    const silence = t - this.lastEnd;
    if (this.pending.length > 0 && silence >= this.charGap) {
      out.push(...this.flush());
      this.gapBefore = silence;
    }
    if (this.wordPending && silence >= this.wordGap) {
      out.push({ type: "word" });
      this.wordPending = false;
    }
    // 文字の区切りのあと、次の音節までの無音を測り続ける
    if (this.pending.length === 0 && this.gapBefore !== null) this.gapBefore = silence;
    return out;
  }

  private flush(): DecodeEvent[] {
    const syllables = this.pending;
    this.pending = [];
    const lengths = lengthsOf(syllables);
    for (const d of lengths) push(this.recent, d, RECENT);
    this.estimate();
    const code = lengths.map((d) => this.classify(d)).join("");
    const char = FROM_CODE[code] ?? null;
    this.onChar?.({ char, code, syllables, lengths, threshold: this.threshold, gapBefore: this.gapBefore });
    const out: DecodeEvent[] = [];
    lengths.forEach((d, i) => {
      if (i > 0) {
        const gap = syllables[i].start - syllables[i - 1].end;
        out.push({ type: "gap", kind: "element", duration: gap, units: gap / this.dotLen });
      }
      out.push({ type: "mark", kind: this.classify(d), duration: d, units: d / this.dotLen });
    });
    const gaps = syllables.slice(1).map((s, i) => s.start - syllables[i].end);
    out.push({
      type: "char", char, code, start: syllables[0].start, end: syllables.at(-1)!.end,
      marks: lengths, gaps, dot: this.dotLen, bias: 0,
    });
    return out;
  }

  /** 直近の音節の長さを 2 群に分け、その間（幾何平均）を短点と長点の境にする */
  private estimate(): void {
    const sorted = [...this.recent].sort((a, b) => a - b);
    const minCluster = sorted.length >= 5 ? Math.ceil(sorted.length * 0.15) : 1;
    let split = -1;
    let best = SPLIT_RATIO;
    for (let i = minCluster - 1; i < sorted.length - minCluster; i++) {
      const ratio = sorted[i + 1] / sorted[i];
      if (ratio >= best) {
        best = ratio;
        split = i;
      }
    }
    if (split < 0) {
      // 1 群しかないときは、今の境のどちら側かで短点・長点の長さだけ合わせる
      const m = mean(sorted);
      if (m < this.threshold) this.dotLen = m;
      else this.dashLen = m;
    } else {
      this.dotLen = mean(sorted.slice(0, split + 1));
      this.dashLen = mean(sorted.slice(split + 1));
    }
    this.threshold = Math.sqrt(this.dotLen * this.dashLen);
  }
}

/** 音節の長さ。次の音節が続いていれば（「タラ」「タタ」）その出だしまで、最後は声の終わりまで */
function lengthsOf(syllables: readonly Syllable[]): number[] {
  return syllables.map((s, i) => (i + 1 < syllables.length ? syllables[i + 1].start : s.end) - s.start);
}

function push(list: number[], value: number, max: number): void {
  list.push(value);
  if (list.length > max) list.shift();
}

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export interface VoiceHandlers {
  onEvents?: (events: DecodeEvent[], now: number) => void;
  onFrames?: (frames: VoiceFrame[]) => void;
  onChar?: (c: VoiceChar) => void;
  onEnded?: () => void;
}

/** 録音しておく最大の長さ（秒） */
const RECORD_MAX = 120;

/** マイクから唱える声を聞き、符号を復元する。調べるために入力を録音しておく */
export class VoiceListener {
  readonly detector: VoiceDetector;
  decoder: VoiceDecoder;
  rmsDb = -Infinity;
  private chunks: Float32Array[] = [];
  private recorded = 0;

  private constructor(
    readonly mic: MicCapture,
    private tuning: VoiceTuning,
    private readonly handlers: VoiceHandlers,
  ) {
    this.detector = new VoiceDetector(mic.ctx.sampleRate, tuning);
    this.decoder = new VoiceDecoder(tuning.charGap, handlers.onChar);
    mic.track.addEventListener("ended", () => handlers.onEnded?.());
  }

  /** ユーザー操作のハンドラ内で呼ぶこと */
  static async open(processing: MicProcessing, tuning: VoiceTuning, handlers: VoiceHandlers): Promise<VoiceListener> {
    let listener: VoiceListener | null = null;
    const mic = await MicCapture.open(processing, (s) => listener?.onSamples(s));
    listener = new VoiceListener(mic, tuning, handlers);
    return listener;
  }

  get now(): number {
    return this.detector.time;
  }

  get keyDown(): boolean {
    return this.detector.voiced;
  }

  /** 録音してある長さ（秒） */
  get recordedSec(): number {
    return this.recorded / this.mic.ctx.sampleRate;
  }

  setTuning(tuning: VoiceTuning): void {
    this.tuning = tuning;
    this.detector.tuning = tuning;
    this.decoder.charGap = tuning.charGap;
  }

  resetDecoder(): void {
    const { threshold, dotLen, dashLen } = this.decoder;
    this.decoder = new VoiceDecoder(this.tuning.charGap, this.handlers.onChar);
    Object.assign(this.decoder, { threshold, dotLen, dashLen });
  }

  /** 録音を捨てる */
  clearRecording(): void {
    this.chunks = [];
    this.recorded = 0;
  }

  /** 録音（直近 RECORD_MAX 秒まで）を WAV にする */
  recording(): Blob {
    return encodeWav(this.chunks, this.mic.ctx.sampleRate);
  }

  close(): void {
    this.mic.close();
  }

  private onSamples(samples: Float32Array): void {
    let sum = 0;
    for (const x of samples) sum += x * x;
    this.rmsDb = 10 * Math.log10(sum / samples.length + 1e-12);
    this.chunks.push(samples.slice());
    this.recorded += samples.length;
    const max = RECORD_MAX * this.mic.ctx.sampleRate;
    while (this.recorded - this.chunks[0].length >= max) this.recorded -= this.chunks.shift()!.length;

    const { events, frames } = this.detector.process(samples);
    const out: DecodeEvent[] = [];
    for (const e of events) {
      out.push(...(e.down ? this.decoder.keyDown(e.t) : this.decoder.keyUp(e.t, e.split ?? false, e.dipDb ?? 0)));
    }
    out.push(...this.decoder.tick(this.detector.time));
    if (frames.length > 0) this.handlers.onFrames?.(frames);
    if (out.length > 0) this.handlers.onEvents?.(out, this.detector.time);
  }
}

/** 16 ビット・モノラルの WAV */
export function encodeWav(chunks: readonly Float32Array[], sampleRate: number): Blob {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new ArrayBuffer(44 + 2 * n);
  const v = new DataView(buf);
  const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + 2 * n, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, 2 * n, true);
  let at = 44;
  for (const c of chunks) {
    for (const x of c) {
      v.setInt16(at, Math.round(Math.max(-1, Math.min(1, x)) * 32767), true);
      at += 2;
    }
  }
  return new Blob([buf], { type: "audio/wav" });
}

/** 2 次のフィルタ（RBJ のクックブック、Q = 1/√2） */
class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(
    private readonly b0: number,
    private readonly b1: number,
    private readonly b2: number,
    private readonly a1: number,
    private readonly a2: number,
  ) {}

  run(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

function biquad(sampleRate: number, freq: number, high: boolean): Biquad {
  const w = (2 * Math.PI * freq) / sampleRate;
  const alpha = Math.sin(w) / Math.SQRT2;
  const cos = Math.cos(w);
  const a0 = 1 + alpha;
  const b1 = high ? -(1 + cos) : 1 - cos;
  const b0 = high ? (1 + cos) / 2 : (1 - cos) / 2;
  return new Biquad(b0 / a0, b1 / a0, b0 / a0, (-2 * cos) / a0, (1 - alpha) / a0);
}

function highpass(sampleRate: number, freq: number): Biquad {
  return biquad(sampleRate, freq, true);
}

function lowpass(sampleRate: number, freq: number): Biquad {
  return biquad(sampleRate, freq, false);
}
