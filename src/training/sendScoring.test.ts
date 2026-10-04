import { describe, expect, it } from "vitest";
import { MORSE } from "../audio/code";
import { evaluateSend, isCorrection, isUnclear, type SentChar } from "./sendScoring";

const DOT = 0.06;
const HH = "........";

interface SendStyle {
  /** 文字間・語間（短点単位） */
  charGap?: number;
  wordGap?: number;
  /** 長点の長さ（短点単位） */
  dash?: number;
}

/** 文字列（空白は語間）を、送ったとおりの SentChar にする。"#" は訂正符号 HH */
function sendText(text: string, style: SendStyle = {}, startAt = 0): SentChar[] {
  const { charGap = 3, wordGap = 7, dash = 3 } = style;
  const out: SentChar[] = [];
  let t = startAt;
  let gap = 0;
  for (const ch of text) {
    if (ch === " ") {
      gap = wordGap;
      continue;
    }
    t += gap * DOT;
    out.push(sentCode(ch === "#" ? HH : MORSE[ch], t, dash, ch === "#" ? null : ch));
    t = out.at(-1)!.end;
    gap = charGap;
  }
  return out;
}

function sentCode(code: string, start: number, dash = 3, char: string | null = null, marks?: number[]): SentChar {
  const lengths = marks ?? [...code].map((x) => (x === "-" ? dash : 1) * DOT);
  const end = start + lengths.reduce((a, b) => a + b, 0) + (lengths.length - 1) * DOT;
  return { char, code, start, end, marks: lengths, gaps: lengths.slice(1).map(() => DOT), dot: DOT };
}

describe("evaluateSend", () => {
  it("gives full marks to clean sending", () => {
    const { score, quality } = evaluateSend("ABCDEFGHIJ", sendText("ABCDE FGHIJ"));
    expect(score.deduction).toBe(0);
    expect(score.points).toBe(100);
    expect(score.marks.every((m) => m === "ok")).toBe(true);
    expect(quality.dashRatio).toBeCloseTo(3);
    expect(quality.charGap?.mean).toBeCloseTo(3);
    expect(quality.wordGap?.mean).toBeCloseTo(7);
    expect(quality.notes).toEqual([]);
  });

  it("charges 3 points for wrong, missing and extra characters", () => {
    expect(evaluateSend("ABCDE", sendText("ABCDX")).score).toMatchObject({ wrong: 1, deduction: 3 });
    const missing = evaluateSend("ABCDE", sendText("ABDE")).score;
    expect(missing).toMatchObject({ missing: 1, deduction: 3 });
    expect(missing.marks).toEqual(["ok", "ok", "missing", "ok", "ok"]);
    expect(evaluateSend("ABCDE", sendText("ABCCDE")).score).toMatchObject({ extra: 1, deduction: 3 });
  });

  it("treats undecodable codes as wrong characters", () => {
    const sent = sendText("ABCD");
    sent.push(sentCode(".-.-.-.-.-", sent[3].end + 3 * DOT));
    const { score } = evaluateSend("ABCDE", sent);
    expect(score).toMatchObject({ wrong: 1, deduction: 3 });
    expect(score.sentAt[4]).toBe(".-.-.-.-.-");
  });

  it("undoes the characters before a correction and counts it", () => {
    const { score } = evaluateSend("ABCDE", sendText("ABX#BCDE"));
    expect(score).toMatchObject({ corrections: 1, wrong: 0, extra: 0, deduction: 1 });
    expect(evaluateSend("ABCDEFGHIJ", sendText("AX#BCDEX#E FGX#GHIX#IJ")).score.deduction).toBe(2);
  });

  it("counts unsent characters only in timed mode", () => {
    const sent = sendText("ABCDE FG");
    expect(evaluateSend("ABCDEFGHIJ", sent, { timed: true }).score).toMatchObject({ unsent: 3, missing: 0, deduction: 2 });
    expect(evaluateSend("ABCDEFGHIJ", sent).score).toMatchObject({ unsent: 0, missing: 3, deduction: 9 });
  });

  it("charges 1 point for an unclear character", () => {
    const sent = sendText("ABCD");
    // A の短点が長点の 0.6 倍
    sent.push(sentCode(".-", sent[3].end + 3 * DOT, 3, "A", [1.8 * DOT, 3 * DOT]));
    const { score } = evaluateSend("ABCDA", sent);
    expect(score).toMatchObject({ unclear: 1, deduction: 1 });
    expect(score.unclearAt).toEqual([false, false, false, false, true]);
  });

  it("charges long character and word gaps", () => {
    const sent = [...sendText("ABC"), ...sendText("DE", {}, 0)];
    // C と D の間を 6.5 短点に
    const shift = sent[2].end + 6.5 * DOT - sent[3].start;
    for (const c of sent.slice(3)) Object.assign(c, { start: c.start + shift, end: c.end + shift });
    const words = sendText("ABCDE FGHIJ", { wordGap: 15 });
    expect(evaluateSend("ABCDE", sent).score).toMatchObject({ longCharGaps: 1, deduction: 1 });
    expect(evaluateSend("ABCDEFGHIJ", words).score).toMatchObject({ longWordGaps: 1, deduction: 1 });
  });
});

describe("sending quality notes", () => {
  it("warns about tight character gaps and short word gaps", () => {
    const { quality } = evaluateSend("ABCDEFGHIJ", sendText("ABCDE FGHIJ", { charGap: 2.2, wordGap: 4 }));
    expect(quality.notes.join("\n")).toMatch(/無間隔ぎみ/);
    expect(quality.notes.join("\n")).toMatch(/語間が短い/);
  });

  it("warns about a dash/dot ratio far from 3", () => {
    const { quality } = evaluateSend("TTTEE", sendText("TTTEE", { dash: 2.2 }));
    expect(quality.dashRatio).toBeCloseTo(2.2);
    expect(quality.notes.join("\n")).toMatch(/2\.2 倍/);
  });

  it("reports speed change between halves", () => {
    const fast = sendText("ABCDE FGHIJ");
    const slow = sendText("KLMNO PQRST", { charGap: 8, wordGap: 16 }, fast.at(-1)!.end + 7 * DOT);
    const { quality } = evaluateSend("ABCDEFGHIJKLMNOPQRST", [...fast, ...slow]);
    expect(quality.cpmHalves![1]).toBeLessThan(quality.cpmHalves![0]);
    expect(quality.notes.join("\n")).toMatch(/遅く/);
  });
});

describe("helpers", () => {
  it("recognizes HH", () => {
    expect(isCorrection("........")).toBe(true);
    expect(isCorrection(".........")).toBe(true);
    expect(isCorrection(".......")).toBe(false);
  });

  it("finds elements between 1/2 and 2/3 of the nearest dash", () => {
    expect(isUnclear(sentCode("-.", 0, 3, "N", [3 * DOT, DOT]))).toBe(false);
    expect(isUnclear(sentCode("-.", 0, 3, "N", [3 * DOT, 1.8 * DOT]))).toBe(true);
    expect(isUnclear(sentCode("--", 0, 3, "M", [3 * DOT, 2 * DOT]))).toBe(true);
    expect(isUnclear(sentCode("...", 0, 3, "S"))).toBe(false);
  });
});
