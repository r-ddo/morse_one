import { h } from "./dom";
import { showBanner } from "./updateBanner";

/** 記録するイベント。iOS 独自の gesture* は 2 本指の操作（拡大など）の始まりと終わり */
const LOGGED_EVENTS = [
  "touchstart", "touchend", "touchcancel",
  "pointerdown", "pointerup", "pointercancel",
  "gesturestart", "gestureend", "dblclick",
] as const;

/** この時間（ミリ秒）より遅れて届いたタッチは、遅れも記録する */
const LATE_MS = 30;

export interface TouchLog {
  /** 記録の表示（live なら記録しながら更新する） */
  readonly el: HTMLElement;
  add(text: string): void;
  detach(): void;
}

/**
 * 画面のパドル・縦振電鍵が押したことを取りこぼす原因を実機で調べるための、届いたタッチの記録。
 * 文書全体で（パッドより先に）受け取り、触れた場所（左・右のパッドかそれ以外）と時刻（ミリ秒）を残す。
 * live でなければ記録するだけで、el は detach() したときの内容を表示する（送信中は画面を重くしない）
 */
export function touchLog({ live, max = live ? 60 : 300 }: { live: boolean; max?: number }): TouchLog {
  const lines: string[] = [];
  const pre = h("pre", { class: "touch-log" }, live ? "パッドを押すと、ここに届いたイベントを表示します" : "");
  let t0: number | null = null;
  let raf = 0;

  const render = () => {
    raf = 0;
    pre.textContent = lines.join("\n");
  };
  const add = (text: string) => {
    const now = performance.now();
    t0 ??= now;
    lines.unshift(`${String(Math.round(now - t0)).padStart(6)} ${text}`);
    if (lines.length > max) lines.length = max;
    if (live && !raf) raf = requestAnimationFrame(render);
  };
  const where = (target: EventTarget | null): string => {
    if (!(target instanceof Element)) return "?";
    const pad = target.closest(".paddle-pad");
    if (!pad) return target === document.documentElement || target === document.body ? "外" : `外(${target.className || target.tagName.toLowerCase()})`;
    const all = [...pad.parentElement!.children];
    return all.length === 1 ? "パッド" : all.indexOf(pad) === 0 ? "左" : "右";
  };
  /** 記録の欄そのもの（コピーのボタンや、選択しようとして触れたところ）のタッチは記録しない */
  const inCard = (target: EventTarget | null) => target instanceof Node && card.contains(target);
  const onEvent = (e: Event) => {
    if (e instanceof TouchEvent ? [...e.changedTouches].every((t) => inCard(t.target)) : inCard(e.target)) return;
    const lag = performance.now() - e.timeStamp;
    const late = lag >= LATE_MS && lag < 60_000 ? `（${Math.round(lag)} ms 遅れ）` : "";
    if (e instanceof TouchEvent) {
      const changed = [...e.changedTouches].map((t) => `#${t.identifier % 1000}${where(t.target)}`).join(" ");
      add(`${e.type} ${changed}（触れている指 ${e.touches.length}）${late}`);
    } else if (e instanceof PointerEvent) {
      add(`${e.type} ${e.pointerType} #${e.pointerId % 1000}${where(e.target)}${late}`);
    } else {
      add(`${e.type} ${where(e.target)}${late}`);
    }
  };
  for (const type of LOGGED_EVENTS) document.addEventListener(type, onEvent, { capture: true, passive: true });
  add(`版 ${__BUILD_ID__}`);

  const clear = () => {
    lines.length = 0;
    t0 = null;
    pre.textContent = "";
  };
  const copyBtn = h("button", { type: "button", class: "small" }, "コピー");
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(lines.join("\n")).then(
      () => {
        copyBtn.textContent = "コピーしました";
        setTimeout(() => (copyBtn.textContent = "コピー"), 1500);
      },
      (e) => showBanner(`コピーできませんでした（${e instanceof Error ? e.name : String(e)}）`),
    );
  });
  const card = h("div", { class: "chart-card" },
    h("div", { class: "chart-head" },
      h("h2", {}, "タッチの記録（新しい順）"),
      h("div", { class: "row" },
        copyBtn,
        live && h("button", { type: "button", class: "small", onclick: clear }, "消す"),
      ),
    ),
    h("p", { class: "note" },
      "左端は最初のイベントからのミリ秒。★☆ はアプリがパドル（電鍵）を押した・離したとき。" +
      "反応しなかったときに「コピー」で記録全体をコピーして送ってください"),
    pre,
  );
  return {
    el: card,
    add,
    detach(): void {
      cancelAnimationFrame(raf);
      for (const type of LOGGED_EVENTS) document.removeEventListener(type, onEvent, { capture: true });
      render();
    },
  };
}
