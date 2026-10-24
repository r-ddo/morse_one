import { MORSE } from "../audio/code";
import type { DecodeEvent } from "../audio/decoder";
import { saveSendAttempt, type SendAttempt } from "../storage/db";
import { charsetChars } from "../training/charset";
import { SendSingleDrill, sendSingleStats, type SendSingleResult } from "../training/sendSingle";
import type { ScreenContext } from "./context";
import { h, prettyCode, setClass, setText } from "./dom";
import type { TouchPads } from "./paddlePads";
import { createPadInput, describeInput, lockAfterWarmup, needsWarmup, openMicInput, rememberInput, warmupText, type SendInput } from "./sendInput";
import { showBanner } from "./updateBanner";
import { keepScreenOn } from "./wakeLock";

/** 慣らしで正しく復号できればよい V の数と、そのあと最初の問題を出すまでの無音（秒） */
const WARMUP_VS = 2;
const READY_SILENCE = 1;

/**
 * 単字即答（送信）: 文字を 1 つ表示し、その符号を送ってもらう。符号を覚える練習（単語カードのように使う）。
 * attempts はこれまでの記録（出題の重みに使う）。onDone で送信練習のメニューに戻る
 */
export async function startSendSingle(ctx: ScreenContext, attempts: readonly SendAttempt[], onDone: () => void): Promise<void> {
  ctx.player.release();
  const via = ctx.settings.sendInput;
  const stats = sendSingleStats(attempts);
  const startLimit = ctx.settings.sendSingleLimitMs;
  const drill = new SendSingleDrill({
    chars: charsetChars(ctx.settings.charset),
    stats,
    limitMs: startLimit,
    questions: ctx.settings.sendSingleQuestions,
    onResult: (r) => {
      const attempt: SendAttempt = { ts: Date.now(), ...r, input: via };
      void saveSendAttempt(attempt).catch((e) => console.error("failed to save send attempt", e));
    },
  });

  let warmup = needsWarmup(via);
  let warmupVs = 0;
  let lastActivity = 0;
  let started = false;
  let dirty = true;
  const onEvents = (events: DecodeEvent[], now: number) => {
    for (const e of events) {
      if (e.type === "mark") lastActivity = now;
      if (warmup && e.type === "char" && e.char === "V") warmupVs++;
    }
    if (started && drill.handle(events, now)) dirty = true;
  };

  const progress = h("div", { class: "progress" });
  const lamp = h("div", { class: "lamp small" });
  const speed = h("div", { class: "progress" });
  const status = h("div", { class: "status" });
  const target = h("div", { class: "send-single-char" });
  const code = h("div", { class: "send-single-code" });
  const feedback = h("div", { class: "send-single-feedback" });
  const pending = h("div", { class: "send-pending" });
  const skipBtn = h("button", { type: "button", onclick: () => (warmupVs = WARMUP_VS) }, "VVV を省略する");
  const finishBtn = h("button", { type: "button", onclick: () => finish() }, "終了");

  // タップの中で作る（画面のパドル・縦振電鍵のサイドトーンの AudioContext。iOS の自動再生制限のため）
  const pad = createPadInput(ctx, onEvents, null);
  let input: SendInput | null = pad?.input ?? null;
  const pads: TouchPads | null = pad?.pads ?? null;
  const fit = pads !== null && ctx.settings.sendPadLayout === "fit";
  ctx.render(
    h("div", { class: fit ? "drill keyed" : "drill" },
      h("div", { class: "row" },
        progress,
        h("button", { type: "button", class: "small", onclick: () => ctx.stopDrill() }, "中断"),
      ),
      h("div", { class: "send-monitor" }, lamp, speed),
      status,
      h("div", { class: "send-single-card" }, target, code, feedback),
      pending,
      h("div", { class: "row" }, skipBtn, finishBtn),
      fit && pads?.el,
    ),
    !fit && pads ? pads.el : null,
  );

  let raf = 0;
  let releaseScreen: () => void = () => {};
  const close = () => {
    cancelAnimationFrame(raf);
    releaseScreen();
    pads?.detach();
    input?.close();
    input = null;
  };
  ctx.setActive({ key: (e) => pads?.key(e) ?? false, abort: close });

  if (!input) {
    try {
      input = await openMicInput(ctx, onEvents, () => {
        ctx.stopDrill();
        showBanner("マイクが止められたため、練習を中断しました");
      });
    } catch (e) {
      console.error("failed to start microphone", e);
      ctx.setActive(null);
      showBanner(`マイクを開始できませんでした（${e instanceof Error ? e.name : String(e)}）`);
      onDone();
      return;
    }
  }
  void keepScreenOn().then((release) => (releaseScreen = release));

  const draw = () => {
    raf = requestAnimationFrame(draw);
    const l = input;
    if (!l) return;
    const now = l.now;
    const busy = l.keyDown || l.decoder.pendingCode !== "";
    if (busy) lastActivity = now;
    if (warmup && warmupVs >= WARMUP_VS && now - lastActivity >= READY_SILENCE) {
      warmup = false;
      lockAfterWarmup(l);
      dirty = true;
    }
    if (!warmup && !started) {
      started = true;
      drill.start(now);
      dirty = true;
    }
    if (started && drill.tick(now, busy)) dirty = true;
    if (drill.phase === "finished") return finish();

    lamp.classList.toggle("on", l.keyDown);
    setText(speed, describeInput(l, warmup));
    setText(pending, prettyCode(l.decoder.pendingCode));
    if (!dirty) return;
    dirty = false;
    skipBtn.hidden = !warmup;
    setText(status, warmup ? warmupText(via) : "");
    setText(progress, started ? `${Math.min(drill.total, drill.index + 1)} / ${drill.total}` : "準備");
    if (!started) {
      setText(target, "");
      setText(code, "");
      setText(feedback, "");
      return;
    }
    setText(target, drill.target);
    setText(code, drill.showCode ? prettyCode(MORSE[drill.target]) : "");
    const last = drill.results.at(-1);
    const answered = drill.phase === "correct" || drill.phase === "retry";
    let text = "";
    let cls = "send-single-feedback";
    if (drill.phase === "correct" && last) {
      text = last.verdict === "fast" ? `◯ ${((last.rtMs ?? 0) / 1000).toFixed(2)} 秒` : "◯ もう一度出します";
      cls += last.verdict === "fast" ? " ok" : "";
    } else if (drill.phase === "retry" && drill.lastSent !== null) {
      const sent = drill.lastSent;
      const sentCode = MORSE[sent] ?? sent;
      text = `✕ ${prettyCode(sentCode)}${MORSE[sent] ? `（${sent}）` : ""}。正しく送ってください`;
      cls += " ng";
    } else if (drill.showCode && !answered) {
      text = "符号を見て送ってください";
    }
    setText(feedback, text);
    setClass(feedback, cls);
  };
  raf = requestAnimationFrame(draw);

  function finish(): void {
    if (input) rememberInput(input);
    close();
    ctx.setActive(null);
    ctx.updateSettings({ sendSingleLimitMs: drill.limitMs });
    if (drill.results.length === 0) {
      onDone();
      return;
    }
    showResult(ctx, drill.results, startLimit, drill.limitMs, () => void startSendSingle(ctx, [...attempts, ...drill.results.map((r, i) => ({ ts: Date.now() + i, ...r, input: via }))], onDone), onDone);
  }
}

function showResult(
  ctx: ScreenContext,
  results: readonly SendSingleResult[],
  fromLimit: number,
  toLimit: number,
  again: () => void,
  menu: () => void,
): void {
  const count = (v: SendSingleResult["verdict"]) => results.filter((r) => r.verdict === v).length;
  const fast = results.filter((r) => r.verdict === "fast");
  const avg = fast.length > 0 ? fast.reduce((a, r) => a + r.rtMs!, 0) / fast.length : null;
  const missed = [...new Set(results.filter((r) => r.verdict !== "fast").map((r) => r.target))];
  const sec = (ms: number) => `${(ms / 1000).toFixed(2)} 秒`;
  ctx.render(
    h("h1", {}, "単字即答（送信）の結果"),
    h("div", { class: "summary" },
      h("div", {}, `目標時間内に正しく送った ${fast.length} / ${results.length}`),
      h("div", {}, avg === null ? "送り始めまでの平均 ―" : `送り始めまでの平均 ${sec(avg)}`),
      h("div", {}, `目標時間 ${sec(fromLimit)} → ${sec(toLimit)}`),
    ),
    h("table", { class: "lab-table" },
      h("tr", {}, h("th", {}, "符号を見て送った"), h("td", {}, String(count("hinted")))),
      h("tr", {}, h("th", {}, "最初に違う符号を送った"), h("td", {}, String(count("wrong")))),
      h("tr", {}, h("th", {}, "打ち切り"), h("td", {}, String(count("timeout")))),
    ),
    missed.length > 0 && h("div", { class: "misses" },
      h("h2", {}, "覚え直す文字"),
      ...missed.map((c) => h("span", { class: "chip" }, `${c} ${prettyCode(MORSE[c])}`)),
    ),
    h("div", { class: "row" },
      h("button", { class: "primary", type: "button", onclick: again }, "もう一度"),
      h("button", { type: "button", onclick: menu }, "送信練習メニュー"),
    ),
    h("button", { type: "button", onclick: () => ctx.showHome() }, "ホーム"),
  );
}
