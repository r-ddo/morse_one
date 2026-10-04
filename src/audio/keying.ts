/** キーの上げ下げ（時刻は入力の先頭からの秒） */
export interface KeyEvent {
  down: boolean;
  t: number;
  /**
   * キーを上げたときだけ。その符号の間、目的の周波数付近に鋭いピークがあったか。
   * false なら話し声などの外の音とみなして捨ててよい
   */
  tonal?: boolean;
  /** キーを上げたときだけ。その符号に鋭く安定したピークがあれば、その周波数（Hz）。周波数の合わせ直しに使う */
  peakFreq?: number;
}

/** 解析フレーム 1 つ分の結果（表示用） */
export interface DetectorFrame {
  t: number;
  /** 目的の周波数の振幅（フルスケールの正弦波で 1） */
  mag: number;
  /** キーが下がっている（トーンあり）と判定したか */
  on: boolean;
  /** 今の状態から変わる振幅（上げているならキーを下げたとみなす振幅、下げているなら上げたとみなす振幅） */
  onLevel: number;
}

export interface DetectorOptions {
  /** 解析窓の長さ（ミリ秒）。長いほど周波数の選択性が上がり、時間方向にはぼける */
  windowMs?: number;
  /** 解析の間隔（ミリ秒） */
  hopMs?: number;
  /** これより短い変化はチャタリングや雑音として無視する（ミリ秒） */
  minChangeMs?: number;
  /** キーを下げたとみなすのに必要な、雑音に対する振幅の比 */
  minRatio?: number;
}

/** キーを上げたとみなす、その符号の最大振幅に対する割合 */
const OFF_FRACTION = 0.5;
/** 符号の直後は、その符号の最大振幅にこの割合をかけた「残響の目安」を超えないとキーを下げたとみなさない */
const TAIL_GUARD = 0.5;
/** 残響の目安が減衰する時定数（秒） */
const TAIL_GUARD_TAU = 0.15;
/** キーを下げたとみなすのに必要な、目的の周波数がエネルギーに占める割合 */
const MIN_PURITY = 0.25;
/** 符号の周波数を確かめる区間の最大長と、符号の端から除く長さ（秒） */
const CHECK_MAX = 0.048;
const CHECK_MARGIN = 0.004;
/** 符号の周波数のピークを探す範囲と、検出の周波数からのずれの許容（Hz） */
const CHECK_RANGE = 60;
const CHECK_TOLERANCE = 15;
/** 長い符号の前半と後半でピークの周波数が動いてよい幅（Hz） */
const CHECK_DRIFT = 6;
/** 鋭いピークとみなす、ピークと両隣（ハン窓の最初のゼロ点）の振幅の比 */
const SHARPNESS = 3;
/** 符号の周波数を確かめるために残しておく入力（秒） */
const HISTORY = 0.5;

/**
 * 単一周波数のトーンのオン/オフを検出する。
 * hopMs ごとに直近 windowMs の入力へハン窓をかけ、Goertzel で目的の周波数の振幅を求める。
 *
 * - キーを下げた: 雑音の minRatio 倍を超え、純音らしい（目的の周波数がエネルギーの大半を占める）。
 *   iOS の音声処理は無音のあと入力を絞っていて最初の符号が弱くなるので、トーンの強さではなく雑音を基準にする。
 *   ただし符号の直後は、残響を拾い直さないよう、その符号の強さから減衰していく目安も超える必要がある
 * - キーを上げた: その符号の最大振幅の半分を下回った。弱い符号は弱いなりに、残響の尾は早めに切れる
 * - キーを上げたとき、その符号の区間を長めの窓で分析し、検出の周波数ちょうどに鋭いピークがあって、
 *   符号の前半と後半で周波数が動いていないかを返す。練習機のトーンは周波数が一定だが、
 *   話し声の倍音は検出の周波数からずれていたり揺れていたりするので、外の音を見分けられる
 */
export class KeyingDetector {
  private readonly window: Float32Array;
  /** 直近 HISTORY 秒の入力（リングバッファ） */
  private readonly history: Float32Array;
  private readonly hopLen: number;
  private readonly minChangeFrames: number;
  private readonly minRatio: number;
  private readonly noiseDown: number;
  private readonly noiseUp: number;
  private readonly norm: number;
  /** 窓の 2 乗和 */
  private readonly windowPower: number;
  private coeff = 0;
  private _freq = 0;
  /** これまでに受け取ったサンプル数 */
  private count = 0;
  private sinceHop = 0;
  private noise = -1;
  private state = false;
  /** 判定が今の状態と違うまま続いているフレーム数 */
  private pending = 0;
  /** 今の（直前の）符号の最大振幅と、キーを下げた・上げた時刻 */
  private markPeak = 0;
  private markStart = 0;
  private markEnd = -Infinity;

  constructor(
    readonly sampleRate: number,
    freq: number,
    opts: DetectorOptions = {},
  ) {
    const len = Math.max(4, Math.round((sampleRate * (opts.windowMs ?? 8)) / 1000));
    this.window = hann(len);
    this.norm = 2 / this.window.reduce((a, b) => a + b, 0);
    this.windowPower = this.window.reduce((a, b) => a + b * b, 0);
    this.history = new Float32Array(Math.max(len, Math.ceil(sampleRate * HISTORY)));
    this.hopLen = Math.max(1, Math.round((sampleRate * (opts.hopMs ?? 2)) / 1000));
    const hopSec = this.hopLen / sampleRate;
    this.minChangeFrames = Math.max(1, Math.round((opts.minChangeMs ?? 8) / 1000 / hopSec));
    this.minRatio = opts.minRatio ?? 4;
    // 雑音は下がるときは時定数 0.02 秒、上がるときは 2 秒で追う（間に残る残響を雑音に数えないため）
    this.noiseDown = Math.min(1, hopSec / 0.02);
    this.noiseUp = Math.min(1, hopSec / 2);
    this.setFreq(freq);
  }

  get freq(): number {
    return this._freq;
  }

  get keyDown(): boolean {
    return this.state;
  }

  /** これまでに受け取った入力の長さ（秒） */
  get time(): number {
    return this.count / this.sampleRate;
  }

  setFreq(freq: number): void {
    this._freq = freq;
    this.coeff = 2 * Math.cos((2 * Math.PI * freq) / this.sampleRate);
  }

  process(samples: Float32Array): { events: KeyEvent[]; frames: DetectorFrame[] } {
    const events: KeyEvent[] = [];
    const frames: DetectorFrame[] = [];
    const size = this.history.length;
    for (let i = 0; i < samples.length; i++) {
      this.history[this.count++ % size] = samples[i];
      if (++this.sinceHop === this.hopLen) {
        this.sinceHop = 0;
        if (this.count >= this.window.length) this.analyze(events, frames);
      }
    }
    return { events, frames };
  }

  private analyze(events: KeyEvent[], frames: DetectorFrame[]): void {
    const { history, window, coeff } = this;
    const len = window.length;
    const size = history.length;
    const first = this.count - len;
    let s1 = 0;
    let s2 = 0;
    let energy = 0;
    for (let k = 0; k < len; k++) {
      const x = history[(first + k) % size] * window[k];
      energy += x * x;
      const s0 = x + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const mag = Math.sqrt(Math.max(s1 * s1 + s2 * s2 - coeff * s1 * s2, 0)) * this.norm;
    // 窓の中のエネルギーのうち目的の周波数が占める割合（純音なら 1、白色雑音ならほぼ 0）
    const purity = energy > 0 ? (mag * mag * this.windowPower) / (2 * energy) : 0;
    // 窓の中央の時刻
    const t = (this.count - len / 2) / this.sampleRate;

    if (this.noise < 0) this.noise = mag;
    const guard = this.markPeak * TAIL_GUARD * Math.exp(-(t - this.markEnd) / TAIL_GUARD_TAU);
    const onLevel = Math.max(this.noise * this.minRatio, guard);
    const offLevel = Math.max(this.markPeak * OFF_FRACTION, this.noise * 2);
    if (!this.state && mag < onLevel) {
      this.noise += (mag < this.noise ? this.noiseDown : this.noiseUp) * (mag - this.noise);
    }
    if (this.state) this.markPeak = Math.max(this.markPeak, mag);
    const raw = this.state ? mag > offLevel : mag > onLevel && purity >= MIN_PURITY;

    if (raw !== this.state) {
      if (++this.pending >= this.minChangeFrames) {
        // 変化が始まったフレームを変化の時刻とする
        const at = t - ((this.pending - 1) * this.hopLen) / this.sampleRate;
        this.state = raw;
        this.pending = 0;
        if (raw) {
          this.markPeak = mag;
          this.markStart = at;
          events.push({ down: true, t: at });
        } else {
          this.markEnd = at;
          events.push({ down: false, t: at, ...this.checkMark(this.markStart, at) });
        }
      }
    } else {
      this.pending = 0;
    }
    frames.push({ t, mag, on: this.state, onLevel: this.state ? offLevel : onLevel });
  }

  /**
   * start〜end 秒の入力が練習機のトーンらしいか（クラスの説明を参照）と、鋭く安定したピークの周波数。
   * 短すぎて分からなければトーンとみなす
   */
  private checkMark(start: number, end: number): { tonal: boolean; peakFreq?: number } {
    const sr = this.sampleRate;
    const n = Math.round(CHECK_MAX * sr);
    const first = Math.round((start + CHECK_MARGIN) * sr);
    const last = Math.round((end - CHECK_MARGIN) * sr);
    const oldest = this.count - this.history.length;
    if (last - first < 0.015 * sr || first < oldest) return { tonal: true };
    const late = this.peakIn(Math.max(first, last - n), last);
    if (!late.sharp) return { tonal: false };
    if (last - first >= 2 * n) {
      const early = this.peakIn(first, first + n);
      if (!early.sharp || Math.abs(early.freq - late.freq) > CHECK_DRIFT) return { tonal: false };
    }
    return { tonal: Math.abs(late.freq - this._freq) <= CHECK_TOLERANCE, peakFreq: late.freq };
  }

  /** from〜to サンプルの入力で、検出の周波数付近の一番強いピークの周波数と、それが鋭いか */
  private peakIn(from: number, to: number): { freq: number; sharp: boolean } {
    const sr = this.sampleRate;
    const n = to - from;
    const segment = new Float32Array(n);
    const w = hann(n);
    for (let k = 0; k < n; k++) segment[k] = this.history[(from + k) % this.history.length] * w[k];
    const bin = sr / n;
    let freq = this._freq;
    let peak = -1;
    for (let f = this._freq - CHECK_RANGE; f <= this._freq + CHECK_RANGE; f += bin / 4) {
      const m = goertzel(segment, f / sr);
      if (m > peak) {
        peak = m;
        freq = f;
      }
    }
    const sides = Math.max(goertzel(segment, (freq - 2 * bin) / sr), goertzel(segment, (freq + 2 * bin) / sr));
    return { freq, sharp: peak >= SHARPNESS * sides };
  }
}

function hann(n: number): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
}

/** 周波数 cycles（1 サンプルあたりの周期数）の振幅（相対値） */
function goertzel(x: Float32Array, cycles: number): number {
  const c = 2 * Math.cos(2 * Math.PI * cycles);
  let s1 = 0;
  let s2 = 0;
  for (let k = 0; k < x.length; k++) {
    const s0 = x[k] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(s1 * s1 + s2 * s2 - c * s1 * s2, 0));
}

/** スペクトル（dB）から minHz〜maxHz で一番強いピークを探す。周囲の中央値との差を SNR とする */
export function findTonePeak(
  db: Float32Array,
  binHz: number,
  minHz: number,
  maxHz: number,
): { freq: number; snrDb: number } | null {
  const lo = Math.max(1, Math.ceil(minHz / binHz));
  const hi = Math.min(db.length - 2, Math.floor(maxHz / binHz));
  if (hi <= lo) return null;
  let best = lo;
  for (let i = lo; i <= hi; i++) if (db[i] > db[best]) best = i;
  if (!Number.isFinite(db[best])) return null;
  const band = Array.from(db.subarray(lo, hi + 1)).sort((a, b) => a - b);
  const median = band[Math.floor(band.length / 2)];
  // 放物線補間でビンの間の周波数を推定する
  const [a, b, c] = [db[best - 1], db[best], db[best + 1]];
  const denom = a - 2 * b + c;
  const offset = Number.isFinite(denom) && denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  return { freq: (best + Math.max(-0.5, Math.min(0.5, offset))) * binHz, snrDb: b - median };
}
