import { describe, expect, it } from "vitest";
import { niceMax } from "./chart";

describe("niceMax", () => {
  it("rounds up to a clean axis maximum", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(120)).toBe(200);
    expect(niceMax(230)).toBe(250);
    expect(niceMax(0.83)).toBe(1);
    expect(niceMax(1400)).toBe(2000);
  });
});
