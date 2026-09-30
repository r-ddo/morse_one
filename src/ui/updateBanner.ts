import { h } from "./dom";

let current: HTMLElement | null = null;

/** 画面上部に短いお知らせを出す。action を渡すとボタンを付ける */
export function showBanner(message: string, action?: { label: string; onClick: () => void }): void {
  current?.remove();
  const close = () => {
    banner.remove();
    if (current === banner) current = null;
  };
  const banner = h("div", { class: "banner", role: "status" },
    h("span", {}, message),
    action ? h("button", { type: "button", class: "small primary", onclick: action.onClick }, action.label) : null,
    h("button", { type: "button", class: "small", onclick: close, ariaLabel: "閉じる" }, "×"),
  );
  document.body.append(banner);
  current = banner;
  if (!action) setTimeout(close, 4000);
}
