import { KeyListener } from "../audio/listener";
import { loadSends, saveSend, type SendRecord } from "../storage/db";
import { CHARSET_LABELS, charsetChars, type CharsetId } from "../training/charset";
import { farnsworth } from "../audio/timing";
import { SendSession, sendGroups, type SendPhase } from "../training/sendDrill";
import { replayIntervals, type SendResult, type SentChar, type Spread } from "../training/sendScoring";
import { sendCharStats, sendConfusions, sendErrorRate, sendWeights, weakSendChars } from "../training/sendWeak";
import { examPoints } from "../training/scoring";
import type { ScreenContext } from "./context";
import { h, prettyCode } from "./dom";
import { field, select } from "./form";
import { showBanner } from "./updateBanner";
import { keepScreenOn } from "./wakeLock";

/** 1 総通の欧文暗語は送受信とも 1 分間 80 字・約 5 分間（400 字） */
const EXAM_CPM = 80;
const EXAM_MINUTES = 5;
const EXAM_CHARS = 400;

/** 苦手な文字の集計に使う期間（ミリ秒） */
const WEAK_WINDOW_MS = 60 * 86_400_000;

/**
 * 送信の記録（新しい順）。メニューを開いたときに読み込み、練習を終えるたびに足す。
 * 出題に使うが、マイクを開く前にデータベースを待つと iOS でタップの中とみなされなくなるので、先に読んでおく
 */
let records: SendRecord[] = [];

/** グループ送信か、時間を区切った模擬試験か */
type SendMode = { kind: "group" } | { kind: "mock"; cpm: number; minutes: number };

/** 前回固定した周波数（Hz）と速度（WPM）。次の練習の初期値にする */
let lastFreq = 700;
let lastWpm = 20;

const STATUS: Record<SendPhase, string> = {
  warmup: "まず VVV を送ってください（周波数と速度を合わせて固定します）",
  ready: "準備できました。お題を送ってください",
  sending: "送信中… 送り終えて 3 秒たつと終了します",
  finished: "",
};

export async function showSendMenu(ctx: ScreenContext): Promise<void> {
  const sends = await loadSends().catch((e): SendRecord[] => {
    console.error("failed to load sends", e);
    return [];
  });
  records = sends;
  const stats = sendCharStats(sends, Date.now() - WEAK_WINDOW_MS);
  const weak = weakSendChars(stats, 8);
  const confusions = sendConfusions(stats, 6);
  const s = ctx.settings;
  const focus = h("input", { type: "checkbox", checked: s.sendFocusWeak });
  focus.addEventListener("change", () => ctx.updateSettings({ sendFocusWeak: focus.checked }));
  const mockText = () => `お題 ${ctx.settings.sendMockCpm * ctx.settings.sendMockMinutes} 字`;
  const mockLength = h("div", { class: "note" }, mockText());
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
      field("字数", select(
        [25, 50, 80, 100].map((v) => [String(v), `${v} 字（${v / 5} 組）${v === EXAM_CPM ? "・試験の 1 分間分" : ""}`]),
        String(s.sendChars),
        (v) => ctx.updateSettings({ sendChars: Number(v) }),
      )),
      h("label", { class: "check" }, focus, h("span", {}, "送信の苦手な文字を多めに出す")),
    ),
    h("button", { class: "primary", type: "button", onclick: () => void startSend(ctx, { kind: "group" }) }, "マイクを開始"),
    h("h2", {}, "模擬試験"),
    h("p", { class: "note" },
      `試験（欧文暗語 1 分間 ${EXAM_CPM} 字・約 ${EXAM_MINUTES} 分間）と同じく時間を区切って送ります。` +
      "最初の文字から計時し、時間内に送れなかった字は未送信（2 字までごとに 1 点）になります"),
    h("div", { class: "settings" },
      field("目標速度", select(
        [40, 50, 60, 70, 80, 90, 100].map((v) => [String(v), v === EXAM_CPM ? `${v} 字/分（試験）` : `${v} 字/分`]),
        String(s.sendMockCpm),
        (v) => {
          ctx.updateSettings({ sendMockCpm: Number(v) });
          mockLength.textContent = mockText();
        },
      )),
      field("時間", select(
        [1, 3, 5].map((v) => [String(v), v === EXAM_MINUTES ? `${v} 分（試験）` : `${v} 分`]),
        String(s.sendMockMinutes),
        (v) => {
          ctx.updateSettings({ sendMockMinutes: Number(v) });
          mockLength.textContent = mockText();
        },
      )),
      mockLength,
    ),
    h("button", {
      class: "primary",
      type: "button",
      onclick: () => void startSend(ctx, { kind: "mock", cpm: ctx.settings.sendMockCpm, minutes: ctx.settings.sendMockMinutes }),
    }, "模擬試験をはじめる"),
    (weak.length > 0 || confusions.length > 0) &&
      h("div", { class: "misses" },
        h("h2", {}, "送信の苦手な文字（直近 60 日）"),
        ...weak.map((w) => h("span", { class: "chip" }, `${w.char} ${Math.round(sendErrorRate(w) * 100)}%`)),
        confusions.length > 0 && h("p", { class: "note" }, "取り違え（お題 → 送った符号）"),
        ...confusions.map(([t, sent, n]) =>
          h("span", { class: "chip" }, `${t} → ${sent.length > 1 ? prettyCode(sent) : sent} ×${n}`)),
      ),
    sends.length > 0 &&
      h("div", { class: "misses" },
        h("h2", {}, "最近の結果"),
        h("table", { class: "lab-table" },
          ...sends.slice(0, 5).map((r) =>
            h("tr", {},
              h("th", {}, new Date(r.ts).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })),
              h("td", {}, r.mode === "mock" ? `模擬 ${r.minutes} 分` : "グループ"),
              h("td", {}, `${r.points} 点`),
              h("td", {}, r.cpm === null ? "―" : `${Math.round(r.cpm)} 字/分`),
              h("td", {}, `${r.target.length} 字`),
            )),
        ),
      ),
    h("button", { type: "button", onclick: () => ctx.showHome() }, "ホーム"),
  );
}

async function startSend(ctx: ScreenContext, mode: SendMode): Promise<void> {
  // 再生用の AudioContext とマイク用が同時に動かないようにする
  ctx.player.release();
  const { charset, sendChars } = ctx.settings;
  const chars = mode.kind === "mock" ? mode.cpm * mode.minutes : sendChars;
  const charList = charsetChars(charset);
  // 模擬試験は試験と同じく一様に出す
  const weights = mode.kind === "group" && ctx.settings.sendFocusWeak
    ? sendWeights(sendCharStats(records, Date.now() - WEAK_WINDOW_MS), charList)
    : undefined;
  const session = new SendSession(
    sendGroups(Math.ceil(chars / 5), charList, Math.random, 5, weights),
    mode.kind === "mock" ? { limitSec: mode.minutes * 60 } : {},
  );

  const progress = h("div", { class: "progress" });
  const status = h("div", { class: "status" });
  const lamp = h("div", { class: "lamp small" });
  const speed = h("div", { class: "progress" });
  const grid = h("div", { class: "send-groups" });
  const pending = h("div", { class: "send-pending" });
  const clock = h("div", { class: "send-clock", hidden: mode.kind !== "mock" });
  const skipBtn = h("button", { type: "button", onclick: () => session.skipWarmup() }, "VVV を省略する");
  const finishBtn = h("button", { type: "button", class: "primary", onclick: () => finish() }, "終了");

  ctx.render(
    h("div", { class: "drill" },
      h("div", { class: "row" },
        progress,
        h("button", { type: "button", class: "small", onclick: () => ctx.stopDrill() }, "中断"),
      ),
      h("div", { class: "send-monitor" }, lamp, speed),
      clock,
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
  /** 画面に表示している、今送っている組 */
  let shownGroup = -1;

  const close = () => {
    cancelAnimationFrame(raf);
    releaseScreen();
    listener?.close();
    listener = null;
  };
  ctx.setActive({ key: () => false, abort: close });

  try {
    listener = await KeyListener.open(
      { freq: lastFreq, wpm: lastWpm },
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
    if (session.timeUp(l.now)) {
      // 時間切れ。キーを上げたまま確定していない符号も文字にしてから終える
      session.handle(l.decoder.tick(l.now + 60), l.now);
      return finish();
    }
    if (session.tick(l.now, l.detector.keyDown)) dirty = true;
    if (session.phase === "finished") return finish();

    lamp.classList.toggle("on", l.detector.keyDown);
    if (lastPhase === "warmup" && session.phase !== "warmup") {
      // VVV で確認できた周波数と速度で固定する。練習機の速度と音は練習の途中で変えないので、
      // 外の音に周波数を持っていかれたり、送り方で速度の推定がぶれたりしないようにする
      l.lock();
      lastFreq = Math.round(l.detector.freq);
      lastWpm = l.decoder.wpm;
    }
    const locked = session.phase === "warmup" ? "" : "（固定）";
    speed.textContent = `${Math.round(l.detector.freq)} Hz・${l.decoder.wpm.toFixed(1)} WPM${locked}`;
    pending.textContent = prettyCode(l.decoder.pendingCode);
    if (mode.kind === "mock") renderClock(clock, session, mode, l.now);
    if (session.phase !== lastPhase) {
      lastPhase = session.phase;
      status.textContent = session.phase === "sending" && mode.kind === "mock"
        ? "送信中… 時間になるか、送り終えて 3 秒たつと終了します"
        : STATUS[session.phase];
      skipBtn.hidden = session.phase !== "warmup";
    }
    if (dirty) {
      dirty = false;
      const pos = session.position;
      progress.textContent = `${Math.min(session.groups.length, Math.floor(pos / 5) + 1)} / ${session.groups.length} 組`;
      grid.replaceChildren(...groupBlocks(session.groups, session.chars.length > 0 ? session.result : null, pos));
      // 今送っている組が見えるようにする
      const group = Math.floor(pos / 5);
      if (group !== shownGroup) {
        shownGroup = group;
        grid.children[Math.min(group, grid.children.length - 1)]?.scrollIntoView({ block: "center", behavior: "smooth" });
      }
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
    const record = session.toRecord(
      mode.kind === "mock"
        ? { mode: "mock", charset, wpm, minutes: mode.minutes, targetCpm: mode.cpm }
        : { mode: "group", charset, wpm },
    );
    records = [record, ...records];
    void saveSend(record).catch((e) => console.error("failed to save send", e));
    showSendResult(ctx, session, record, mode);
  }
}

/** 模擬試験の経過時間と、目標の速度に対して何字進んでいるか（遅れているか） */
function renderClock(el: HTMLElement, session: SendSession, mode: { cpm: number; minutes: number }, now: number): void {
  const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
  if (session.phase !== "sending") {
    el.textContent = `制限 ${mmss(mode.minutes * 60)}・目標 ${mode.cpm} 字/分。最初の文字から計時します`;
    el.className = "send-clock";
    return;
  }
  const elapsed = session.elapsed(now);
  const ahead = Math.round(session.sentCount - (elapsed * mode.cpm) / 60);
  el.textContent = `${mmss(elapsed)} / ${mmss(mode.minutes * 60)}・目標より ${ahead >= 0 ? `${ahead} 字早い` : `${-ahead} 字遅い`}`;
  el.className = `send-clock ${ahead >= 0 ? "ahead" : "behind"}`;
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
          if (!mark || mark === "unsent") return h("span", {}, "");
          const text = mark === "missing" ? "－" : sent && sent.length > 1 ? "?" : (sent ?? "");
          const cls = mark === "ok" ? (score!.unclearAt[t] ? "unclear" : "ok") : "ng";
          return h("span", { class: cls, title: sent && sent.length > 1 ? prettyCode(sent) : "" }, text);
        })),
    ));
}

function showSendResult(ctx: ScreenContext, session: SendSession, record: SendRecord, mode: SendMode): void {
  const { score, quality } = session.result;
  const chars = session.target.length;
  const breakdown: [string, number, string][] = [
    ["未送信", score.unsent, "2 字までごとに 1 点"],
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

  const replay = replayControls(ctx, session, record);

  ctx.render(
    h("h1", {}, mode.kind === "mock" ? `模擬試験の結果（${mode.minutes} 分・目標 ${mode.cpm} 字/分）` : "結果"),
    h("div", { class: "summary" },
      h("div", {}, `得点 ${score.points} 点（減点 ${score.deduction}）`),
      mode.kind === "mock" && chars !== EXAM_CHARS
        ? h("div", {}, `試験の ${EXAM_CHARS} 字に換算すると ${examPoints(score.deduction, chars, EXAM_CHARS)} 点`)
        : null,
      h("div", {}, record.cpm === null ? "速度 ―" : `速度 ${Math.round(record.cpm)} 字/分（符号 ${record.wpm.toFixed(1)} WPM）`),
    ),
    h("table", { class: "lab-table" },
      ...breakdown.filter(([, n]) => n > 0).map(([label, n, rule]) =>
        h("tr", {}, h("th", {}, label), h("td", {}, `${n}`), h("td", {}, rule))),
    ),
    replay.buttons,
    replay.grid,
    h("p", { class: "note" },
      "下段が復号した文字。赤は誤り、黄は符号不明りょう、－は脱字" + (score.unsent > 0 ? "、空欄は未送信" : "") +
      "。組をタップすると、その組の自分の送信と正しい符号を続けて鳴らします"),
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
      h("button", { class: "primary", type: "button", onclick: () => (replay.stop(), void startSend(ctx, mode)) }, "もう一度"),
      h("button", { type: "button", onclick: () => (replay.stop(), void showSendMenu(ctx)) }, "送信練習メニュー"),
    ),
    h("button", { type: "button", onclick: () => (replay.stop(), ctx.showHome()) }, "ホーム"),
  );
}

/**
 * 結果画面の再生。記録した符号の長さのとおりに自分の送信を鳴らし、同じ速度の正しい符号と聞き比べる。
 * マイクは閉じてから鳴らす（送信中はアプリから音を出さない）
 */
function replayControls(ctx: ScreenContext, session: SendSession, record: SendRecord) {
  const result = session.result;
  const tone = () => ({ freq: ctx.settings.freq, volume: ctx.settings.volume });
  const timing = farnsworth(Math.max(5, record.wpm), Math.max(5, record.wpm));
  /** 送った組の数（未送信の組は鳴らさない） */
  const sentGroups = Math.ceil(session.position / 5);
  let seq = 0;

  const blocks = groupBlocks(session.groups, result, session.target.length);
  const highlight = (gi: number | null) => blocks.forEach((b, i) => b.classList.toggle("playing", i === gi));

  const playOwn = async (chars: SentChar[], my: number) => {
    if (chars.length === 0 || my !== seq) return;
    await ctx.player.playIntervals(replayIntervals(chars), tone()).done;
  };
  const playModel = async (text: string, my: number) => {
    if (my !== seq) return;
    await ctx.player.play(text, timing, tone()).done;
  };
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function run(task: (my: number) => Promise<void>, gi: number | null): Promise<void> {
    const my = ++seq;
    await ctx.player.unlock();
    highlight(gi);
    await task(my);
    if (my === seq) highlight(null);
  }

  blocks.forEach((b, gi) => {
    if (gi >= sentGroups) return;
    b.classList.add("tappable");
    b.addEventListener("click", () => void run(async (my) => {
      const kept = [...new Set(result.keptAt.slice(gi * 5, gi * 5 + 5).filter((i): i is number => i !== null))]
        .sort((a, b) => a - b)
        .map((i) => result.kept[i]);
      await playOwn(kept, my);
      if (kept.length > 0 && my === seq) await pause(600);
      await playModel(session.groups[gi], my);
    }, gi));
  });

  const stop = () => {
    seq++;
    ctx.player.stop();
    highlight(null);
  };
  const buttons = h("div", { class: "row" },
    h("button", { type: "button", onclick: () => void run((my) => playOwn(result.kept, my), null) }, "自分の送信を聞く"),
    h("button", {
      type: "button",
      onclick: () => void run((my) => playModel(session.groups.slice(0, sentGroups).join(" "), my), null),
    }, "正しい符号で聞く"),
    h("button", { type: "button", class: "small", onclick: stop }, "止める"),
  );
  return { buttons, grid: h("div", { class: "send-groups" }, ...blocks), stop };
}
