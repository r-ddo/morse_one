import { DIGITS, LETTERS, SYMBOLS } from "../training/charset";
import { h } from "./dom";

const ROWS = [DIGITS.slice(1) + DIGITS[0], "QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM", SYMBOLS];

export interface KeyAction {
  label: string;
  onPress: () => void;
  class?: string;
}

function key(label: string, className: string, onPress: () => void): HTMLButtonElement {
  const el = h("button", { class: className, type: "button", textContent: label });
  // click より反応が速い pointerdown を使う
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.classList.add("pressed");
    setTimeout(() => el.classList.remove("pressed"), 120);
    onPress();
  });
  return el;
}

/** 専用の画面キーボード。出題対象の文字だけを表示し、最下段に操作キーを置ける */
export function createKeyboard(
  chars: readonly string[],
  onKey: (ch: string) => void,
  actions: KeyAction[] = [],
): HTMLElement {
  const allowed = new Set(chars);
  const kb = h("div", { class: "keyboard" });
  for (const row of ROWS) {
    const keys = [...row].filter((c) => allowed.has(c));
    if (keys.length === 0) continue;
    kb.append(h("div", { class: "kb-row" },
      ...keys.map((k) => key(k, LETTERS.includes(k) ? "key" : "key key-sub", () => onKey(k))),
    ));
  }
  if (actions.length > 0) {
    kb.append(h("div", { class: "kb-row" },
      ...actions.map((a) => key(a.label, `key key-action ${a.class ?? ""}`, a.onPress)),
    ));
  }
  return kb;
}
