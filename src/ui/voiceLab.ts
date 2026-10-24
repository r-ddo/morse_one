import type { DecodeEvent } from "../audio/decoder";
import { DEFAULT_TUNING, VoiceListener, type VoiceChar, type VoiceFrame, type VoiceTuning } from "../audio/voice";
import { prepareCanvas } from "./canvas";
import type { ScreenContext } from "./context";
import { h, prettyCode, setText } from "./dom";
import { field, range, select } from "./form";
import { INPUT_OPTIONS } from "./paddlePads";
import { showBanner } from "./updateBanner";
import { keepScreenOn } from "./wakeLock";

/** 送信実験の入力の選択肢（声は送信実験だけ） */
export const LAB_INPUT_OPTIONS: [string, string][] = [...INPUT_OPTIONS, ["voice", "声で唱える（実験）"]];

/** 画面を開き直しても保つ実験の設定。声を選んでいるかは設定に保存しない（送信練習では選べないため） */
export const voiceOptions = {
  selected: false,
  tuning: { ...DEFAULT_TUNING } as VoiceTuning,
};

/** 波形表示の長さ（秒） */
const HISTORY_SEC = 4;
/** 記録に残す文字の数 */
const LOG_MAX = 200;

interface VoiceView {
  lamp: HTMLElement;
  dot: HTMLElement;
  dash: HTMLElement;
  level: HTMLElement;
  envelope: HTMLCanvasElement;
  text: HTMLElement;
  pending: HTMLElement;
  log: HTMLElement;
  recorded: HTMLElement;
}

/**
 * 送信実験（声）: 「タ」「ラ」で短点、「ター」「ラー」で長点を唱える声をマイクから入力し、符号にする。
 * 検出を調べるため、文字ごとの音節の長さと区切り方を記録し、録音を WAV で保存できる
 */
export function showVoiceLab(ctx: ScreenContext, onInputChange: (v: string) => void): void {
  ctx.player.release();
  let session: VoiceSession | null = null;
  let starting = false;

  const inputSelect = field("入力", select(LAB_INPUT_OPTIONS, "voice", (v) => {
    stop();
    onInputChange(v);
  }));
  const startBtn = h("button", { type: "button", class: "primary", onclick: () => void toggle() }, "マイクを開始");

  const setTuning = (patch: Partial<VoiceTuning>) => {
    voiceOptions.tuning = { ...voiceOptions.tuning, ...patch };
    session?.listener.setTuning(voiceOptions.tuning);
  };
  const { tuning } = voiceOptions;
  const sliders = h("div", { class: "settings" },
    h("h2", {}, "検出の調整"),
    field("声ありとみなす強さ（雑音から）", range(6, 40, 1, tuning.onDb, (v) => `${v} dB`, (v) => setTuning({ onDb: v }))),
    field("「ラ」の区切りとみなす弱まり", range(2, 15, 1, tuning.dipDb, (v) => `${v} dB`, (v) => setTuning({ dipDb: v }))),
    field("文字の区切りとみなす無音", range(50, 400, 10, Math.round(tuning.charGap * 1000), (v) => `${v} ms`,
      (v) => setTuning({ charGap: v / 1000 }))),
    h("p", { class: "note" },
      "「タラ」が 1 つの音節になるなら弱まりを下げ、「ター」の途中で分かれるなら上げてください。" +
      "文字がつながるなら無音を短く、1 文字が途中で分かれるなら長くしてください"),
  );

  const view: VoiceView = {
    lamp: h("div", { class: "lamp" }),
    dot: h("div", { class: "tile-value" }, "―"),
    dash: h("div", { class: "tile-value" }, "―"),
    level: h("div", { class: "tile-value" }, "―"),
    envelope: h("canvas", { class: "lab-canvas" }),
    text: h("span", {}),
    pending: h("span", { class: "lab-pending" }),
    log: h("pre", { class: "touch-log" }, "唱えると、ここに文字ごとの音節の長さを表示します"),
    recorded: h("span", { class: "note" }),
  };
  const tile = (label: string, value: HTMLElement) => h("div", {}, h("div", { class: "tile-label" }, label), value);

  const copyBtn = h("button", { type: "button", class: "small" }, "コピー");
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(session?.logText() ?? "").then(
      () => {
        copyBtn.textContent = "コピーしました";
        setTimeout(() => (copyBtn.textContent = "コピー"), 1500);
      },
      (e) => showBanner(`コピーできませんでした（${e instanceof Error ? e.name : String(e)}）`),
    );
  });
  const saveBtn = h("button", { type: "button", class: "small", onclick: () => void session?.saveRecording() }, "録音を保存");

  ctx.render(
    h("h1", {}, "送信実験"),
    h("p", { class: "note" },
      "「タ」か「ラ」で短点、「ター」か「ラー」で長点を唱えると、音節の出だしを拾って符号にします（例: A は「タター」「タラー」）。" +
      "タとラはどちらでもかまいません。文字と文字の間は少しだけあけてください"),
    h("div", { class: "settings" }, inputSelect),
    startBtn,
    h("div", { class: "chart-card lab-monitor" },
      h("div", { class: "lab-tiles" }, view.lamp, tile("短点", view.dot), tile("長点", view.dash), tile("入力レベル", view.level)),
      view.envelope,
      h("p", { class: "note" },
        `声の帯域の強さ（直近 ${HISTORY_SEC} 秒）。塗りが声ありと判定した区間、縦線が音節の出だし、点線が声ありとみなす強さ`),
    ),
    sliders,
    h("div", { class: "chart-card" },
      h("div", { class: "chart-head" },
        h("h2", {}, "復元した文字"),
        h("button", { type: "button", class: "small", onclick: () => session?.clear() }, "クリア"),
      ),
      h("div", { class: "lab-text" }, view.text, view.pending),
    ),
    h("div", { class: "chart-card" },
      h("div", { class: "chart-head" },
        h("h2", {}, "音節の記録（新しい順）"),
        h("div", { class: "row" }, copyBtn, saveBtn),
      ),
      h("p", { class: "note" },
        "時刻・文字・符号のあとに各音節の長さ（ms、次の音節の出だしまで）。間の [ ] は区切り方で、" +
        "「無音」は声が途切れた（タ）、「↓」は弱まった（ラ）。「前」は前の文字からの無音、「境」は短点と長点を分けた長さ。" +
        "うまくいかないときは、クリアしてから同じ文字を何度か唱え、記録のコピーと録音（直近 2 分）を送ってください"),
      view.recorded,
      view.log,
    ),
    h("button", { type: "button", onclick: () => ctx.stopDrill() }, "ホーム"),
  );

  ctx.setActive({ key: () => false, abort: () => stop() });

  async function start(): Promise<void> {
    if (starting) return;
    starting = true;
    startBtn.disabled = true;
    try {
      session = await VoiceSession.open(view, () => {
        stop();
        showBanner("マイクが止められました");
      });
      startBtn.textContent = "停止";
    } catch (e) {
      console.error("failed to start microphone", e);
      showBanner(`マイクを開始できませんでした（${e instanceof Error ? e.name : String(e)}）`);
    } finally {
      starting = false;
      startBtn.disabled = false;
    }
  }

  function stop(): void {
    session?.close();
    session = null;
    startBtn.textContent = "マイクを開始";
  }

  async function toggle(): Promise<void> {
    if (session) stop();
    else await start();
  }
}

class VoiceSession {
  private frames: VoiceFrame[] = [];
  private text = "";
  private lines: string[] = [];
  private logDirty = false;
  private raf = 0;
  private releaseScreen: () => void = () => {};
  listener!: VoiceListener;

  private constructor(private readonly view: VoiceView) {
    void keepScreenOn().then((release) => (this.releaseScreen = release));
    this.raf = requestAnimationFrame(this.draw);
  }

  static async open(view: VoiceView, onEnded: () => void): Promise<VoiceSession> {
    const session = new VoiceSession(view);
    try {
      session.listener = await VoiceListener.open(
        { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        voiceOptions.tuning,
        {
          onEvents: (events) => session.apply(events),
          onFrames: (frames) => session.addFrames(frames),
          onChar: (c) => session.addChar(c),
          onEnded,
        },
      );
    } catch (e) {
      session.stopDrawing();
      throw e;
    }
    return session;
  }

  close(): void {
    this.stopDrawing();
    this.listener.close();
  }

  private stopDrawing(): void {
    cancelAnimationFrame(this.raf);
    this.releaseScreen();
    this.view.lamp.classList.remove("on");
  }

  /** 文字・記録・録音を消す */
  clear(): void {
    this.listener.resetDecoder();
    this.listener.clearRecording();
    this.text = "";
    this.lines = [];
    this.logDirty = true;
  }

  logText(): string {
    const { onDb, dipDb, charGap } = voiceOptions.tuning;
    const head = `版 ${__BUILD_ID__}・送信実験（声）・強さ ${onDb} dB・弱まり ${dipDb} dB・無音 ${Math.round(charGap * 1000)} ms`;
    return [head, ...this.lines].join("\n");
  }

  async saveRecording(): Promise<void> {
    const blob = this.listener.recording();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    const file = new File([blob], `voice-${stamp}.wav`, { type: "audio/wav" });
    // iOS のホーム画面から起動したときはダウンロードできないので、共有シートで保存する
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) showBanner(`保存できませんでした（${e instanceof Error ? e.name : String(e)}）`);
      }
      return;
    }
    const url = URL.createObjectURL(file);
    const a = h("a", { href: url, download: file.name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  private addFrames(frames: VoiceFrame[]): void {
    this.frames.push(...frames);
    const now = this.listener.now;
    if (this.frames[0].t < now - 2 * HISTORY_SEC) this.frames = this.frames.filter((f) => f.t >= now - HISTORY_SEC);
  }

  private apply(events: DecodeEvent[]): void {
    for (const e of events) {
      if (e.type === "char") this.text += e.char ?? `(${prettyCode(e.code)})`;
      if (e.type === "word") this.text += " ";
    }
    if (this.text.length > 400) this.text = this.text.slice(-300);
  }

  private addChar(c: VoiceChar): void {
    const ms = (s: number) => String(Math.round(s * 1000));
    const parts = c.lengths.map((d, i) => {
      if (i === 0) return ms(d);
      const prev = c.syllables[i - 1];
      const sep = prev.split ? `↓${Math.round(prev.dipDb)}dB` : `無音 ${ms(c.syllables[i].start - prev.end)}`;
      return `[${sep}] ${ms(d)}`;
    });
    const before = c.gapBefore === null ? "" : `  前 ${ms(c.gapBefore)}`;
    this.lines.unshift(
      `${c.syllables[0].start.toFixed(2).padStart(7)}s ${c.char ?? "?"} ${prettyCode(c.code).padEnd(6)} ${parts.join(" ")}${before}  境 ${ms(c.threshold)}`,
    );
    if (this.lines.length > LOG_MAX) this.lines.length = LOG_MAX;
    this.logDirty = true;
  }

  private readonly draw = (): void => {
    this.raf = requestAnimationFrame(this.draw);
    const { view, listener } = this;
    if (!listener) return;
    const { decoder } = listener;
    view.lamp.classList.toggle("on", listener.keyDown);
    setText(view.dot, `${Math.round(decoder.dotLen * 1000)} ms`);
    setText(view.dash, `${Math.round(decoder.dashLen * 1000)} ms`);
    setText(view.level, Number.isFinite(listener.rmsDb) ? `${Math.round(listener.rmsDb)} dBFS` : "―");
    setText(view.text, this.text);
    setText(view.pending, prettyCode(decoder.pendingCode));
    setText(view.recorded, `録音 ${Math.floor(listener.recordedSec)} 秒`);
    if (this.logDirty) {
      this.logDirty = false;
      view.log.textContent = this.logText();
    }
    drawVoice(view.envelope, this.frames, listener.now, voiceOptions.tuning.onDb);
  };
}

function drawVoice(canvas: HTMLCanvasElement, frames: VoiceFrame[], now: number, onDb: number): void {
  const p = prepareCanvas(canvas);
  if (!p) return;
  const { g, w, h, color } = p;
  const from = now - HISTORY_SEC;
  const x = (t: number) => ((t - from) / HISTORY_SEC) * w;
  // -100〜-10 dBFS
  const y = (db: number) => h * Math.min(1, Math.max(0, (-10 - db) / 90));
  const visible = frames.filter((f) => f.t >= from);
  const dpr = window.devicePixelRatio || 1;

  g.fillStyle = color("--accent");
  g.globalAlpha = 0.25;
  let runStart: number | null = null;
  for (const f of visible) {
    if (f.on && runStart === null) runStart = f.t;
    if (!f.on && runStart !== null) {
      g.fillRect(x(runStart), 0, x(f.t) - x(runStart), h);
      runStart = null;
    }
  }
  if (runStart !== null) g.fillRect(x(runStart), 0, w - x(runStart), h);
  g.globalAlpha = 1;
  for (const f of visible) if (f.onset) g.fillRect(x(f.t) - dpr / 2, 0, dpr * 1.5, h);

  const line = (value: (f: VoiceFrame) => number, stroke: string, dash: number[]) => {
    g.beginPath();
    let drawing = false;
    for (const f of visible) {
      const v = value(f);
      // 雑音がまだ分からないところは描かない
      if (!Number.isFinite(v)) {
        drawing = false;
        continue;
      }
      if (drawing) g.lineTo(x(f.t), y(v));
      else g.moveTo(x(f.t), y(v));
      drawing = true;
    }
    g.strokeStyle = stroke;
    g.setLineDash(dash);
    g.lineWidth = dpr;
    g.stroke();
  };
  line((f) => f.noiseDb + onDb, color("--muted"), [4, 4]);
  line((f) => f.db, color("--fg"), []);
  g.setLineDash([]);
}
