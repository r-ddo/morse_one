import { h } from "./dom";

/** 例: "5 WPM"、"5.5 WPM" */
export function wpm(v: number): string {
  return `${Number.isInteger(v) ? v : v.toFixed(1)} WPM`;
}

/** 例: "1.5 秒"、"1.25 秒" */
export function sec(ms: number): string {
  return `${(ms / 1000).toFixed(ms % 100 === 0 ? 1 : 2)} 秒`;
}

export function field(label: string, control: HTMLElement): HTMLElement {
  return h("label", { class: "field" }, h("span", {}, label), control);
}

export function select(options: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const el = h("select", {}, ...options.map(([v, l]) => h("option", { value: v, textContent: l })));
  el.value = value;
  el.addEventListener("change", () => onChange(el.value));
  return el;
}

export function range(
  min: number,
  max: number,
  step: number,
  value: number,
  format: (v: number) => string,
  onChange: (v: number) => void,
): HTMLElement {
  const out = h("span", { class: "range-value", textContent: format(value) });
  const input = h("input", { type: "range", min: String(min), max: String(max), step: String(step) });
  input.value = String(value);
  input.addEventListener("input", () => {
    out.textContent = format(Number(input.value));
    onChange(Number(input.value));
  });
  return h("span", { class: "range" }, input, out);
}

/** 文字速度では設定の字数に届かないときの注意書き。届くなら空文字 */
export function speedLimitNote(cpm: number, maxCpm: number, cwpm: number): string {
  if (cpm <= maxCpm) return "";
  return `文字速度 ${cwpm} WPM では最大 約 ${Math.floor(maxCpm)} 字/分です。ホームの設定で文字速度を上げてください`;
}
