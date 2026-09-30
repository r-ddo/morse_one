import { describe, expect, it } from "vitest";
import { newStat, UNSEEN_WEAKNESS, updateStat, weakness } from "./stats";

describe("updateStat", () => {
  it("initializes averages from the first outcome", () => {
    const s = updateStat(newStat("A"), { correct: true, rtMs: 400, ts: 1 });
    expect(s).toMatchObject({ attempts: 1, correct: 1, accEma: 1, rtEma: 400, lastSeen: 1 });
  });

  it("does not update reaction time on a miss", () => {
    const s1 = updateStat(newStat("A"), { correct: true, rtMs: 400, ts: 1 });
    const s2 = updateStat(s1, { correct: false, rtMs: null, ts: 2 });
    expect(s2.rtEma).toBe(400);
    expect(s2.accEma).toBeCloseTo(0.8);
  });
});

describe("weakness", () => {
  it("treats unseen characters as weak", () => {
    expect(weakness(undefined, 1000, 0)).toBe(UNSEEN_WEAKNESS);
  });

  it("ranks slow or wrong characters above fast correct ones", () => {
    const now = 1000;
    const fast = updateStat(newStat("A"), { correct: true, rtMs: 200, ts: now });
    const slow = updateStat(newStat("B"), { correct: true, rtMs: 900, ts: now });
    const wrong = updateStat(newStat("C"), { correct: false, rtMs: null, ts: now });
    expect(weakness(slow, 1000, now)).toBeGreaterThan(weakness(fast, 1000, now));
    expect(weakness(wrong, 1000, now)).toBeGreaterThan(weakness(slow, 1000, now));
  });
});
