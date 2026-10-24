import type { DecodeEvent } from "../audio/decoder";
import { KeyListener } from "../audio/listener";
import { VirtualPaddle, VirtualStraightKey } from "../audio/paddle";
import { VoiceListener } from "../audio/voice";
import type { Settings } from "../storage/settings";
import type { ScreenContext } from "./context";
import { paddlePads, straightKeyPad, type TouchPads } from "./paddlePads";
import type { TouchLog } from "./touchLog";

/** 送信の入力（練習機の音を拾うマイク、画面のパドル・縦振電鍵、声）に共通の部分 */
export interface SendInput {
  /** 入力の時刻（秒） */
  readonly now: number;
  readonly keyDown: boolean;
  readonly decoder: {
    readonly wpm: number;
    /** 文字として確定していない符号 */
    readonly pendingCode: string;
    /** 無音が続いたときの文字・語の区切り */
    tick(t: number): DecodeEvent[];
  };
  close(): void;
}

type OnEvents = (events: DecodeEvent[], now: number) => void;

/** 前回固定した周波数（Hz）と速度（WPM）。次の練習の初期値にする */
let lastFreq = 700;
let lastWpm = 20;
/** 画面の縦振電鍵で前回推定した速度（WPM）。次の練習の初期値にする */
let lastStraightWpm = 15;
/** 声で前回推定した短点・長点の長さと境（秒）。次の練習の初期値にする */
let lastVoice: { threshold: number; dotLen: number; dashLen: number } | null = null;

/**
 * 画面のパドルか縦振電鍵（設定の入力による）。マイクの入力なら null。
 * タップの中で呼ぶこと（サイドトーンの AudioContext を作るため、iOS の自動再生制限）
 */
export function createPadInput(ctx: ScreenContext, onEvents: OnEvents, log: TouchLog | null): { input: SendInput; pads: TouchPads } | null {
  const { sendInput, paddleWpm, freq, volume, paddleSwap } = ctx.settings;
  if (sendInput === "paddle") {
    const paddle = new VirtualPaddle({ wpm: paddleWpm, freq, volume }, onEvents);
    const name = { dot: "短点", dash: "長点" } as const;
    const pads = paddlePads({
      press: (p) => {
        log?.add(`★ ${name[p]}を押す`);
        paddle.press(p);
      },
      release: (p) => {
        log?.add(`☆ ${name[p]}を離す`);
        paddle.release(p);
      },
    }, paddleSwap);
    return { input: paddle, pads };
  }
  if (sendInput === "straight") {
    const key = new VirtualStraightKey({ wpm: lastStraightWpm, freq, volume }, onEvents);
    const pads = straightKeyPad({
      press: () => {
        log?.add("★ 電鍵を押す");
        key.press();
      },
      release: () => {
        log?.add("☆ 電鍵を離す");
        key.release();
      },
    });
    return { input: key, pads };
  }
  return null;
}

/** マイクの入力（練習機の音か声）を開く。開けなければ例外 */
export async function openMicInput(ctx: ScreenContext, onEvents: OnEvents, onEnded: () => void): Promise<SendInput> {
  if (ctx.settings.sendInput === "voice") {
    const voice = await VoiceListener.open(
      { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      ctx.settings.voiceTuning,
      { onEvents, onEnded },
    );
    if (lastVoice) Object.assign(voice.decoder, lastVoice);
    return voice;
  }
  return KeyListener.open(
    { freq: lastFreq, wpm: lastWpm },
    { onEvents, onFreq: (f) => (lastFreq = Math.round(f)), onEnded },
  );
}

/** マイクを使う入力か（練習機の音か声） */
export function usesMic(via: Settings["sendInput"]): boolean {
  return via === "mic" || via === "voice";
}

/** VVV で慣らしが要るか（画面のパドルは符号の長さと速度をエレキーが決めるので要らない） */
export function needsWarmup(via: Settings["sendInput"]): boolean {
  return via !== "paddle";
}

/**
 * 慣らしを終えたとき。練習機の音なら、VVV で確認できた周波数と速度で固定する。
 * 練習機の速度と音は練習の途中で変えないので、外の音に周波数を持っていかれたり、送り方で速度の推定がぶれたりしないようにする
 */
export function lockAfterWarmup(input: SendInput): void {
  if (!(input instanceof KeyListener)) return;
  input.lock();
  lastFreq = Math.round(input.detector.freq);
  lastWpm = input.decoder.wpm;
}

/** 練習を終えたとき。推定した速さを次の練習の初期値にする */
export function rememberInput(input: SendInput): void {
  if (input instanceof VirtualStraightKey) lastStraightWpm = input.decoder.wpm;
  if (input instanceof VoiceListener) {
    const { threshold, dotLen, dashLen } = input.decoder;
    lastVoice = { threshold, dotLen, dashLen };
  }
}

/** 入力と速さの表示。warmup なら慣らしの途中 */
export function describeInput(input: SendInput, warmup: boolean): string {
  if (input instanceof KeyListener) {
    return `${Math.round(input.detector.freq)} Hz・${input.decoder.wpm.toFixed(1)} WPM${warmup ? "" : "（固定）"}`;
  }
  if (input instanceof VoiceListener) {
    const ms = (s: number) => `${Math.round(s * 1000)} ms`;
    return `声・短点 ${ms(input.decoder.dotLen)}・長点 ${ms(input.decoder.dashLen)}`;
  }
  if (input instanceof VirtualPaddle) return `画面のパドル・${input.decoder.wpm.toFixed(0)} WPM`;
  return `画面の縦振電鍵・推定 ${input.decoder.wpm.toFixed(1)} WPM`;
}

/** 慣らしの案内 */
export function warmupText(via: Settings["sendInput"]): string {
  return via === "voice"
    ? "まず VVV を唱えてください（短点と長点の長さを合わせます）"
    : via === "straight"
      ? "まず VVV を送ってください（速度の推定を合わせます）"
      : "まず VVV を送ってください（周波数と速度を合わせて固定します）";
}
