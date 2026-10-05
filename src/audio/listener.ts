import { MorseDecoder, type DecodeEvent } from "./decoder";
import { KeyingDetector, findTonePeak, type DetectorFrame } from "./keying";
import { MicCapture, type MicProcessing } from "./mic";

/** 自動検出で探す周波数の範囲（Hz） */
export const FREQ_MIN = 300;
export const FREQ_MAX = 1500;

export interface ListenerOptions {
  processing: MicProcessing;
  /** 検出に使う周波数の初期値（Hz） */
  freq: number;
  /** スペクトルのピークから周波数を自動で合わせるか */
  autoFreq: boolean;
  /** 速度の推定の初期値（WPM） */
  wpm: number;
}

export interface ListenerHandlers {
  /** 復号のイベント。now は入力の先頭からの秒 */
  onEvents?: (events: DecodeEvent[], now: number) => void;
  onFrames?: (frames: DetectorFrame[]) => void;
  /** 自動検出で周波数を変えたとき */
  onFreq?: (freq: number) => void;
  /** マイクが OS などに止められたとき */
  onEnded?: () => void;
}

const QUIET_OPTIONS: MicProcessing = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

/** マイクから練習機などのサイドトーンを聞き、キーの上げ下げと符号を復元する */
export class KeyListener {
  readonly detector: KeyingDetector;
  decoder = new MorseDecoder();
  autoFreq: boolean;
  /** 直近のチャンクの実効値（dBFS） */
  rmsDb = -Infinity;
  private readonly spectrum: Float32Array<ArrayBuffer>;
  private freqCandidates: number[] = [];
  /** 自動検出で一度でも周波数を合わせたか */
  private freqLocked = false;
  /** 直近の符号のピークの周波数と、続けて捨てた符号の数 */
  private markPeaks: number[] = [];
  private rejectedRun = 0;
  /** 最初のチャンクを受け取った時刻（performance.now()）と、それ以降に受け取ったサンプル数 */
  private firstChunkAt: number | null = null;
  private received = 0;

  private constructor(
    readonly mic: MicCapture,
    opts: ListenerOptions,
    private readonly handlers: ListenerHandlers,
  ) {
    this.detector = new KeyingDetector(mic.ctx.sampleRate, opts.freq);
    this.decoder = new MorseDecoder(opts.wpm);
    this.autoFreq = opts.autoFreq;
    this.spectrum = new Float32Array(mic.analyser.frequencyBinCount);
    mic.track.addEventListener("ended", () => handlers.onEnded?.());
  }

  /** ユーザー操作のハンドラ内で呼ぶこと */
  static async open(opts: Partial<ListenerOptions>, handlers: ListenerHandlers): Promise<KeyListener> {
    const full: ListenerOptions = { processing: QUIET_OPTIONS, freq: 700, autoFreq: true, wpm: 20, ...opts };
    let listener: KeyListener | null = null;
    const mic = await MicCapture.open(full.processing, (s) => listener?.onSamples(s));
    listener = new KeyListener(mic, full, handlers);
    return listener;
  }

  /** 入力の先頭からの秒 */
  get now(): number {
    return this.detector.time;
  }

  get keyDown(): boolean {
    return this.detector.keyDown;
  }

  get binHz(): number {
    return this.mic.ctx.sampleRate / this.mic.analyser.fftSize;
  }

  /** 直近のスペクトル（dB） */
  get lastSpectrum(): Float32Array {
    return this.spectrum;
  }

  /**
   * 1 秒あたりに実際に届いたサンプル数。AudioContext のサンプリング周波数と大きく違えば、
   * 時間を測り違えている（速度や周波数を誤って見積もる）。測り始めて 2 秒たつまでは null
   */
  get measuredRate(): number | null {
    if (this.firstChunkAt === null) return null;
    const sec = (performance.now() - this.firstChunkAt) / 1000;
    return sec >= 2 ? this.received / sec : null;
  }

  setFreq(freq: number): void {
    this.detector.setFreq(freq);
    this.freqCandidates = [];
    this.freqLocked = true;
  }

  /** 復号をやり直す。速度の推定（と固定）は引き継ぐ */
  resetDecoder(): void {
    const { dot, bias, speedLocked } = this.decoder;
    this.decoder = new MorseDecoder(1.2 / dot);
    Object.assign(this.decoder, { bias, speedLocked });
  }

  /** 周波数と速度を今の値で固定する（自動での合わせ直しをすべて止める） */
  lock(): void {
    this.autoFreq = false;
    this.decoder.speedLocked = true;
  }

  close(): void {
    this.mic.close();
  }

  private onSamples(samples: Float32Array): void {
    // 最初のチャンクまでに溜まっていた分は数えない
    if (this.firstChunkAt === null) this.firstChunkAt = performance.now();
    else this.received += samples.length;
    let sum = 0;
    for (const x of samples) sum += x * x;
    this.rmsDb = 10 * Math.log10(sum / samples.length + 1e-12);

    this.mic.analyser.getFloatFrequencyData(this.spectrum);
    // 最初はスペクトルのピークで周波数を合わせる。合わせたあとは符号ごとのピークで合わせ直す
    // （手を止めている間に周りの音のピークへずれると、次の最初の符号を拾えなくなるため）
    if (this.autoFreq && !this.freqLocked) this.trackFreq();

    const { events, frames } = this.detector.process(samples);
    const out: DecodeEvent[] = [];
    for (const e of events) {
      if (e.down) {
        out.push(...this.decoder.keyDown(e.t));
        continue;
      }
      if (this.autoFreq) this.retune(e.tonal !== false, e.peakFreq);
      out.push(...this.decoder.keyUp(e.t, e.tonal !== false));
    }
    out.push(...this.decoder.tick(this.detector.time));
    if (frames.length > 0) this.handlers.onFrames?.(frames);
    if (out.length > 0) this.handlers.onEvents?.(out, this.detector.time);
  }

  /**
   * 直近 3 つの符号のピークがそろっていて、検出の周波数とずれていれば合わせ直す。
   * 符号を続けて捨てるようなら、周波数が大きくずれたとみなしてスペクトルから合わせ直す
   */
  private retune(tonal: boolean, peakFreq: number | undefined): void {
    this.rejectedRun = tonal ? 0 : this.rejectedRun + 1;
    if (this.rejectedRun >= 5) {
      this.freqLocked = false;
      this.freqCandidates = [];
      this.rejectedRun = 0;
    }
    if (peakFreq === undefined) return;
    this.markPeaks.push(peakFreq);
    if (this.markPeaks.length > 3) this.markPeaks.shift();
    if (this.markPeaks.length < 3 || Math.max(...this.markPeaks) - Math.min(...this.markPeaks) > 10) return;
    const median = [...this.markPeaks].sort((a, b) => a - b)[1];
    if (Math.abs(median - this.detector.freq) > 4) {
      this.detector.setFreq(median);
      this.handlers.onFreq?.(median);
    }
  }

  /** スペクトルのはっきりしたピークを集め、その中央値に検出の周波数を合わせる */
  private trackFreq(): void {
    const peak = findTonePeak(this.spectrum, this.binHz, FREQ_MIN, FREQ_MAX);
    if (!peak || peak.snrDb < 20) return;
    this.freqCandidates.push(peak.freq);
    if (this.freqCandidates.length > 15) this.freqCandidates.shift();
    if (this.freqCandidates.length < 8) return;
    const sorted = [...this.freqCandidates].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    this.freqLocked = true;
    if (Math.abs(median - this.detector.freq) > 10) {
      this.detector.setFreq(median);
      this.handlers.onFreq?.(median);
    }
  }
}
