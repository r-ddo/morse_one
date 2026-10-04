import { describe, expect, it } from "vitest";
import { MorseDecoder, estimateDot, type DecodeEvent } from "./decoder";
import { KeyingDetector, findTonePeak } from "./keying";
import { toIntervals } from "./player";
import { farnsworth } from "./timing";
import { evaluateSend, type SentChar } from "../training/sendScoring";

const RATE = 48000;

/** 再現性のある疑似乱数 */
function rng(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

interface SynthOptions {
  /** 先頭の、雑音だけの区間（秒） */
  lead?: number;
  /** さらにその前の、完全な無音の区間（秒） */
  silence?: number;
  /** 立ち上がり・立ち下がり（秒）。発音区間の内側で整形する（MorsePlayer と同じ） */
  ramp?: number;
}

/** 発音区間からトーン + 白色雑音の波形を作る */
function synth(intervals: [number, number][], freq: number, amp: number, noise: number, opts: SynthOptions = {}): Float32Array {
  const { lead = 0.3, silence = 0, ramp = 0 } = opts;
  const start = silence + lead;
  const end = (intervals.at(-1)?.[1] ?? 0) + start + 1;
  const out = new Float32Array(Math.ceil(end * RATE));
  const rand = rng(1);
  for (let i = Math.round(silence * RATE); i < out.length; i++) out[i] = (rand() * 2 - 1) * noise;
  for (const [on, off] of intervals) {
    for (let i = Math.round((on + start) * RATE); i < Math.round((off + start) * RATE); i++) {
      const t = i / RATE - start;
      const env = ramp > 0 ? Math.min(1, (t - on) / ramp, (off - t) / ramp) : 1;
      out[i] += amp * env * Math.sin((2 * Math.PI * freq * i) / RATE);
    }
  }
  return out;
}

/** 波形を chunk サンプルずつ流して復元した文字列 */
function decodeSignal(
  signal: Float32Array,
  freq: number,
  initialWpm = 20,
  chunk = 1024,
): { text: string; decoder: MorseDecoder; chars: SentChar[] } {
  const detector = new KeyingDetector(RATE, freq);
  const decoder = new MorseDecoder(initialWpm);
  let text = "";
  const chars: SentChar[] = [];
  const apply = (events: DecodeEvent[]) => {
    for (const e of events) {
      if (e.type === "char") {
        text += e.char ?? "*";
        chars.push(e);
      } else if (e.type === "word") text += " ";
    }
  };
  for (let i = 0; i < signal.length; i += chunk) {
    const { events } = detector.process(signal.subarray(i, i + chunk));
    for (const e of events) apply(e.down ? decoder.keyDown(e.t) : decoder.keyUp(e.t));
    apply(decoder.tick(detector.time));
  }
  return { text: text.trim(), decoder, chars };
}

describe("MorseDecoder", () => {
  it("decodes keyer-perfect timing and estimates the speed", () => {
    const signal = synth(toIntervals("PARIS CQ TEST", farnsworth(25, 25)), 700, 0.3, 0.02);
    const { text, decoder } = decodeSignal(signal, 700);
    expect(text).toBe("PARIS CQ TEST");
    expect(decoder.wpm).toBeCloseTo(25, 0);
  });

  it("follows speeds far from the initial guess", () => {
    for (const w of [10, 35]) {
      const signal = synth(toIntervals("THE QUICK BROWN FOX", farnsworth(w, w)), 600, 0.3, 0.02);
      expect(decodeSignal(signal, 600).text).toBe("THE QUICK BROWN FOX");
    }
  });

  it("learns widened character gaps (Farnsworth) after a few characters", () => {
    const signal = synth(toIntervals("VVVVV 5NX7Q K3ABC", farnsworth(25, 10)), 800, 0.1, 0.01);
    expect(decodeSignal(signal, 800, 20, 333).text).toMatch(/ 5NX7Q K3ABC$/);
  });

  it("measures shaped (ramped) elements without biasing the speed", () => {
    const signal = synth(toIntervals("CQ CQ DE JA1ABC K", farnsworth(22, 22)), 650, 0.3, 0.02, { ramp: 0.005 });
    const { text, decoder } = decodeSignal(signal, 700);
    expect(text).toBe("CQ CQ DE JA1ABC K");
    expect(Math.abs(decoder.wpm - 22)).toBeLessThan(0.5);
  });

  it("starts cleanly after digital silence", () => {
    const signal = synth(toIntervals("CQ CQ DE JA1ABC K", farnsworth(22, 22)), 650, 0.3, 0.02, { silence: 0.5, ramp: 0.005 });
    expect(decodeSignal(signal, 650).text).toBe("CQ CQ DE JA1ABC K");
  });

  it("feeds sending evaluation with character timings", () => {
    const signal = synth(toIntervals("ABCDE FGHIJ KLMNO", farnsworth(20, 20)), 700, 0.3, 0.02, { ramp: 0.005 });
    const { score, quality } = evaluateSend("ABCDEFGHIJKLMNO", decodeSignal(signal, 700).chars);
    expect(score.deduction).toBe(0);
    expect(quality.charGap!.mean).toBeCloseTo(3, 0);
    expect(quality.wordGap!.mean).toBeCloseTo(7, 0);
    expect(quality.dashRatio!).toBeCloseTo(3, 0);
    expect(quality.notes).toEqual([]);
  });

  it("ignores a tone at another frequency", () => {
    const signal = synth(toIntervals("TEST", farnsworth(20, 20)), 1500, 0.3, 0.01);
    expect(decodeSignal(signal, 700).text).toBe("");
  });

  it("reports unit lengths of gaps", () => {
    const decoder = new MorseDecoder(20);
    const dot = 0.06;
    const events = [
      ...decoder.keyDown(0),
      ...decoder.keyUp(dot),
      ...decoder.keyDown(2 * dot),
      ...decoder.keyUp(5 * dot),
      ...decoder.tick(8 * dot),
      ...decoder.keyDown(8 * dot),
    ];
    expect(events.map((e) => e.type)).toEqual(["mark", "gap", "mark", "char", "gap"]);
    expect(events[3]).toMatchObject({ char: "A", code: ".-" });
    expect(events[4]).toMatchObject({ kind: "char" });
  });
});

describe("estimateDot", () => {
  it("averages dots and thirds of dashes", () => {
    expect(estimateDot([0.05, 0.15, 0.05, 0.15], 0.1)).toBeCloseTo(0.05);
  });

  it("picks the interpretation closest to the previous estimate for one cluster", () => {
    expect(estimateDot([0.15, 0.15], 0.05)).toBeCloseTo(0.05);
    expect(estimateDot([0.15, 0.15], 0.12)).toBeCloseTo(0.15);
  });
});

describe("findTonePeak", () => {
  it("finds the peak with sub-bin accuracy", () => {
    const db = new Float32Array(512).fill(-100);
    db[60] = -40;
    db[61] = -30;
    db[62] = -40;
    const peak = findTonePeak(db, 10, 300, 2000)!;
    expect(peak.freq).toBeCloseTo(610);
    expect(peak.snrDb).toBeCloseTo(70);
  });
});
