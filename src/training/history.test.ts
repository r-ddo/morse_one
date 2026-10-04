import { describe, expect, it } from "vitest";
import type { Attempt } from "../storage/db";
import { dailySends, dailyStats, dayKey, streakDays } from "./history";

const now = new Date(2026, 8, 30, 20, 0).getTime();
const at = (daysAgo: number, hour = 12) => new Date(2026, 8, 30 - daysAgo, hour).getTime();
const base = { answer: null, cwpm: 25, freq: 650, rtMs: null };

const attempts: Attempt[] = [
  { ...base, ts: at(0), mode: "single", target: "A", answer: "A", correct: true, rtMs: 400 },
  { ...base, ts: at(0), mode: "single", target: "B", answer: "B", correct: true, rtMs: 600 },
  { ...base, ts: at(0), mode: "single", target: "C", correct: false },
  { ...base, ts: at(0), mode: "contrast", target: "H", answer: "H", correct: true, rtMs: 100 },
  { ...base, ts: at(2), mode: "group", target: "D", correct: true, ewpm: 6 },
  { ...base, ts: at(2), mode: "group", target: "E", correct: false, ewpm: 8 },
  { ...base, ts: at(1), mode: "stream", target: "F", correct: true, cpm: 40 },
];

describe("dailyStats", () => {
  const stats = dailyStats(attempts, 3, now);

  it("returns every day oldest first, including empty days", () => {
    expect(stats.map((s) => s.label)).toEqual(["9/28", "9/29", "9/30"]);
  });

  it("aggregates per mode and skips two-choice drills", () => {
    expect(stats[2]).toMatchObject({ chars: 3, correct: 2, rtMs: 500, ewpm: null, cpm: null });
    expect(stats[1]).toMatchObject({ chars: 1, cpm: 40 });
    expect(stats[0]).toMatchObject({ chars: 2, correct: 1, ewpm: 7 });
  });

  it("uses local dates", () => {
    expect(dayKey(new Date(2026, 8, 30, 0, 5).getTime())).toBe("2026-09-30");
  });
});

describe("streakDays", () => {
  it("counts consecutive days up to today", () => {
    expect(streakDays(attempts, now)).toBe(3);
  });

  it("still counts yesterday's streak before practicing today", () => {
    expect(streakDays(attempts.filter((a) => a.ts < at(0, 0)), now)).toBe(2);
  });

  it("is zero after a missed day", () => {
    expect(streakDays(attempts.filter((a) => a.ts < at(1, 0)), now)).toBe(0);
  });
});

describe("dailySends", () => {
  it("averages points and speed per day", () => {
    const today = new Date(2026, 9, 4, 12).getTime();
    const base = {
      mode: "group" as const, target: "", sent: [], charset: "alnum", wrong: 0, missing: 0, extra: 0, unclear: 0,
      unsent: 0, corrections: 0, longCharGaps: 0, longWordGaps: 0, deduction: 0, wpm: 20, dashRatio: 3,
      charGap: 3, charGapCv: 0, wordGap: 7, wordGapCv: 0,
    };
    const days = dailySends([
      { ...base, ts: today - 1000, points: 90, cpm: 70 },
      { ...base, ts: today - 2000, points: 100, cpm: null },
    ], 3, today);
    expect(days.map((d) => d.label)).toEqual(["10/2", "10/3", "10/4"]);
    expect(days[2]).toMatchObject({ points: 95, cpm: 70 });
    expect(days[0]).toMatchObject({ points: null, cpm: null });
  });
});
