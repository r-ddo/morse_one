import { describe, expect, it } from "vitest";
import { averageCodeUnits, charsPerMinute, farnsworth, maxCharsPerMinute, timingForCharRate } from "./timing";

describe("farnsworth", () => {
  it("uses standard spacing when effective speed equals character speed", () => {
    const t = farnsworth(20, 20);
    expect(t.dot).toBeCloseTo(0.06);
    expect(t.charGap).toBeCloseTo(0.18);
    expect(t.wordGap).toBeCloseTo(0.42);
  });

  it("makes PARIS plus a word gap last one minute divided by the effective speed", () => {
    const cwpm = 25;
    const ewpm = 10;
    const t = farnsworth(cwpm, ewpm);
    // PARIS の発音部分と文字内の間は 31 dot、文字間 4 回、語間 1 回
    const total = 31 * t.dot + 4 * t.charGap + t.wordGap;
    expect(total).toBeCloseTo(60 / ewpm);
    expect(t.dot).toBeCloseTo(1.2 / cwpm);
  });
});

describe("charsPerMinute / timingForCharRate", () => {
  const avg = averageCodeUnits([".-", "-..."]); // A=5, B=9 → 7

  it("averages code lengths in dot units", () => {
    expect(avg).toBe(7);
  });

  it("round-trips a character rate", () => {
    const t = timingForCharRate(25, 60, avg);
    expect(charsPerMinute(t, avg)).toBeCloseTo(60);
    expect(t.dot).toBeCloseTo(1.2 / 25);
    expect(t.wordGap / t.charGap).toBeCloseTo(7 / 3);
  });

  it("does not shrink gaps below standard spacing", () => {
    const t = timingForCharRate(10, 500, avg);
    expect(t.charGap).toBeCloseTo(3 * t.dot);
  });
});

describe("maxCharsPerMinute", () => {
  it("matches the exam-rate estimates for random characters", () => {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    const codes = {
      A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.", H: "....", I: "..",
      J: ".---", K: "-.-", L: ".-..", M: "--", N: "-.", O: "---", P: ".--.", Q: "--.-", R: ".-.",
      S: "...", T: "-", U: "..-", V: "...-", W: ".--", X: "-..-", Y: "-.--", Z: "--..",
    } as Record<string, string>;
    const avg = averageCodeUnits(letters.map((c) => codes[c]));
    // 英字のみの暗語で 80 字/分 ≒ 19.2 WPM（標準間隔）
    expect(maxCharsPerMinute(19.2, avg)).toBeCloseTo(80, 0);
  });
});
