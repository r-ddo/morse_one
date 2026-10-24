import { describe, expect, it } from "vitest";
import type { DecodeEvent } from "./decoder";
import { evaluateSend, type SentChar } from "../training/sendScoring";
import { DEFAULT_TUNING, VoiceDecoder, VoiceDetector, encodeWav, type VoiceChar, type VoiceTuning } from "./voice";

const RATE = 48000;

/** 再現性のある疑似乱数 */
function rng(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

interface VoiceOptions {
  /** 短い音節・長い音節の長さ（次の音節の出だしまで、秒） */
  short?: number;
  long?: number;
  /** 文字間の無音（秒） */
  charGap?: number;
  /** 「タ」の閉鎖の無音（秒） */
  closure?: number;
  /** 「ラ」で弱まる量（dB） */
  flapDb?: number;
  /** 背景の雑音の振幅 */
  noise?: number;
  /** 文字の最後の母音が引く、弱い尾の長さ（秒）。尾のあとに文字間の無音を置く */
  tail?: number;
  /** 音節ごとに長さを ±この割合でばらつかせる */
  jitter?: number;
}

/**
 * 唱える声の疑似的な波形。「タ」「ラ」は短点、「ター」「ラー」は長点、空白は文字間、「/」は語間。
 * 声は 140 Hz の倍音の和。2 つ目以降の「タ」の前には閉鎖の無音と破裂の雑音を入れ、
 * 「ラ」の出だしでは少し弱める。最初の音節の出だしの時刻（秒）も返す
 */
function voice(text: string, opts: VoiceOptions = {}): { samples: Float32Array; onsets: number[] } {
  const { short = 0.13, long = 0.32, charGap = 0.22, closure = 0.04, flapDb = 12, noise = 0.001, tail = 0, jitter = 0 } = opts;
  const vary = rng(11);
  const chars = text.split(/( |\/)/).filter((s) => s !== "" && s !== " ");
  // 音節: [出だし, 長さ, 子音]
  const syllables: { start: number; len: number; consonant: "t" | "r"; first: boolean }[] = [];
  let t = 0.5;
  for (const c of chars) {
    if (c === "/") {
      t += 0.6;
      continue;
    }
    const parts = c.match(/[タラ]ー?/g) ?? [];
    parts.forEach((p, i) => {
      const len = (p.length > 1 ? long : short) * (1 + jitter * (vary() * 2 - 1));
      syllables.push({ start: t, len, consonant: p[0] === "タ" ? "t" : "r", first: i === 0 });
      t += len;
    });
    t += tail + charGap;
  }
  const out = new Float32Array(Math.ceil((t + 0.5) * RATE));
  const rand = rng(3);
  for (let i = 0; i < out.length; i++) out[i] = (rand() * 2 - 1) * noise;
  const flap = 10 ** (-flapDb / 20);
  syllables.forEach((s, k) => {
    const next = syllables[k + 1];
    const last = !next || next.first;
    const from = Math.round(s.start * RATE);
    const to = Math.round((s.start + s.len) * RATE);
    for (let i = from; i < to; i++) {
      const u = i / RATE - s.start;
      const rest = s.len - u;
      let env = 1;
      if (s.first) env = Math.min(env, u / 0.01);
      if (!s.first && s.consonant === "r") env = Math.min(env, flap + (1 - flap) * Math.min(1, u / 0.02));
      if (!s.first && s.consonant === "t" && u < 0.01) env = 0;
      if (last) env = Math.min(env, rest / 0.03);
      if (next && !last && next.consonant === "t") env = rest < closure ? 0 : Math.min(env, (rest - closure) / 0.01);
      if (next && !last && next.consonant === "r") env = Math.min(env, flap + (1 - flap) * Math.min(1, rest / 0.02));
      let x = 0;
      for (let h = 1; h <= 10; h++) x += Math.sin(2 * Math.PI * 140 * h * (i / RATE)) / h;
      out[i] += 0.1 * env * x;
      // 破裂音
      if (!s.first && s.consonant === "t" && u < 0.01) out[i] += 0.05 * (rand() * 2 - 1);
    }
    // 尾: 一番強いところより 28 dB 弱く始まり、さらに弱まっていく
    for (let i = to; last && i < to + tail * RATE; i++) {
      const u = (i - to) / RATE;
      let x = 0;
      for (let h = 1; h <= 10; h++) x += Math.sin(2 * Math.PI * 140 * h * (i / RATE)) / h;
      out[i] += 0.1 * 0.04 * Math.exp(-u / 0.08) * x;
    }
  });
  return { samples: out, onsets: syllables.map((s) => s.start) };
}

function decode(samples: Float32Array): { text: string; chars: VoiceChar[]; onsets: number[] } {
  return decodeWith(samples, DEFAULT_TUNING);
}

function decodeWith(samples: Float32Array, tuning: VoiceTuning): { text: string; chars: VoiceChar[]; onsets: number[] } {
  const detector = new VoiceDetector(RATE, tuning);
  const chars: VoiceChar[] = [];
  const decoder = new VoiceDecoder(tuning.charGap, (c) => chars.push(c));
  let text = "";
  const onsets: number[] = [];
  const apply = (events: DecodeEvent[]) => {
    for (const e of events) {
      if (e.type === "char") text += e.char ?? "?";
      if (e.type === "word") text += " ";
    }
  };
  for (let i = 0; i < samples.length; i += 1024) {
    const { events } = detector.process(samples.subarray(i, i + 1024));
    for (const e of events) {
      if (e.down) {
        onsets.push(e.t);
        apply(decoder.keyDown(e.t));
      } else {
        apply(decoder.keyUp(e.t, e.split ?? false, e.dipDb ?? 0));
      }
    }
    apply(decoder.tick(detector.time));
  }
  apply(decoder.tick(detector.time + 2));
  return { text: text.trim(), chars, onsets };
}

describe("VoiceDetector", () => {
  it("「タ」の閉鎖と「ラ」の弱まりの両方で音節の出だしを拾う", () => {
    const { samples, onsets } = voice("タタタ タララ");
    const found = decode(samples).onsets;
    expect(found).toHaveLength(onsets.length);
    found.forEach((t, i) => expect(Math.abs(t - onsets[i])).toBeLessThan(0.03));
  });

  it.each([15, 25])("無音のあとに入力が絞られて最初の「タ」が弱くても拾う（強さ %i dB）", (onDb) => {
    const { samples, onsets } = voice("タラ", { noise: 0.0003 });
    // iOS の音声処理が入力を戻していくのをまねて、声の出だしから 0.3 秒で −15 dB から 0 dB に上げる
    const from = Math.round(0.5 * RATE);
    for (let i = from; i < from + 0.3 * RATE; i++) samples[i] *= 10 ** ((-15 * (1 - (i - from) / (0.3 * RATE))) / 20);
    const found = decodeWith(samples, { ...DEFAULT_TUNING, onDb });
    expect(found.onsets).toHaveLength(2);
    expect(Math.abs(found.onsets[0] - onsets[0])).toBeLessThan(0.03);
    expect(found.text).toBe("I");
  });

  it("床の雑音で声ありのままにならない", () => {
    // 入力がほぼ 0 の区間のあと、ふつうの床の雑音に戻る
    const quiet = new Float32Array(2 * RATE);
    const { samples } = voice("タター", { noise: 0.003 });
    const all = new Float32Array(quiet.length + samples.length);
    all.set(samples, quiet.length);
    expect(decode(all).text).toBe("A");
  });

  it("マイクを開いた直後のごく弱い入力を雑音の基準にしない", () => {
    // 実機の録音（2026-10-24）: 最初の 50 ms ほど −98 dB 前後で、そのあと床の雑音（−82 dB 前後）になる
    const { samples } = voice("タタター", { noise: 0.0007 });
    const rand = rng(9);
    for (let i = 0; i < 0.05 * RATE; i++) samples[i] = (rand() * 2 - 1) * 0.0001;
    expect(decode(samples).text).toBe("U");
  });

  it.each([70, 80, 110])("声が低くても（%i Hz）長い音節を分けない", (f0) => {
    const rand = rng(5);
    const samples = Float32Array.from({ length: 1.5 * RATE }, () => (rand() * 2 - 1) * 0.0003);
    let phase = 0;
    for (let i = Math.round(0.3 * RATE); i < Math.round(0.9 * RATE); i++) {
      const t = i / RATE;
      const env = Math.min(1, (t - 0.3) / 0.01, (0.9 - t) / 0.03);
      phase += (2 * Math.PI * f0 * (1 + 0.03 * Math.sin(2 * Math.PI * 5 * t))) / RATE;
      let x = 0;
      for (let h = 1; h <= 12; h++) x += Math.sin(h * phase) / h;
      samples[i] += 0.1 * env * x;
    }
    expect(decode(samples).onsets).toHaveLength(1);
  });

  it("少しの揺れでは音節を分けない", () => {
    const { samples } = voice("ター", { long: 0.5 });
    // 長い母音の途中を 3 dB だけ弱める
    for (let i = Math.round(0.7 * RATE); i < Math.round(0.75 * RATE); i++) samples[i] *= 0.7;
    expect(decode(samples).onsets).toHaveLength(1);
  });
});

describe("VoiceDecoder", () => {
  it("タとラのどちらで唱えても同じ文字にする", () => {
    const { samples } = voice("タター タラー タータタタ ターラララ ターラターラ ターラタ タタタ");
    expect(decode(samples).text).toBe("AABBCDS");
  });

  it("長点ばかり・短点ばかりの文字が続いても分ける", () => {
    const { samples } = voice("タタタター ターターター タララ ター タ タラー");
    expect(decode(samples).text).toBe("VOSTEA");
  });

  it("文字の最後の母音が弱い尾を引いても、短点を長点にせず、次の文字とつなげない", () => {
    // 実機の録音（2026-10-24）: 尾は 100〜160 ms、尾のあとの無音は 50〜90 ms
    const { samples } = voice("ターラタ タ タータターラ ターターラター", { tail: 0.13, charGap: 0.07 });
    expect(decode(samples).text).toBe("DECQ");
  });

  it("短点と長点の長さが詰まっていても分ける", () => {
    // 実機の録音（2026-10-24）: 短点 105〜195 ms、長点 230〜310 ms
    const { samples } = voice("ターラターラ ターターラター ターラターラ ターターラター ターラタ タ", { short: 0.145, long: 0.265, jitter: 0.3 });
    expect(decode(samples).text).toBe("CQCQDE");
  });

  it("採点に渡す文字の符号の長さは、推定した短点長で整える", () => {
    const { samples } = voice("タター タララ");
    const chars: Extract<DecodeEvent, { type: "char" }>[] = [];
    const detector = new VoiceDetector(RATE);
    const decoder = new VoiceDecoder();
    const take = (events: DecodeEvent[]) => events.forEach((e) => e.type === "char" && chars.push(e));
    for (let i = 0; i < samples.length; i += 1024) {
      for (const e of detector.process(samples.subarray(i, i + 1024)).events) {
        take(e.down ? decoder.keyDown(e.t) : decoder.keyUp(e.t, e.split ?? false, e.dipDb ?? 0));
      }
      take(decoder.tick(detector.time));
    }
    expect(chars.map((c) => c.char)).toEqual(["A", "S"]);
    const [a] = chars;
    expect(a.marks).toEqual([a.dot, 3 * a.dot]);
    expect(a.gaps).toEqual([a.dot]);
    expect(a.end - a.start).toBeCloseTo(5 * a.dot);
  });

  it("声で唱えた文字は、短点と長点の比が 1:2 前後でも不明りょうにしない", () => {
    const { samples } = voice("タター ターラララ ターラターラ ターラタ タ", { short: 0.14, long: 0.27, jitter: 0.2 });
    const sent: SentChar[] = [];
    const detector = new VoiceDetector(RATE);
    const decoder = new VoiceDecoder();
    const take = (events: DecodeEvent[]) => events.forEach((e) => e.type === "char" && sent.push(e));
    for (let i = 0; i < samples.length; i += 1024) {
      for (const e of detector.process(samples.subarray(i, i + 1024)).events) {
        take(e.down ? decoder.keyDown(e.t) : decoder.keyUp(e.t, e.split ?? false, e.dipDb ?? 0));
      }
      take(decoder.tick(detector.time));
    }
    take(decoder.tick(detector.time + 2));
    const { score } = evaluateSend("ABCDE", sent);
    expect(score.unclear).toBe(0);
    expect(score.deduction).toBe(0);
  });

  it("語の区切りを出す", () => {
    const { samples } = voice("タター/ターラララ");
    expect(decode(samples).text).toBe("A B");
  });

  it("文字ごとの音節の長さと、文字の前の無音を記録する", () => {
    const { samples } = voice("タター ター", { charGap: 0.25 });
    const { chars } = decode(samples);
    expect(chars.map((c) => c.code)).toEqual([".-", "-"]);
    expect(chars[0].lengths[0]).toBeCloseTo(0.13, 1);
    expect(chars[0].gapBefore).toBeNull();
    expect(chars[1].gapBefore).toBeGreaterThan(0.2);
  });
});

describe("encodeWav", () => {
  it("16 ビット・モノラルの WAV にする", async () => {
    const blob = encodeWav([new Float32Array([0, 0.5, -1])], 48000);
    const v = new DataView(await blob.arrayBuffer());
    expect(blob.size).toBe(44 + 6);
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getInt16(46, true)).toBe(16384);
    expect(v.getInt16(48, true)).toBe(-32767);
  });
});
