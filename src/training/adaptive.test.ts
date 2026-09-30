import { describe, expect, it } from "vitest";
import { adaptLimit, giveUpMs, MAX_LIMIT_MS, MIN_LIMIT_MS } from "./adaptive";

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
