import { MORSE } from "../audio/code";
import { averageCodeUnits, maxCharsPerMinute } from "../audio/timing";
import { saveAttempts } from "../storage/db";
import { UNKNOWN } from "../training/groupDrill";
import { examPoints } from "../training/scoring";
import { StreamDrill, type StreamSummary } from "../training/streamDrill";
import { charsetChars } from "../training/charset";
import type { ScreenContext } from "./context";
import { h } from "./dom";
import { field, select, speedLimitNote } from "./form";
import { createKeyboard } from "./keyboard";
import { keepScreenOn } from "./wakeLock";

/** 試験の欧文暗語の字数（得点の換算に使う） */
const EXAM_CHARS = 400;

export function showStreamMenu(ctx: ScreenContext): void {
  const s = ctx.settings;
  const warning = h("div", { class: "warning" });
  const updateWarning = () => {
    const { streamCpm, charset, cwpm } = ctx.settings;
    const avg = averageCodeUnits(charsetChars(charset).map((c) => MORSE[c]));
    warning.textContent = speedLimitNote(streamCpm, maxCharsPerMinute(cwpm, avg), cwpm);
  };
  updateWarning();
  ctx.render(
    h("h1", {}, "遅れ受信"),
    h("p", { class: "note" },
      "グループの間で止めずに流し続けます。聞きながら入力し、許容する遅れを少しずつ広げていきます。" +
      "聞き取れない字は「不明」で飛ばしてください（試験の採点では誤字 3 点・脱字 1 点の減点）"),
    h("div", { class: "settings" },
      field("速度", select(
        [
          ["auto", `自動（現在 ${s.streamCpm} 字/分）`],
          ...[20, 30, 40, 50, 60, 70, 80, 90, 100].map((v): [string, string] => [String(v), `${v} 字/分`]),
        ],
        s.autoStreamCpm ? "auto" : String(s.streamCpm),
        (v) => {
          ctx.updateSettings(v === "auto" ? { autoStreamCpm: true } : { autoStreamCpm: false, streamCpm: Number(v) });
          updateWarning();
        },
      )),
      field("長さ", select(
        [5, 10, 20, 40, 80].map((v) => [String(v), `${v} 組（${v * 5} 字）`]),
        String(s.streamGroups),
        (v) => ctx.updateSettings({ streamGroups: Number(v) }),
      )),
      field("許容する遅れ", select(
        [1, 2, 3, 5, 10].map((v) => [String(v), `${v} 字`]),
        String(s.allowedLag),
        (v) => ctx.updateSettings({ allowedLag: Number(v) }),
      )),
      warning,
    ),
    h("button", { class: "primary", type: "button", onclick: () => void startStream(ctx) }, "はじめる"),
    h("button", { type: "button", onclick: () => ctx.showHome() }, "ホーム"),
  );
}

/** 入力を 5 字ごとに区切って表示する */
function formatTyped(typed: string): string {
  const shown = typed.replaceAll(UNKNOWN, "?");
  return shown.match(/.{1,5}/g)?.join(" ") ?? "";
}

async function startStream(ctx: ScreenContext): Promise<void> {
  await ctx.player.unlock();
  const release = await keepScreenOn();

  const progress = h("div", { class: "progress" });
  const speed = h("div", { class: "speed" });
  const lagMeter = h("div", { class: "lag" });
  const typedView = h("div", { class: "typed" });
  const status = h("div", { class: "status" }, "再生中… 聞きながら入力してください");
  const keyboard = createKeyboard(charsetChars(ctx.settings.charset), (ch) => drill.input(ch), [
    { label: "不明", onPress: () => drill.unknown() },
    { label: "⌫", onPress: () => drill.backspace() },
    { label: "終了", onPress: () => drill.finish(), class: "key-submit" },
  ]);
  let total = 0;
  let typedCount = 0;

  ctx.render(
    h("div", { class: "drill" },
      h("div", { class: "row" },
        progress,
        h("button", { type: "button", class: "small", onclick: () => ctx.stopDrill() }, "中断"),
      ),
      speed,
      lagMeter,
      typedView,
      status,
      keyboard,
    ),
  );

  const drill = new StreamDrill({
    player: ctx.player,
    settings: ctx.settings,
    stats: ctx.stats,
    confusions: ctx.confusions,
    save: saveAttempts,
    onEvent: (e) => {
      switch (e.type) {
        case "start":
          total = e.total;
          speed.textContent = `${e.cpm} 字/分（文字間 ${e.timing.charGap.toFixed(2)} 秒）`;
          break;
        case "typed":
          typedCount = e.typed.length;
          progress.textContent = `入力 ${typedCount} / ${total} 字`;
          typedView.textContent = formatTyped(e.typed);
          typedView.scrollTop = typedView.scrollHeight;
          break;
        case "lag":
          lagMeter.textContent = `遅れ ${e.lag} 字（許容 ${ctx.settings.allowedLag} 字）`;
          lagMeter.classList.toggle("over", e.over);
          break;
        case "played":
          status.textContent = "再生終了。残りを入力して「終了」を押してください";
          break;
        case "finished":
          release();
          ctx.setActive(null);
          if (ctx.settings.autoStreamCpm) ctx.updateSettings({ streamCpm: e.summary.nextCpm });
          showStreamResult(ctx, e.summary);
          break;
      }
    },
  });
  ctx.setActive({
    key: (e) => {
      if (e.key === "Backspace") drill.backspace();
      else if (e.key === " ") drill.unknown();
      else if (e.key === "Enter") drill.finish();
      else if (/^[A-Za-z0-9./?,()-]$/.test(e.key)) drill.input(e.key);
      else return false;
      return true;
    },
    abort: () => {
      drill.abort();
      release();
    },
  });
  drill.start();
}

function showStreamResult(ctx: ScreenContext, summary: StreamSummary): void {
  const { score } = summary;
  const total = score.marks.length;
  const ok = score.marks.filter((m) => m === "ok").length;

  const comparison = h("div", { class: "compare" },
    ...summary.groups.map((g, gi) => h("div", { class: "compare-group" },
      h("div", { class: "compare-target" },
        ...[...g].map((c, i) => h("span", { class: score.marks[gi * 5 + i] }, c)),
      ),
      h("div", { class: "compare-typed" },
        ...[...g].map((_, i) => {
          const idx = gi * 5 + i;
          return h("span", { class: score.marks[idx] }, score.typedAt[idx] ?? "·");
        }),
      ),
    )),
  );

  ctx.render(
    h("h1", {}, "結果"),
    h("div", { class: "summary" },
      h("div", {}, `正解 ${ok} / ${total} 字（${Math.round((ok / total) * 100)}%）`),
      h("div", {}, `誤字 ${score.wrong}・脱字 ${score.missing}・冗字 ${score.extra} → 減点 ${score.deduction}`),
      h("div", {}, `${EXAM_CHARS} 字換算の得点 ${examPoints(score.deduction, total, EXAM_CHARS)} 点`),
      h("div", {}, `最大の遅れ ${summary.maxLag} 字（許容 ${summary.allowedLag} 字、超えた回数 ${summary.overCount}）`),
      h("div", {}, `速度 ${summary.cpm} 字/分 → 次回 ${summary.nextCpm} 字/分`),
    ),
    h("p", { class: "note" }, "上段が正解、下段があなたの入力（· は脱字）。緑: 正解、赤: 誤字、灰: 脱字"),
    comparison,
    h("div", { class: "row" },
      h("button", { class: "primary", type: "button", onclick: () => void startStream(ctx) }, "もう一度"),
      h("button", { type: "button", onclick: () => ctx.showHome() }, "ホーム"),
    ),
  );
}
