import { describe, expect, it } from "vitest";
import { IambicKeyer } from "./paddle";

/** キーヤーを作り、[下げた時刻, 上げた時刻] の一覧を集める（短点長 1 秒） */
function keyer() {
  const marks: [number, number][] = [];
  const k = new IambicKeyer(1, (down, t) => {
    if (down) marks.push([t, NaN]);
    else marks[marks.length - 1][1] = t;
  });
  return { k, marks };
}

describe("IambicKeyer", () => {
  it("sends one dot for a short tap", () => {
    const { k, marks } = keyer();
    k.press("dot", 0);
    k.release("dot", 0.2);
    k.advance(10);
    expect(marks).toEqual([[0, 1]]);
    expect(k.idle).toBe(true);
  });

  it("repeats while a paddle is held, one dot apart", () => {
    const { k, marks } = keyer();
    k.press("dash", 0);
    k.release("dash", 9);
    k.advance(20);
    // 0–3, 4–7, 8–11（8 秒の時点でまだ押している）
    expect(marks).toEqual([[0, 3], [4, 7], [8, 11]]);
  });

  it("alternates while both paddles are squeezed", () => {
    const { k, marks } = keyer();
    k.press("dash", 0);
    k.press("dot", 0.5);
    k.release("dash", 10.5);
    k.release("dot", 10.5);
    k.advance(20);
    // 4 つ目の短点の途中で両方離すと、B モードで反対側（長点）をもう 1 つ出す
    expect(marks).toEqual([[0, 3], [4, 5], [6, 9], [10, 11], [12, 15]]);
  });

  it("stops after the current element when both are released in the space before it", () => {
    const { k, marks } = keyer();
    k.press("dash", 0);
    k.press("dot", 0.5);
    k.release("dash", 9.5);
    k.release("dot", 9.5);
    k.advance(20);
    // 長点 6–9 を出し始めたときに覚えた短点だけ出す（C）
    expect(marks).toEqual([[0, 3], [4, 5], [6, 9], [10, 11]]);
  });

  it("remembers a paddle tapped during an element", () => {
    const { k, marks } = keyer();
    k.press("dash", 0);
    k.release("dash", 0.5);
    k.press("dot", 1);
    k.release("dot", 1.2);
    k.advance(20);
    expect(marks).toEqual([[0, 3], [4, 5]]);
  });

  it("starts immediately after the keyer has gone idle", () => {
    const { k, marks } = keyer();
    k.press("dot", 0);
    k.release("dot", 0.5);
    k.press("dash", 5);
    k.release("dash", 5.5);
    k.advance(20);
    expect(marks).toEqual([[0, 1], [5, 8]]);
  });
});
