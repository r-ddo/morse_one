import { DIGITS, LETTERS, SYMBOLS } from "../training/charset";
import { h } from "./dom";

const ROWS = [DIGITS.slice(1) + DIGITS[0], "QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM", SYMBOLS];

/** 専用の画面キーボード。出題対象の文字だけを表示する */
export function createKeyboard(chars: readonly string[], onKey: (ch: string) => void): HTMLElement {
  const allowed = new Set(chars);
  const kb = h("div", { class: "keyboard" });
  for (const row of ROWS) {
    const keys = [...row].filter((c) => allowed.has(c));
    if (keys.length === 0) continue;
    const rowEl = h("div", { class: "kb-row" });
    for (const k of keys) {
      const key = h("button", { class: "key", type: "button", textContent: k });
      if (!LETTERS.includes(k)) key.classList.add("key-sub");
      // click より反応が速い pointerdown を使う
      key.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        key.classList.add("pressed");
        setTimeout(() => key.classList.remove("pressed"), 120);
        onKey(k);
      });
      rowEl.append(key);
    }
    kb.append(rowEl);
  }
  return kb;
}
