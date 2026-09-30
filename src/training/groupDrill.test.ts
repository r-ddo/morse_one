import { describe, expect, it } from "vitest";
import { gradeGroup, UNKNOWN } from "./groupDrill";

describe("gradeGroup", () => {
  it("grades each position independently", () => {
    expect(gradeGroup("AB5QZ", "AB6QZ")).toEqual([true, true, false, true, true]);
  });

  it("marks unknown and missing positions as wrong", () => {
    expect(gradeGroup("ABCDE", `A${UNKNOWN}C`)).toEqual([true, false, true, false, false]);
  });
});
