import { describe, expect, it } from "vitest";
import type { SendRecord } from "../storage/db";
import { sendCharStats, sendConfusions, sendErrorRate, sendWeights, weakSendChars } from "./sendWeak";

function record(target: string, marks: string, sentAt: (string | null)[], ts = 1000): SendRecord {
  return {
    ts, mode: "group", target, sent: [], charset: "letters", wrong: 0, missing: 0, extra: 0, unclear: 0, unsent: 0,
    corrections: 0, longCharGaps: 0, longWordGaps: 0, deduction: 0, points: 100, cpm: 80, wpm: 20, dashRatio: 3,
    charGap: 3, charGapCv: 0, wordGap: 7, wordGapCv: 0, marks, sentAt,
  };
}

describe("sendCharStats", () => {
  const records = [
    record("HHAB", "wouo", ["5", "H", "A", "B"]),
    record("HAB-", "wom-", ["5", "A", null, null]),
    record("HHH", "ooo", ["H", "H", "H"], 10),
  ];

  it("counts attempts, errors, unclear codes and confusions, skipping unsent", () => {
    const stats = sendCharStats(records);
    expect(stats.get("H")).toMatchObject({ attempts: 6, errors: 2, unclear: 0 });
    expect(stats.get("A")).toMatchObject({ attempts: 2, errors: 0, unclear: 1 });
    expect(stats.get("B")).toMatchObject({ attempts: 2, errors: 1 });
    expect(stats.has("-")).toBe(false);
    expect(sendConfusions(stats, 5)).toEqual([["H", "5", 2]]);
  });

  it("ignores records before since and old records without marks", () => {
    const { marks: _, ...old } = record("ZZ", "ww", ["X", "X"]);
    const stats = sendCharStats([...records, old], 500);
    expect(stats.get("H")).toMatchObject({ attempts: 3, errors: 2 });
    expect(stats.has("Z")).toBe(false);
  });

  it("weights weak characters up and lists them", () => {
    const stats = sendCharStats(records);
    const [h, a, z] = sendWeights(stats, ["H", "A", "Z"]);
    expect(h).toBeGreaterThan(a);
    expect(z).toBeCloseTo(1 + 8 * sendErrorRate(undefined));
    // H は 6 回中 2 回（事前分布込みで 24%）、B は 2 回中 1 回（23%）、A は不明りょう 1 回（15%）
    expect(weakSendChars(stats, 3, 2).map((s) => s.char)).toEqual(["H", "B", "A"]);
  });
});
