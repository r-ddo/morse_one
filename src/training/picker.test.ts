import { describe, expect, it } from "vitest";
import { pickChar } from "./picker";
import { newStat, updateStat, type CharStat } from "./stats";

function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

describe("pickChar", () => {
  it("never repeats the excluded character", () => {
    const random = seeded(1);
    for (let i = 0; i < 200; i++) {
      expect(pickChar(["A", "B"], new Map(), { limitMs: 1000, now: 0, exclude: "A", random })).toBe("B");
    }
  });

  it("picks weak characters more often", () => {
    const now = 0;
    const stats = new Map<string, CharStat>();
    for (const c of "ABCDEFGHIJ") {
      stats.set(c, updateStat(newStat(c), { correct: true, rtMs: 200, ts: now }));
    }
    stats.set("Z", updateStat(newStat("Z"), { correct: false, rtMs: null, ts: now }));

    const chars = [..."ABCDEFGHIJZ"];
    const random = seeded(42);
    let z = 0;
    const n = 5000;
    for (let i = 0; i < n; i++) {
      if (pickChar(chars, stats, { limitMs: 1000, now, random }) === "Z") z++;
    }
    // 一様なら 1/11 ≒ 9%
    expect(z / n).toBeGreaterThan(0.15);
  });
});
