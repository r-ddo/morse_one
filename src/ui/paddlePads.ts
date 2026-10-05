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

const GESTURE_EVENTS = ["gesturestart", "gesturechange", "gestureend"] as const;
const preventGesture = (e: Event) => e.preventDefault();

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
    // タッチは下のタッチイベントで受け取る。ポインターイベントはマウスとペンだけ
    pad.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") return;
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
  // iOS Safari は、指を置いたまま別の指で触れると 2 本指の操作（ピンチでの拡大など）の始まりとみなし、
  // 2 本目のタッチを数百ミリ秒止めてから渡す（実機の記録で確認）。その操作（iOS 独自の gesture*）を止める
  for (const type of GESTURE_EVENTS) document.addEventListener(type, preventGesture, { passive: false });

  const el = h("div", { class: `paddle-pads${specs.length === 1 ? " single" : ""}` }, ...pads);

  // タッチ。iOS Safari ではポインターイベントだと、指を素早く交互に使ったときや連打したときに押したことを取りこぼすので、
  // タッチイベントで指ごとに受け取る。指は触れたパッドのものとし、離すまで動かしても変えない
  /** 触れている指（Touch.identifier）と、そのパッド */
  const touches = new Map<number, number>();
  const touchId = (id: number) => `touch${id}`;
  const endTouch = (id: number) => {
    const i = touches.get(id);
    if (i === undefined) return;
    touches.delete(id);
    release(i, touchId(id));
  };
  /** 終わりを受け取りそこねた指を離したことにする */
  const sweep = (e: TouchEvent) => {
    const alive = new Set([...e.touches].map((t) => t.identifier));
    for (const id of [...touches.keys()]) if (!alive.has(id)) endTouch(id);
  };
  // iOS Safari は touch-action だけでは素早い 2 回のタップを拡大と見なすことがあるので、既定の動作も止める。
  // パッドの間のすき間も含める
  el.addEventListener("touchstart", (e) => {
    e.preventDefault();
    sweep(e);
    for (const t of e.changedTouches) {
      const i = pads.findIndex((pad) => pad.contains(t.target as Node));
      if (i < 0) continue;
      // 同じ番号の指が残っていれば（終わりを受け取りそこね、番号が使い回された）、先に離したことにする
      endTouch(t.identifier);
      touches.set(t.identifier, i);
      press(i, touchId(t.identifier));
    }
  }, { passive: false });
  for (const type of ["touchend", "touchcancel"] as const) {
    el.addEventListener(type, (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) endTouch(t.identifier);
      sweep(e);
    }, { passive: false });
  }

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
      for (const type of GESTURE_EVENTS) document.removeEventListener(type, preventGesture);
    },
  };
}
