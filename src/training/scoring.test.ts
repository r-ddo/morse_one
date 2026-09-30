import { describe, expect, it } from "vitest";
import { examPoints, scoreExam, selfScore } from "./scoring";

describe("scoreExam", () => {
  it("scores a perfect copy", () => {
    const s = scoreExam("ABCDE", "ABCDE");
    expect(s).toMatchObject({ wrong: 0, missing: 0, extra: 0, deduction: 0 });
    expect(s.marks).toEqual(["ok", "ok", "ok", "ok", "ok"]);
  });

  it("counts a substitution as a wrong character (3 points)", () => {
    const s = scoreExam("ABCDE", "ABXDE");
    expect(s).toMatchObject({ wrong: 1, missing: 0, extra: 0, deduction: 3 });
    expect(s.typedAt[2]).toBe("X");
  });

  it("does not shift the rest after a dropped character", () => {
    const s = scoreExam("ABCDEFGHIJ", "ABDEFGHIJ");
    expect(s).toMatchObject({ wrong: 0, missing: 1, extra: 0, deduction: 1 });
    expect(s.marks[2]).toBe("missing");
  });

  it("counts an inserted character as extra (3 points)", () => {
    const s = scoreExam("ABCDE", "ABXCDE");
    expect(s).toMatchObject({ wrong: 0, missing: 0, extra: 1, deduction: 3 });
  });

  it("treats unknown marks as missing (1 point)", () => {
    const s = scoreExam("ABCDE", "AB_DE");
    expect(s).toMatchObject({ wrong: 0, missing: 1, extra: 0, deduction: 1 });
  });

  it("counts characters not typed at the end as missing", () => {
    const s = scoreExam("ABCDE", "AB");
    expect(s).toMatchObject({ missing: 3, deduction: 3 });
  });
});

describe("examPoints", () => {
  it("subtracts the deduction from 100 and floors at 0", () => {
    expect(examPoints(12, 400)).toBe(88);
    expect(examPoints(150, 400)).toBe(0);
  });

  it("scales the deduction to the exam length", () => {
    // 50 字で 3 点減点 → 400 字なら 24 点減点
    expect(examPoints(3, 50, 400)).toBe(76);
  });
});

describe("selfScore", () => {
  it("applies the exam deductions", () => {
    // 誤字 2（6）+ 脱字 5（5）+ 冗字 1（3）+ 訂正 4（2）= 16
    expect(selfScore(2, 5, 1, 4)).toBe(84);
  });

  it("floors at 0", () => {
    expect(selfScore(40, 0, 0, 0)).toBe(0);
  });
});
