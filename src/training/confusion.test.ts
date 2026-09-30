import { describe, expect, it } from "vitest";
import { ConfusionTracker, HALF_LIFE_DAYS } from "./confusion";

const DAY = 86_400_000;

describe("ConfusionTracker", () => {
  it("merges both directions into one pair", () => {
    const t = new ConfusionTracker();
    t.add("H", "5", 0);
    t.add("5", "H", 0);
    expect(t.top(10, 0)).toEqual([{ a: "5", b: "H", weight: 2, count: 2 }]);
  });

  it("ignores correct answers", () => {
    const t = new ConfusionTracker();
    t.add("A", "A", 0);
    expect(t.top(10, 0)).toEqual([]);
  });

  it("halves the weight after the half-life", () => {
    const t = new ConfusionTracker();
    t.add("B", "6", 0);
    expect(t.top(1, HALF_LIFE_DAYS * DAY)[0].weight).toBeCloseTo(0.5);
  });

  it("ranks recent confusions above older ones with the same count", () => {
    const t = new ConfusionTracker();
    const now = 60 * DAY;
    t.add("B", "6", 0);
    t.add("V", "4", now);
    expect(t.top(2, now).map((p) => p.a + p.b)).toEqual(["4V", "6B"]);
  });
});
