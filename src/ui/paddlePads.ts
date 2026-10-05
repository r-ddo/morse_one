import type { Paddle } from "../audio/paddle";
import type { SendInput } from "../storage/settings";
import type { ScreenContext } from "./context";
import { h } from "./dom";
import { field, select } from "./form";

/** パッドで操作する相手（VirtualPaddle など） */
export interface PaddleTarget {
  press(p: Paddle): void;
  release(p: Paddle): void;
}

/** 送信の入力の選択肢 */
export const INPUT_OPTIONS: [SendInput, string][] = [
  ["mic", "練習機の音（マイク）"],
  ["paddle", "画面のパドル"],
  ["straight", "画面の縦振電鍵"],
];

/** 画面の縦振電鍵の説明 */
export function straightKeyNote(): HTMLElement {
  return h("p", { class: "note" },
    "画面下の大きなパッドを押している間だけ鳴ります（パソコンではキーボードの ↓ か →）。" +
    "符号の長さも速度も自分で決めるので、速度は送り方から推定し続けます");
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
export function paddlePads(paddle: PaddleTarget, swap: boolean): TouchPads {
  const sides: [Paddle, Paddle] = swap ? ["dash", "dot"] : ["dot", "dash"];
  return touchPads(sides.map((side, i) => ({
    label: side === "dot" ? "·" : "−",
    hint: i === 0 ? "↓" : "→",
    keys: [i === 0 ? "ArrowDown" : "ArrowRight"],
    press: () => paddle.press(side),
    release: () => paddle.release(side),
  })));
}

/** 画面の縦振電鍵。1 つの大きなパッドを押している間だけキーを下げる。キーボードでは ↓ か → */
export function straightKeyPad(key: { press(): void; release(): void }): TouchPads {
  return touchPads([{
    label: "電鍵",
    hint: "押している間だけ鳴ります（↓ / →）",
    keys: ["ArrowDown", "ArrowRight"],
    press: () => key.press(),
    release: () => key.release(),
  }]);
}

export interface TouchPads {
  el: HTMLElement;
  /** キーを押したとき。パッドのキーなら true */
  key(e: KeyboardEvent): boolean;
  detach(): void;
}

interface PadSpec {
  label: string;
  hint: string;
  /** このパッドを押すキー（KeyboardEvent.key） */
  keys: string[];
  press(): void;
  release(): void;
}

/** タッチとキーボードで押すパッドを並べる。同じパッドを複数の指・キーで押しても、押す・離すは 1 回ずつ */
function touchPads(specs: PadSpec[]): TouchPads {
  const keys = new Map<string, number>();
  specs.forEach((spec, i) => spec.keys.forEach((k) => keys.set(k, i)));
  /** パッドごとに押している指（ポインター）とキー */
  const pressing = specs.map(() => new Set<number | string>());
  const press = (i: number, who: number | string) => {
    const set = pressing[i];
    if (set.has(who)) return;
    set.add(who);
    if (set.size === 1) {
      pads[i].classList.add("pressed");
      specs[i].press();
    }
  };
  const release = (i: number, who: number | string) => {
    const set = pressing[i];
    if (!set.delete(who) || set.size > 0) return;
    pads[i].classList.remove("pressed");
    specs[i].release();
  };
  const releaseAll = () => {
    pressing.forEach((set, i) => [...set].forEach((who) => release(i, who)));
  };

  const pads = specs.map((spec, i) => {
    const pad = h("div", { class: "paddle-pad" },
      h("span", { class: "paddle-code" }, spec.label),
      h("span", { class: "paddle-key" }, spec.hint));
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
    const i = keys.get(e.key);
    if (i !== undefined) release(i, e.key);
  };
  document.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", releaseAll);

  const el = h("div", { class: `paddle-pads${specs.length === 1 ? " single" : ""}` }, ...pads);
  // iOS Safari は touch-action だけでは素早い 2 回のタップを拡大と見なすことがあるので、タッチの既定の動作を止める。
  // パッドの間のすき間も含める（ポインターイベントは止まらない）
  el.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });

  return {
    el,
    key(e: KeyboardEvent): boolean {
      const i = keys.get(e.key);
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
