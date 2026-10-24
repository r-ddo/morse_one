import { describe, expect, it } from "vitest";
import type { DecodeEvent } from "./decoder";
import { DEFAULT_TUNING, VoiceDecoder, VoiceDetector, encodeWav, type VoiceChar } from "./voice";

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
}

/**
 * 唱える声の疑似的な波形。「タ」「ラ」は短点、「ター」「ラー」は長点、空白は文字間、「/」は語間。
 * 声は 140 Hz の倍音の和。2 つ目以降の「タ」の前には閉鎖の無音と破裂の雑音を入れ、
 * 「ラ」の出だしでは少し弱める。最初の音節の出だしの時刻（秒）も返す
 */
function voice(text: string, opts: VoiceOptions = {}): { samples: Float32Array; onsets: number[] } {
  const { short = 0.13, long = 0.32, charGap = 0.22, closure = 0.04, flapDb = 12, noise = 0.001 } = opts;
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
      const len = p.length > 1 ? long : short;
      syllables.push({ start: t, len, consonant: p[0] === "タ" ? "t" : "r", first: i === 0 });
      t += len;
    });
    t += charGap;
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
  });
  return { samples: out, onsets: syllables.map((s) => s.start) };
}

function decode(samples: Float32Array, charGap = DEFAULT_TUNING.charGap): { text: string; chars: VoiceChar[]; onsets: number[] } {
  const detector = new VoiceDetector(RATE);
  const chars: VoiceChar[] = [];
  const decoder = new VoiceDecoder(charGap, (c) => chars.push(c));
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
