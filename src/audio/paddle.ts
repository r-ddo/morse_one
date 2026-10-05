import { MorseDecoder, type DecodeEvent } from "./decoder";
import type { AudioSessionNavigator } from "./player";

export type Paddle = "dot" | "dash";

/**
 * スクイーズ式（iambic B）のエレキー。時刻（秒）を受け取って、キーの上げ下げの時刻を返す。
 *
 * - 片方を押し続けるとその符号を繰り返し、両方を押すと交互に出す
 * - 符号を出している間（と続く符号間）に押したパドルは覚えておき、離していても次に出す（パドルメモリー）。
 *   両方を押したまま符号を出し始めると反対側を覚えるので、両方を離しても反対側の符号を 1 つ出す（B モード）
 * - 符号間は必ず 1 短点あける
 */
export class IambicKeyer {
  private readonly held = { dot: false, dash: false };
  private readonly memory = { dot: false, dash: false };
  /** 出している符号 */
  private element: { kind: Paddle; end: number } | null = null;
  /** 符号間が終わり、次の符号を決める時刻 */
  private spaceEnd: number | null = null;
  private last: Paddle = "dot";

  constructor(
    /** 短点長（秒） */
    readonly dot: number,
    private readonly onKey: (down: boolean, t: number) => void,
  ) {}

  press(p: Paddle, now: number): void {
    this.advance(now);
    this.held[p] = true;
    if (this.element || this.spaceEnd !== null) this.memory[p] = true;
    else this.start(p, now);
  }

  release(p: Paddle, now: number): void {
    this.advance(now);
    this.held[p] = false;
  }

  /** 時刻 t までの符号の終わりと次の符号の始まりを処理する */
  advance(t: number): void {
    for (;;) {
      if (this.element && t >= this.element.end) {
        const { kind, end } = this.element;
        this.onKey(false, end);
        this.element = null;
        this.last = kind;
        this.spaceEnd = end + this.dot;
      } else if (this.spaceEnd !== null && t >= this.spaceEnd) {
        const at = this.spaceEnd;
        this.spaceEnd = null;
        const next = this.choose();
        if (!next) return;
        this.start(next, at);
      } else {
        return;
      }
    }
  }

  /** 両方を離して符号も出し終えたか */
  get idle(): boolean {
    return !this.element && this.spaceEnd === null;
  }

  private choose(): Paddle | null {
    const other: Paddle = this.last === "dot" ? "dash" : "dot";
    if (this.memory[other] || this.held[other]) return other;
    if (this.memory[this.last] || this.held[this.last]) return this.last;
    return null;
  }

  private start(kind: Paddle, t: number): void {
    const other: Paddle = kind === "dot" ? "dash" : "dot";
    this.memory[kind] = false;
    if (this.held[other]) this.memory[other] = true;
    this.element = { kind, end: t + (kind === "dash" ? 3 : 1) * this.dot };
    this.onKey(true, t);
  }
}

/** 立ち上がり・立ち下がり時間（秒）。クリック音を防ぐ */
const RAMP = 0.004;
/** 符号の切り替えを先に決めておく時間（秒）。タイマーの遅れで音が遅れないようにする */
const LOOKAHEAD = 0.015;
/** キーヤーを進める間隔（ミリ秒） */
const STEP_MS = 5;

export interface PaddleOptions {
  /** 符号の速度（WPM） */
  wpm: number;
  /** サイドトーンの周波数（Hz） */
  freq: number;
  /** サイドトーンの音量（0〜1） */
  volume: number;
}

/**
 * 画面のタッチやキーボードで操作する仮想のパドル。エレキーで符号を作ってサイドトーンを鳴らし、
 * キーの上げ下げをそのまま復号する（時刻は AudioContext の currentTime、秒）
 */
export class VirtualPaddle {
  decoder: MorseDecoder;
  private readonly keyer: IambicKeyer;
  private readonly ctx: AudioContext;
  private readonly osc: OscillatorNode;
  private readonly gain: GainNode;
  private readonly timer: ReturnType<typeof setInterval>;
  private downAt: number | null = null;
  private upAt: number | null = null;
  private pendingEvents: DecodeEvent[] = [];

  /** ユーザー操作のハンドラ内で作ること（iOS の自動再生制限のため） */
  constructor(
    private readonly opts: PaddleOptions,
    private readonly onEvents: (events: DecodeEvent[], now: number) => void,
  ) {
    const session = (navigator as AudioSessionNavigator).audioSession;
    if (session) session.type = "playback";
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    void this.ctx.resume();
    this.osc = this.ctx.createOscillator();
    this.osc.frequency.value = opts.freq;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0;
    this.osc.connect(this.gain).connect(this.ctx.destination);
    this.osc.start();

    this.decoder = this.newDecoder();
    this.keyer = new IambicKeyer(1.2 / opts.wpm, (down, t) => this.key(down, t));
    this.timer = setInterval(() => this.step(), STEP_MS);
  }

  /** 入力の時刻（秒） */
  get now(): number {
    return this.ctx.currentTime;
  }

  get keyDown(): boolean {
    const now = this.now;
    return this.downAt !== null && this.downAt <= now && (this.upAt === null || this.upAt < this.downAt || now < this.upAt);
  }

  get wpm(): number {
    return this.opts.wpm;
  }

  press(p: Paddle): void {
    this.keyer.press(p, this.now);
    this.flush();
  }

  release(p: Paddle): void {
    this.keyer.release(p, this.now);
    this.flush();
  }

  /** 復号をやり直す */
  resetDecoder(): void {
    this.decoder = this.newDecoder();
  }

  close(): void {
    clearInterval(this.timer);
    this.osc.stop();
    void this.ctx.close().catch(() => {});
  }

  private newDecoder(): MorseDecoder {
    const decoder = new MorseDecoder(this.opts.wpm);
    // 符号の長さはエレキーが正確に作るので、速度は推定しない
    decoder.speedLocked = true;
    return decoder;
  }

  private step(): void {
    const now = this.now;
    this.keyer.advance(now + LOOKAHEAD);
    this.pendingEvents.push(...this.decoder.tick(now));
    this.flush();
  }

  private key(down: boolean, t: number): void {
    const g = this.gain.gain;
    const at = Math.max(t, this.ctx.currentTime);
    if (down) {
      this.downAt = t;
      g.cancelScheduledValues(at);
      g.setValueAtTime(0, at);
      g.linearRampToValueAtTime(this.opts.volume, at + RAMP);
      this.pendingEvents.push(...this.decoder.keyDown(t));
    } else {
      this.upAt = t;
      g.setValueAtTime(this.opts.volume, at - RAMP);
      g.linearRampToValueAtTime(0, at);
      this.pendingEvents.push(...this.decoder.keyUp(t));
    }
  }

  private flush(): void {
    if (this.pendingEvents.length === 0) return;
    const events = this.pendingEvents;
    this.pendingEvents = [];
    this.onEvents(events, this.now);
  }
}
