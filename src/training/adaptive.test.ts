import { describe, expect, it } from "vitest";
import { adaptEwpm, adaptLimit, giveUpMs, MAX_LIMIT_MS, MIN_EWPM, MIN_LIMIT_MS } from "./adaptive";

describe("adaptLimit", () => {
  it("tightens when almost all answers are within the limit", () => {
    expect(adaptLimit(3000, 0.9)).toBe(2700);
  });

  it("loosens when many answers are slow or wrong", () => {
    expect(adaptLimit(2000, 0.5)).toBe(2300);
  });

  it("keeps the limit in between", () => {
    expect(adaptLimit(2000, 0.7)).toBe(2000);
  });

  it("stays within bounds", () => {
    expect(adaptLimit(MIN_LIMIT_MS, 1)).toBe(MIN_LIMIT_MS);
    expect(adaptLimit(MAX_LIMIT_MS, 0)).toBe(MAX_LIMIT_MS);
  });
});

describe("giveUpMs", () => {
  it("waits three times the limit, between 3 and 10 seconds", () => {
    expect(giveUpMs(500)).toBe(3000);
    expect(giveUpMs(2000)).toBe(6000);
    expect(giveUpMs(5000)).toBe(10000);
  });
});

describe("adaptEwpm", () => {
  it("speeds up by about 10% when accuracy is high", () => {
    expect(adaptEwpm(10, 0.95, 25)).toBe(11);
  });

  it("slows down by about 10% when accuracy is low", () => {
    expect(adaptEwpm(10, 0.7, 25)).toBe(9);
  });

  it("keeps the speed in between", () => {
    expect(adaptEwpm(10, 0.85, 25)).toBe(10);
  });

  it("always moves by at least half a WPM", () => {
    expect(adaptEwpm(3, 1, 25)).toBe(3.5);
    expect(adaptEwpm(3, 0, 25)).toBe(2.5);
  });

  it("stays between the minimum and the character speed", () => {
    expect(adaptEwpm(MIN_EWPM, 0, 25)).toBe(MIN_EWPM);
    expect(adaptEwpm(24.5, 1, 25)).toBe(25);
  });
});
