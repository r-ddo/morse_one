import { describe, expect, it } from "vitest";
import { farnsworth } from "./timing";

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
