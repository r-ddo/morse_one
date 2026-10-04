/** キーの上げ下げ（時刻は入力の先頭からの秒） */
export interface KeyEvent {
  down: boolean;
  t: number;
}

/** 解析フレーム 1 つ分の結果（表示用） */
export interface DetectorFrame {
  t: number;
  /** 目的の周波数の振幅（フルスケールの正弦波で 1） */
  mag: number;
  /** キーが下がっている（トーンあり）と判定したか */
  on: boolean;
  /** トーンありに変わる振幅 */
  onLevel: number;
}

export interface DetectorOptions {
  /** 解析窓の長さ（ミリ秒）。長いほど周波数の選択性が上がり、時間方向にはぼける */
  windowMs?: number;
  /** 解析の間隔（ミリ秒） */
  hopMs?: number;
  /** これより短い変化はチャタリングや雑音として無視する（ミリ秒） */
  minChangeMs?: number;
  /** トーンありとみなすのに必要な、雑音の平均に対するピークの比 */
  minRatio?: number;
}

/** 雑音とピークの間のどこに閾値を置くか（下げ / 上げ） */
const ON_FRACTION = 0.5;
const OFF_FRACTION = 0.3;
/** キーを下げたとみなすのに必要な、目的の周波数がエネルギーに占める割合 */
const MIN_PURITY = 0.25;

/**
 * 単一周波数のトーンのオン/オフを検出する。
 * hopMs ごとに直近 windowMs の入力へハン窓をかけ、Goertzel で目的の周波数の振幅を求める。
 * 雑音の平均とピークを追いかけてその間に閾値（ヒステリシス付き）を置くので、
 * 音量や AGC が変わっても閾値が追従する
 */
export class KeyingDetector {
  private readonly window: Float32Array;
  private readonly ring: Float32Array;
  private readonly hopLen: number;
  private readonly minChangeFrames: number;
  private readonly minRatio: number;
  private readonly noiseAlpha: number;
  private readonly peakDecay: number;
  private readonly norm: number;
  /** 窓の 2 乗和 */
  private readonly windowPower: number;
  /** キーを上げたと判定するまでの遅れ（秒）。閾値が非対称なぶん、下げより遅れて見える */
  private readonly offDelay: number;
  private coeff = 0;
  private _freq = 0;
  /** これまでに受け取ったサンプル数 */
  private count = 0;
  private sinceHop = 0;
  private noise = -1;
  private peak = 0;
  private state = false;
  /** 判定が今の状態と違うまま続いているフレーム数 */
  private pending = 0;

  constructor(
    readonly sampleRate: number,
    freq: number,
    opts: DetectorOptions = {},
  ) {
    const len = Math.max(4, Math.round((sampleRate * (opts.windowMs ?? 8)) / 1000));
    this.window = Float32Array.from({ length: len }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1)));
    this.norm = 2 / this.window.reduce((a, b) => a + b, 0);
    this.windowPower = this.window.reduce((a, b) => a + b * b, 0);
    this.ring = new Float32Array(len);
    this.hopLen = Math.max(1, Math.round((sampleRate * (opts.hopMs ?? 2)) / 1000));
    const hopSec = this.hopLen / sampleRate;
    this.minChangeFrames = Math.max(1, Math.round((opts.minChangeMs ?? 8) / 1000 / hopSec));
    this.minRatio = opts.minRatio ?? 5;
    // 雑音は時定数 0.2 秒で平均する。ピークは 1 秒で半分に下がる
    this.noiseAlpha = Math.min(1, hopSec / 0.2);
    this.peakDecay = 0.5 ** hopSec;
    // 窓の左から x の割合までトーンがあるとき、振幅は x − sin(2πx)/(2π) 倍になる。
    // それが OFF_FRACTION になる x を求め、窓の中央とのずれを遅れとする
    let lo = 0;
    let hi = 0.5;
    for (let i = 0; i < 30; i++) {
      const x = (lo + hi) / 2;
      if (x - Math.sin(2 * Math.PI * x) / (2 * Math.PI) < OFF_FRACTION) lo = x;
      else hi = x;
    }
    this.offDelay = ((0.5 - lo) * len) / sampleRate;
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
    const len = this.ring.length;
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.count++ % len] = samples[i];
      if (++this.sinceHop === this.hopLen) {
        this.sinceHop = 0;
        if (this.count >= len) this.analyze(events, frames);
      }
    }
    return { events, frames };
  }

  private analyze(events: KeyEvent[], frames: DetectorFrame[]): void {
    const { ring, window, coeff } = this;
    const len = ring.length;
    const start = this.count % len;
    let s1 = 0;
    let s2 = 0;
    let energy = 0;
    for (let k = 0; k < len; k++) {
      const x = ring[(start + k) % len] * window[k];
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
    this.peak = Math.max(mag, this.peak * this.peakDecay);
    const span = this.peak - this.noise;
    const onLevel = this.noise + ON_FRACTION * span;
    const offLevel = this.noise + OFF_FRACTION * span;
    if (!this.state && mag < onLevel) this.noise += this.noiseAlpha * (mag - this.noise);
    const valid = this.peak >= this.noise * this.minRatio;
    // 下げの判定には純音らしさも求め、無音から雑音に変わったときなどの誤検出を防ぐ
    const raw = valid && (this.state ? mag > offLevel : mag > onLevel && purity >= MIN_PURITY);

    if (raw !== this.state) {
      if (++this.pending >= this.minChangeFrames) {
        this.state = raw;
        // 変化が始まったフレームを変化の時刻とする
        const first = t - ((this.pending - 1) * this.hopLen) / this.sampleRate;
        events.push({ down: raw, t: raw ? first : first - this.offDelay });
        this.pending = 0;
      }
    } else {
      this.pending = 0;
    }
    frames.push({ t, mag, on: this.state, onLevel: valid ? onLevel : this.noise * this.minRatio });
  }
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
