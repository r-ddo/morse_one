import { KeyListener } from "../audio/listener";
import { loadSends, saveSend, type SendRecord } from "../storage/db";
import { CHARSET_LABELS, charsetChars, type CharsetId } from "../training/charset";
import { SendSession, sendGroups, type SendPhase } from "../training/sendDrill";
import type { SendResult, Spread } from "../training/sendScoring";
import type { ScreenContext } from "./context";
import { h, prettyCode } from "./dom";
import { field, select } from "./form";
import { showBanner } from "./updateBanner";
import { keepScreenOn } from "./wakeLock";

/** 画面を開き直しても、検出に使った周波数は引き継ぐ */
let lastFreq = 700;

const STATUS: Record<SendPhase, string> = {
  warmup: "まず VVV を送ってください（周波数と速度を合わせます）",
  ready: "準備できました。お題を送ってください",
  sending: "送信中… 送り終えて 3 秒たつと終了します",
  finished: "",
};

export async function showSendMenu(ctx: ScreenContext): Promise<void> {
  const sends = await loadSends().catch((e): SendRecord[] => {
    console.error("failed to load sends", e);
    return [];
  });
  const s = ctx.settings;
  ctx.render(
    h("h1", {}, "送信練習"),
    h("p", { class: "note" },
      "練習機のサイドトーンを iPhone のマイクで拾って、送った符号を復号・採点します。" +
      "送信中はアプリから音を出しません。採点は試験の基準（誤字・脱字・冗字 3 点、符号不明りょう 1 点など）です"),
    h("div", { class: "settings" },
      field("文字セット", select(
        Object.entries(CHARSET_LABELS).map(([v, l]) => [v, l]),
        s.charset,
        (v) => ctx.updateSettings({ charset: v as CharsetId }),
      )),
      field("組数", select(
        [5, 10, 20].map((v) => [String(v), `${v} 組（${v * 5} 字）`]),
        String(s.sendGroups),
        (v) => ctx.updateSettings({ sendGroups: Number(v) }),
      )),
    ),
    h("button", { class: "primary", type: "button", onclick: () => void startSend(ctx) }, "マイクを開始"),
    sends.length > 0 &&
      h("div", { class: "misses" },
        h("h2", {}, "最近の結果"),
        h("table", { class: "lab-table" },
          ...sends.slice(0, 5).map((r) =>
            h("tr", {},
              h("th", {}, new Date(r.ts).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })),
              h("td", {}, `${r.points} 点`),
              h("td", {}, r.cpm === null ? "―" : `${Math.round(r.cpm)} 字/分`),
              h("td", {}, `${r.target.length} 字`),
            )),
        ),
      ),
    h("button", { type: "button", onclick: () => ctx.showHome() }, "ホーム"),
  );
}

async function startSend(ctx: ScreenContext): Promise<void> {
  // 再生用の AudioContext とマイク用が同時に動かないようにする
  ctx.player.release();
  const { charset, sendGroups: count } = ctx.settings;
  const session = new SendSession(sendGroups(count, charsetChars(charset)));

  const progress = h("div", { class: "progress" });
  const status = h("div", { class: "status" });
  const lamp = h("div", { class: "lamp small" });
  const speed = h("div", { class: "progress" });
  const grid = h("div", { class: "send-groups" });
  const pending = h("div", { class: "send-pending" });
  const skipBtn = h("button", { type: "button", onclick: () => session.skipWarmup() }, "VVV を省略する");
  const finishBtn = h("button", { type: "button", class: "primary", onclick: () => finish() }, "終了");

  ctx.render(
    h("div", { class: "drill" },
      h("div", { class: "row" },
        progress,
        h("button", { type: "button", class: "small", onclick: () => ctx.stopDrill() }, "中断"),
      ),
      h("div", { class: "send-monitor" }, lamp, speed),
      status,
      grid,
      pending,
      h("div", { class: "row" }, skipBtn, finishBtn),
    ),
  );

  let listener: KeyListener | null = null;
  let raf = 0;
  let releaseScreen: () => void = () => {};
  let lastPhase: SendPhase | null = null;
  let dirty = true;

  const close = () => {
    cancelAnimationFrame(raf);
    releaseScreen();
    listener?.close();
    listener = null;
  };
  ctx.setActive({ key: () => false, abort: close });

  try {
    listener = await KeyListener.open(
      { freq: lastFreq },
      {
        onEvents: (events, now) => {
          if (session.handle(events, now)) dirty = true;
        },
        onFreq: (f) => (lastFreq = Math.round(f)),
        onEnded: () => {
          ctx.stopDrill();
          showBanner("マイクが止められたため、練習を中断しました");
        },
      },
    );
  } catch (e) {
    console.error("failed to start microphone", e);
    ctx.setActive(null);
    showBanner(`マイクを開始できませんでした（${e instanceof Error ? e.name : String(e)}）`);
    void showSendMenu(ctx);
    return;
  }
  void keepScreenOn().then((release) => (releaseScreen = release));

  const draw = () => {
    raf = requestAnimationFrame(draw);
    const l = listener;
    if (!l) return;
    if (session.tick(l.now, l.detector.keyDown)) dirty = true;
    if (session.phase === "finished") return finish();

    lamp.classList.toggle("on", l.detector.keyDown);
    const wpm = l.decoder.wpm;
    speed.textContent = `${Math.round(l.detector.freq)} Hz・${wpm.toFixed(1)} WPM`;
    pending.textContent = prettyCode(l.decoder.pendingCode);
    if (session.phase !== lastPhase) {
      lastPhase = session.phase;
      status.textContent = STATUS[session.phase];
      skipBtn.hidden = session.phase !== "warmup";
    }
    if (dirty) {
      dirty = false;
      const pos = session.position;
      progress.textContent = `${Math.min(session.groups.length, Math.floor(pos / 5) + 1)} / ${session.groups.length} 組`;
      grid.replaceChildren(...groupBlocks(session.groups, session.chars.length > 0 ? session.result : null, pos));
    }
  };
  raf = requestAnimationFrame(draw);

  function finish(): void {
    const wpm = listener?.decoder.wpm ?? 0;
    close();
    ctx.setActive(null);
    session.finish();
    if (session.chars.length === 0) {
      void showSendMenu(ctx);
      return;
    }
    const record = session.toRecord({ mode: "group", charset, wpm });
    void saveSend(record).catch((e) => console.error("failed to save send", e));
    showSendResult(ctx, session, record);
  }
}

/** お題と送信を組ごとに並べる。pos はお題のうち今送っている位置 */
function groupBlocks(groups: readonly string[], result: SendResult | null, pos: number): HTMLElement[] {
  const score = result?.score;
  return groups.map((g, gi) =>
    h("div", { class: "send-group" },
      h("div", { class: "send-target" },
        ...[...g].map((c, i) => h("span", { class: gi * 5 + i === pos ? "current" : "" }, c))),
      h("div", { class: "send-sent" },
        ...[...g].map((_, i) => {
          const t = gi * 5 + i;
          const mark = score && t < pos ? score.marks[t] : null;
          const sent = score?.sentAt[t];
          const text = mark === "missing" || mark === "unsent" ? "－" : sent && sent.length > 1 ? "?" : (sent ?? "");
          const cls = mark === "ok" ? (score!.unclearAt[t] ? "unclear" : "ok") : mark ? "ng" : "";
          return h("span", { class: cls, title: sent && sent.length > 1 ? prettyCode(sent) : "" }, mark ? text : "");
        })),
    ));
}

function showSendResult(ctx: ScreenContext, session: SendSession, record: SendRecord): void {
  const { score, quality } = session.result;
  const breakdown: [string, number, string][] = [
    ["誤字", score.wrong, "3 点ずつ"],
    ["脱字", score.missing, "3 点ずつ"],
    ["冗字", score.extra, "3 点ずつ"],
    ["符号不明りょう", score.unclear, "1 点ずつ"],
    ["訂正", score.corrections, "3 回までごとに 1 点"],
    ["文字間 6 短点以上", score.longCharGaps, "1 点ずつ"],
    ["語間 14 短点以上", score.longWordGaps, "1 点ずつ"],
  ];
  const fmt = (x: Spread | null, digits = 2) => (x ? x.mean.toFixed(digits) : "―");
  const cv = (x: Spread | null) => (x && x.n >= 2 ? `${Math.round(x.cv * 100)}%` : "―");
  const qualityRows: [string, Spread | null, string][] = [
    ["短点", quality.dot, "1"],
    ["長点", quality.dash, "3"],
    ["符号内の間", quality.element, "1"],
    ["文字間", quality.charGap, "3"],
    ["語間", quality.wordGap, "7"],
  ];

  ctx.render(
    h("h1", {}, "結果"),
    h("div", { class: "summary" },
      h("div", {}, `得点 ${score.points} 点（減点 ${score.deduction}）`),
      h("div", {}, record.cpm === null ? "速度 ―" : `速度 ${Math.round(record.cpm)} 字/分（符号 ${record.wpm.toFixed(1)} WPM）`),
    ),
    h("table", { class: "lab-table" },
      ...breakdown.filter(([, n]) => n > 0).map(([label, n, rule]) =>
        h("tr", {}, h("th", {}, label), h("td", {}, `${n}`), h("td", {}, rule))),
    ),
    h("div", { class: "send-groups" }, ...groupBlocks(session.groups, session.result, session.target.length)),
    h("p", { class: "note" }, "下段が復号した文字。赤は誤り、黄は符号不明りょう、－は脱字"),
    h("div", { class: "chart-card" },
      h("h2", {}, "符号の質"),
      h("table", { class: "lab-table" },
        h("tr", {}, h("th", {}, ""), h("th", {}, "平均"), h("th", {}, "ばらつき"), h("th", {}, "標準")),
        ...qualityRows.map(([label, x, std]) =>
          h("tr", {}, h("th", {}, label), h("td", {}, fmt(x)), h("td", {}, cv(x)), h("td", {}, std))),
      ),
      h("p", { class: "note" }, "長さは推定短点長を 1 とした値。ばらつきは標準偏差 ÷ 平均"),
      quality.notes.length > 0
        ? h("ul", { class: "send-notes" }, ...quality.notes.map((n) => h("li", {}, n)))
        : h("p", {}, "目立った癖はありません"),
    ),
    h("div", { class: "row" },
      h("button", { class: "primary", type: "button", onclick: () => void startSend(ctx) }, "もう一度"),
      h("button", { type: "button", onclick: () => void showSendMenu(ctx) }, "送信練習メニュー"),
    ),
    h("button", { type: "button", onclick: () => ctx.showHome() }, "ホーム"),
  );
}
