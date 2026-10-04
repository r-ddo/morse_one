import { MORSE } from "./code";
import type { Timing } from "./timing";

export interface ToneOptions {
  /** 周波数（Hz） */
  freq: number;
  /** 音量（0〜1） */
  volume: number;
}

export interface Playback {
  /** 最後の符号が鳴り終わる時刻（performance.now() 基準、ミリ秒） */
  endPerf: number;
  /** 最初の符号が鳴り始める時刻（performance.now() 基準、ミリ秒） */
  startPerf: number;
  /** 再生終了（または stop）で解決する */
  done: Promise<void>;
}

/** 立ち上がり・立ち下がり時間（秒）。クリック音を防ぐ */
const RAMP = 0.005;
/** 再生予約の先行時間（秒） */
const LEAD = 0.05;

export interface AudioSessionNavigator {
  audioSession?: { type: string };
}

/** 文字列を [開始, 終了] の発音区間（秒、先頭 0 基準）に変換する。空白は語間 */
export function toIntervals(text: string, timing: Timing): [number, number][] {
  return layout(text, timing).intervals;
}

/** 空白以外の各文字が鳴り終わる時刻（秒、先頭 0 基準）。符号表にない文字は除く */
export function charEndTimes(text: string, timing: Timing): number[] {
  return layout(text, timing).charEnds;
}

function layout(text: string, timing: Timing): { intervals: [number, number][]; charEnds: number[] } {
  const out: [number, number][] = [];
  const charEnds: number[] = [];
  let t = 0;
  let pendingGap = 0;
  for (const ch of text.toUpperCase()) {
    if (ch === " ") {
      if (out.length > 0) pendingGap = timing.wordGap;
      continue;
    }
    const code = MORSE[ch];
    if (!code) continue;
    t += pendingGap;
    for (let i = 0; i < code.length; i++) {
      const len = code[i] === "-" ? 3 * timing.dot : timing.dot;
      out.push([t, t + len]);
      t += len;
      if (i < code.length - 1) t += timing.dot;
    }
    charEnds.push(t);
    pendingGap = timing.charGap;
  }
  return { intervals: out, charEnds };
}

/** resume() がこの時間内に終わらなければ AudioContext を作り直す（ミリ秒） */
const RESUME_TIMEOUT_MS = 300;

export class MorsePlayer {
  private ctx: AudioContext | null = null;
  private current: { osc: OscillatorNode; finish: () => void } | null = null;

  /** 再生中に別のアプリへの切り替えや着信などで音が止められたときに呼ばれる */
  onInterrupted: (() => void) | null = null;

  /**
   * ユーザー操作のハンドラ内で呼ぶこと（iOS の自動再生制限のため）。
   * iOS ではアプリを切り替えた後、resume() が終わらない・状態は running でも無音、
   * ということがあるので、再開できなければ AudioContext を作り直す
   */
  async unlock(): Promise<void> {
    if (this.ctx && this.ctx.state !== "running") {
      const resumed = await Promise.race([
        this.ctx.resume().then(() => true, () => false),
        new Promise<boolean>((r) => setTimeout(() => r(false), RESUME_TIMEOUT_MS)),
      ]);
      if (!resumed || (this.ctx.state as string) !== "running") this.release();
    }
    if (!this.ctx) this.ctx = this.createContext();
    if (this.ctx.state !== "running") await this.ctx.resume();
  }

  /** 再生を止めて AudioContext を閉じる。次の unlock() で作り直す */
  release(): void {
    this.stop();
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) {
      ctx.onstatechange = null;
      void ctx.close().catch(() => {});
    }
  }

  private createContext(): AudioContext {
    // iOS のマナーモードでも鳴らす（Safari 16.4 以降）
    const session = (navigator as AudioSessionNavigator).audioSession;
    if (session) session.type = "playback";
    const ctx = new AudioContext();
    ctx.onstatechange = () => {
      // iOS では "interrupted" になることがある
      if (this.ctx === ctx && ctx.state !== "running" && this.current) this.onInterrupted?.();
    };
    return ctx;
  }

  play(text: string, timing: Timing, tone: ToneOptions): Playback {
    const ctx = this.ctx;
    if (!ctx) throw new Error("MorsePlayer.unlock() has not been called");
    this.stop();

    const intervals = toIntervals(text, timing);
    const start = ctx.currentTime + LEAD;
    const end = start + (intervals.at(-1)?.[1] ?? 0);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = tone.freq;
    gain.gain.setValueAtTime(0, start);
    for (const [on, off] of intervals) {
      const ramp = Math.min(RAMP, (off - on) / 4);
      gain.gain.setValueAtTime(0, start + on);
      gain.gain.linearRampToValueAtTime(tone.volume, start + on + ramp);
      gain.gain.setValueAtTime(tone.volume, start + off - ramp);
      gain.gain.linearRampToValueAtTime(0, start + off);
    }
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(end + 0.01);

    const done = new Promise<void>((resolve) => {
      const finish = () => {
        if (this.current?.osc === osc) this.current = null;
        gain.disconnect();
        resolve();
      };
      osc.onended = finish;
      this.current = { osc, finish };
    });

    return { endPerf: this.toPerf(ctx, end), startPerf: this.toPerf(ctx, start), done };
  }

  stop(): void {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    cur.osc.onended = null;
    try {
      cur.osc.stop();
    } catch {
      // 既に停止済み
    }
    cur.finish();
  }

  /** AudioContext の時刻を performance.now() 基準に変換する（出力遅延込み） */
  private toPerf(ctx: AudioContext, contextTime: number): number {
    const ts = ctx.getOutputTimestamp?.();
    if (ts?.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
      return ts.performanceTime + (contextTime - ts.contextTime) * 1000;
    }
    return performance.now() + (contextTime - ctx.currentTime) * 1000;
  }
}
