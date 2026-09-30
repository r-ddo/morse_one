import { describe, expect, it } from "vitest";
import { backupFileName, makeBackup, parseBackup } from "./backup";
import { DEFAULT_SETTINGS } from "./settings";

const data = {
  attempts: [{ ts: 1, mode: "single" as const, target: "A", answer: "A", correct: true, rtMs: 300, cwpm: 25, freq: 650 }],
  charStats: [{ char: "A", attempts: 1, correct: 1, accEma: 1, rtEma: 300, lastSeen: 1 }],
  mocks: [],
};

describe("backup", () => {
  it("round-trips through JSON", () => {
    const b = makeBackup(data, DEFAULT_SETTINGS, new Date("2026-09-30T00:00:00Z"));
    expect(parseBackup(JSON.stringify(b))).toEqual(b);
  });

  it("names the file by date", () => {
    expect(backupFileName(new Date(2026, 8, 30))).toBe("morse_one-20260930.json");
  });

  it("rejects other files", () => {
    expect(() => parseBackup("not json")).toThrow("JSON として読めません");
    expect(() => parseBackup(JSON.stringify({ app: "other" }))).toThrow("バックアップではありません");
  });

  it("rejects broken records", () => {
    const b = makeBackup(data, DEFAULT_SETTINGS);
    const broken = { ...b, attempts: [{ ts: "x" }] };
    expect(() => parseBackup(JSON.stringify(broken))).toThrow("解答の記録が壊れています");
  });

  it("rejects backups from a newer version", () => {
    const b = { ...makeBackup(data, DEFAULT_SETTINGS), version: 99 };
    expect(() => parseBackup(JSON.stringify(b))).toThrow("新しいバージョン");
  });
});
