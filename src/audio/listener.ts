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

  private constructor(
    readonly mic: MicCapture,
    opts: ListenerOptions,
    private readonly handlers: ListenerHandlers,
  ) {
    this.detector = new KeyingDetector(mic.ctx.sampleRate, opts.freq);
    this.autoFreq = opts.autoFreq;
    this.spectrum = new Float32Array(mic.analyser.frequencyBinCount);
    mic.track.addEventListener("ended", () => handlers.onEnded?.());
  }

  /** ユーザー操作のハンドラ内で呼ぶこと */
  static async open(opts: Partial<ListenerOptions>, handlers: ListenerHandlers): Promise<KeyListener> {
    const full: ListenerOptions = { processing: QUIET_OPTIONS, freq: 700, autoFreq: true, ...opts };
    let listener: KeyListener | null = null;
    const mic = await MicCapture.open(full.processing, (s) => listener?.onSamples(s));
    listener = new KeyListener(mic, full, handlers);
    return listener;
  }

  /** 入力の先頭からの秒 */
  get now(): number {
    return this.detector.time;
  }

  get binHz(): number {
    return this.mic.ctx.sampleRate / this.mic.analyser.fftSize;
  }

  /** 直近のスペクトル（dB） */
  get lastSpectrum(): Float32Array {
    return this.spectrum;
  }

  setFreq(freq: number): void {
    this.detector.setFreq(freq);
    this.freqCandidates = [];
  }

  /** 復号をやり直す。速度の推定は引き継ぐ */
  resetDecoder(): void {
    this.decoder = new MorseDecoder(this.decoder.wpm);
  }

  close(): void {
    this.mic.close();
  }

  private onSamples(samples: Float32Array): void {
    let sum = 0;
    for (const x of samples) sum += x * x;
    this.rmsDb = 10 * Math.log10(sum / samples.length + 1e-12);

    this.mic.analyser.getFloatFrequencyData(this.spectrum);
    if (this.autoFreq) this.trackFreq();

    const { events, frames } = this.detector.process(samples);
    const out: DecodeEvent[] = [];
    for (const e of events) out.push(...(e.down ? this.decoder.keyDown(e.t) : this.decoder.keyUp(e.t)));
    out.push(...this.decoder.tick(this.detector.time));
    if (frames.length > 0) this.handlers.onFrames?.(frames);
    if (out.length > 0) this.handlers.onEvents?.(out, this.detector.time);
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
    if (Math.abs(median - this.detector.freq) > 10) {
      this.detector.setFreq(median);
      this.handlers.onFreq?.(median);
    }
  }
}
