import { describe, expect, it } from "vitest";
import { charEndTimes, toIntervals } from "./player";

const timing = { dot: 1, charGap: 3, wordGap: 7 };

describe("toIntervals", () => {
  it("converts a character into dots and dashes separated by one dot", () => {
    expect(toIntervals("A", timing)).toEqual([[0, 1], [2, 5]]);
  });

  it("separates characters with the character gap and words with the word gap", () => {
    expect(toIntervals("E E", timing)).toEqual([[0, 1], [8, 9]]);
    expect(toIntervals("EE", timing)).toEqual([[0, 1], [4, 5]]);
  });

  it("ignores lowercase differences and unknown characters", () => {
    expect(toIntervals("e#", timing)).toEqual([[0, 1]]);
  });
});

describe("charEndTimes", () => {
  it("returns when each non-space character finishes", () => {
    // A: 0-1, 2-5 / 語間 7 / E: 12-13
    expect(charEndTimes("A E", timing)).toEqual([5, 13]);
  });
});
