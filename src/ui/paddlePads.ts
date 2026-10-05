import type { Paddle } from "../audio/paddle";
import type { ScreenContext } from "./context";
import { h } from "./dom";
import { field, select } from "./form";

/** パッドで操作する相手（VirtualPaddle など） */
export interface PaddleTarget {
  press(p: Paddle): void;
  release(p: Paddle): void;
}

/** 画面のパドルの設定（速度・左右の入れ替え）。onChange は設定を変えたあとに呼ぶ */
export function paddleSettingsCard(ctx: ScreenContext, onChange: () => void = () => {}): HTMLElement {
  const s = ctx.settings;
  const swap = h("input", { type: "checkbox", checked: s.paddleSwap });
  swap.addEventListener("change", () => {
    ctx.updateSettings({ paddleSwap: swap.checked });
    onChange();
  });
  return h("div", { class: "settings" },
    field("パドルの速度", select(
      [10, 12, 14, 16, 18, 20, 22, 25, 28, 30].map((v) => [String(v), `${v} WPM`]),
      String(s.paddleWpm),
      (v) => {
        ctx.updateSettings({ paddleWpm: Number(v) });
        onChange();
      },
    )),
    h("label", { class: "check" }, swap, h("span", {}, "左右を入れ替える（既定は左が短点）")),
    h("p", { class: "note" },
      "スクイーズ式（iambic B）のエレキーです。画面下の左右のパッドを人差し指と中指で押します。" +
      "パソコンではキーボードの ↓（左のパッド）と →（右のパッド）でも操作できます"),
  );
}

/**
 * 画面のパドル。左右のパッドをタッチ（複数の指を同時に）で押し、キーボードでは ↓ が左・→ が右。
 * 既定は左が短点・右が長点で、swap なら入れ替える
 */
export function paddlePads(paddle: PaddleTarget, swap: boolean) {
  const sides: [Paddle, Paddle] = swap ? ["dash", "dot"] : ["dot", "dash"];
  const keys: Record<string, 0 | 1> = { ArrowDown: 0, ArrowRight: 1 };
  /** パッドごとに押している指（ポインター）とキー */
  const pressing = [new Set<number | string>(), new Set<number | string>()];
  const press = (i: 0 | 1, who: number | string) => {
    const set = pressing[i];
    if (set.has(who)) return;
    set.add(who);
    if (set.size === 1) {
      pads[i].classList.add("pressed");
      paddle.press(sides[i]);
    }
  };
  const release = (i: 0 | 1, who: number | string) => {
    const set = pressing[i];
    if (!set.delete(who) || set.size > 0) return;
    pads[i].classList.remove("pressed");
    paddle.release(sides[i]);
  };
  const releaseAll = () => {
    for (const i of [0, 1] as const) for (const who of [...pressing[i]]) release(i, who);
  };

  const pads = ([0, 1] as const).map((i) => {
    const pad = h("div", { class: "paddle-pad" },
      h("span", { class: "paddle-code" }, sides[i] === "dot" ? "·" : "−"),
      h("span", { class: "paddle-key" }, i === 0 ? "↓" : "→"));
    pad.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      // 指を少し動かしても離したことにならないよう、ポインターを捕まえておく
      pad.setPointerCapture(e.pointerId);
      press(i, e.pointerId);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
      pad.addEventListener(type, (e) => release(i, e.pointerId));
    }
    pad.addEventListener("contextmenu", (e) => e.preventDefault());
    return pad;
  });

  const onKeyUp = (e: KeyboardEvent) => {
    const i = keys[e.key];
    if (i !== undefined) release(i, e.key);
  };
  document.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", releaseAll);

  return {
    el: h("div", { class: "paddle-pads" }, ...pads),
    /** キーを押したとき。パドルのキーなら true */
    key(e: KeyboardEvent): boolean {
      const i = keys[e.key];
      if (i === undefined) return false;
      if (!e.repeat) press(i, e.key);
      return true;
    },
    detach(): void {
      document.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseAll);
    },
  };
}

