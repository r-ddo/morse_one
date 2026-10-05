import type { DecodeEvent, GapKind } from "../audio/decoder";
import type { DetectorFrame } from "../audio/keying";
import { FREQ_MAX, FREQ_MIN, KeyListener } from "../audio/listener";
import type { MicProcessing } from "../audio/mic";
import { VirtualPaddle, VirtualStraightKey } from "../audio/paddle";
import type { Settings } from "../storage/settings";
import type { ScreenContext } from "./context";
import { h, prettyCode, setText } from "./dom";
import { field, range, select } from "./form";
import { INPUT_OPTIONS, PAD_TOUCH_OPTIONS, paddlePads, paddleSettingsCard, straightKeyNote, straightKeyPad } from "./paddlePads";
import { touchLog } from "./touchLog";
import { showBanner } from "./updateBanner";
import { keepScreenOn } from "./wakeLock";

/** 画面を開き直しても保つ実験の設定 */
const options = {
  processing: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } as MicProcessing,
  autoFreq: true,
  speedLocked: false,
  freq: 700,
};

const PROCESSING_LABELS: [keyof MicProcessing, string][] = [
  ["echoCancellation", "エコーキャンセル"],
  ["noiseSuppression", "ノイズ抑制"],
  ["autoGainControl", "自動ゲイン（AGC）"],
];

/** 波形表示の長さ（秒） */
const HISTORY_SEC = 4;
/** 統計に使う直近の符号・間の数 */
const STATS_WINDOW = 60;

interface LabView {
  lamp: HTMLElement;
  wpm: HTMLElement;
  freq: HTMLElement;
  level: HTMLElement;
  rate: HTMLElement;
  envelope: HTMLCanvasElement;
  spectrum: HTMLCanvasElement;
  text: HTMLElement;
  pending: HTMLElement;
  stats: HTMLElement;
  freqInput: HTMLInputElement;
  freqValue: HTMLElement;
}

/**
 * 送信実験: 練習機などのサイドトーンをマイクから入力し、トーンのオン/オフと符号を検出する。
 * 画面のパドルを選ぶと、パドルで送った符号を復号する（符号の長さや間の確認用）
 */
export function showLab(ctx: ScreenContext): void {
  // 再生用の AudioContext とマイク用（パドルのサイドトーン用）が同時に動かないようにする
  ctx.player.release();
  let session: LabSession | null = null;
  let starting = false;
  const via = ctx.settings.sendInput;
  /** 画面のパドルか縦振電鍵（マイクを使わない） */
  const onScreen = via !== "mic";

  /** 入力やパドルの設定を変えたら、止めて画面を作り直す */
  const rebuild = () => {
    stop();
    pads?.detach();
    log?.detach();
    showLab(ctx);
  };
  const inputSelect = field("入力", select(
    INPUT_OPTIONS,
    via,
    (v) => {
      ctx.updateSettings({ sendInput: v as Settings["sendInput"] });
      rebuild();
    },
  ));
  // 画面のパドル・縦振電鍵は最初に押したときに始める（そのタップの中で音を出せるようにする）
  const onScreenKey = () => (session ??= LabSession.onScreen(ctx, view)).input;
  const log = onScreen ? touchLog({ live: true }) : null;
  log?.add(`受け取り方 ${ctx.settings.padTouch}`);
  const DOT_DASH = { dot: "短点", dash: "長点" } as const;
  const pads = via === "paddle"
    ? paddlePads({
      press: (p) => {
        log?.add(`★ ${DOT_DASH[p]}を押す`);
        (onScreenKey() as VirtualPaddle).press(p);
      },
      release: (p) => {
        log?.add(`☆ ${DOT_DASH[p]}を離す`);
        (session?.input as VirtualPaddle | undefined)?.release(p);
      },
    }, ctx.settings.paddleSwap, ctx.settings.padTouch)
    : via === "straight"
      ? straightKeyPad({
        press: () => {
          log?.add("★ 電鍵を押す");
          (onScreenKey() as VirtualStraightKey).press();
        },
        release: () => {
          log?.add("☆ 電鍵を離す");
          (session?.input as VirtualStraightKey | undefined)?.release();
        },
      }, ctx.settings.padTouch)
      : null;

  const startBtn = h("button", { type: "button", class: "primary", hidden: onScreen, onclick: () => void toggle() }, "マイクを開始");
  const info = h("div", { class: "lab-info" }, "開始すると、実際に適用された設定をここに表示します");

  const checks = PROCESSING_LABELS.map(([key, label]) => {
    const input = h("input", { type: "checkbox", checked: options.processing[key] });
    input.addEventListener("change", () => {
      options.processing = { ...options.processing, [key]: input.checked };
      if (session) void restart();
    });
    return h("label", { class: "check" }, input, h("span", {}, label));
  });

  const freqRange = range(FREQ_MIN, FREQ_MAX, 10, options.freq, (v) => `${v} Hz`, (v) => {
    options.freq = v;
    options.autoFreq = false;
    autoInput.checked = false;
    session?.setFreq(v);
  });
  const speedInput = h("input", { type: "checkbox", checked: options.speedLocked });
  speedInput.addEventListener("change", () => {
    options.speedLocked = speedInput.checked;
    session?.setSpeedLocked(speedInput.checked);
  });
  const autoInput = h("input", { type: "checkbox", checked: options.autoFreq });
  autoInput.addEventListener("change", () => {
    options.autoFreq = autoInput.checked;
    session?.setAutoFreq(autoInput.checked);
  });

  const view: LabView = {
    lamp: h("div", { class: "lamp" }),
    wpm: h("div", { class: "tile-value" }, "―"),
    freq: h("div", { class: "tile-value" }, "―"),
    level: h("div", { class: "tile-value" }, "―"),
    rate: h("p", { class: "note" }),
    envelope: h("canvas", { class: "lab-canvas" }),
    spectrum: h("canvas", { class: "lab-canvas spectrum" }),
    text: h("span", {}),
    pending: h("span", { class: "lab-pending" }),
    stats: h("div", { class: "lab-stats" }),
    freqInput: freqRange.querySelector("input")!,
    freqValue: freqRange.querySelector(".range-value")!,
  };
  const tile = (label: string, value: HTMLElement) => h("div", {}, h("div", { class: "tile-label" }, label), value);

  ctx.render(
    h("h1", {}, "送信実験"),
    h("p", { class: "note" }, onScreen
      ? `画面の${via === "paddle" ? "パドル" : "縦振電鍵"}で送った符号を復号し、符号と間の長さを表示します。パッドを押すと始まります`
      : "練習機のサイドトーンをマイクから入力して、トーンのオン/オフと符号を検出します。" +
        "内蔵マイクでスピーカーの音を拾っても、有線でつないでもかまいません"),
    h("div", { class: "settings" },
      inputSelect,
      onScreen && field("タッチの受け取り方（実験）", select(
        PAD_TOUCH_OPTIONS,
        ctx.settings.padTouch,
        (v) => {
          ctx.updateSettings({ padTouch: v as Settings["padTouch"] });
          rebuild();
        },
      )),
      onScreen && h("p", { class: "note" },
        "2 本目の指が届かない問題を調べるための切り替えです。送信練習の画面にも使われます"),
    ),
    via === "paddle" && paddleSettingsCard(ctx, rebuild),
    via === "straight" && h("div", { class: "settings" }, straightKeyNote()),
    startBtn,
    !onScreen && h("div", { class: "settings" },
      h("h2", {}, "ブラウザの音声処理（オフ推奨）"),
      ...checks,
      info,
    ),
    onScreen
      ? h("div", { class: "chart-card lab-monitor" },
        h("div", { class: "lab-tiles" }, view.lamp, tile(via === "paddle" ? "速度" : "推定速度", view.wpm)))
      : h("div", { class: "chart-card lab-monitor" },
        h("div", { class: "lab-tiles" }, view.lamp, tile("推定速度", view.wpm), tile("周波数", view.freq), tile("入力レベル", view.level)),
        view.envelope,
        h("p", { class: "note" }, `目的の周波数の強さ（直近 ${HISTORY_SEC} 秒）。塗りがキーを下げていると判定した区間、点線が閾値`),
        view.rate,
        view.spectrum,
        h("p", { class: "note" }, "スペクトル（0〜2000 Hz）。縦線が検出に使っている周波数"),
        h("div", { class: "field" },
          h("label", { class: "check" }, autoInput, h("span", {}, "周波数を自動検出")),
          freqRange,
        ),
        h("label", { class: "check" }, speedInput, h("span", {}, "速度を今の推定で固定")),
      ),
    h("div", { class: "chart-card" },
      h("div", { class: "chart-head" },
        h("h2", {}, "復元した文字"),
        h("button", { type: "button", class: "small", onclick: () => session?.clear() }, "クリア"),
      ),
      h("div", { class: "lab-text" }, view.text, view.pending),
      view.stats,
    ),
    log?.el ?? null,
    h("button", { type: "button", onclick: () => ctx.stopDrill() }, "ホーム"),
    pads?.el ?? null,
  );

  ctx.setActive({
    key: (e) => pads?.key(e) ?? false,
    abort: () => {
      stop();
      pads?.detach();
      log?.detach();
    },
  });

  async function start(): Promise<void> {
    if (starting) return;
    starting = true;
    startBtn.disabled = true;
    try {
      session = await LabSession.mic(view, () => {
        stop();
        showBanner("マイクが止められました");
      });
      info.replaceChildren(session.describe());
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

  async function restart(): Promise<void> {
    stop();
    await start();
  }

  async function toggle(): Promise<void> {
    if (session) stop();
    else await start();
  }
}

class LabSession {
  private frames: DetectorFrame[] = [];
  private text = "";
  private marks: { kind: "." | "-"; units: number }[] = [];
  private gaps: { kind: GapKind; units: number }[] = [];
  private raf = 0;
  private releaseScreen: () => void = () => {};

  private constructor(
    readonly input: KeyListener | VirtualPaddle | VirtualStraightKey,
    private readonly view: LabView,
  ) {
    void keepScreenOn().then((release) => (this.releaseScreen = release));
    this.raf = requestAnimationFrame(this.draw);
  }

  /** 画面のパドルか縦振電鍵（設定の入力による）。ユーザー操作のハンドラ内で呼ぶこと */
  static onScreen(ctx: ScreenContext, view: LabView): LabSession {
    let session: LabSession | null = null;
    const { sendInput, paddleWpm, freq, volume } = ctx.settings;
    const onEvents = (events: DecodeEvent[]) => session?.apply(events);
    const input = sendInput === "paddle"
      ? new VirtualPaddle({ wpm: paddleWpm, freq, volume }, onEvents)
      : new VirtualStraightKey({ wpm: 15, freq, volume }, onEvents);
    session = new LabSession(input, view);
    return session;
  }

  static async mic(view: LabView, onEnded: () => void): Promise<LabSession> {
    let session: LabSession | null = null;
    const listener = await KeyListener.open(
      { processing: options.processing, freq: options.freq, autoFreq: options.autoFreq },
      {
        onEvents: (events) => session?.apply(events),
        onFrames: (frames) => session?.addFrames(frames),
        onFreq: (freq) => (options.freq = Math.round(freq)),
        onEnded,
      },
    );
    listener.decoder.speedLocked = options.speedLocked;
    session = new LabSession(listener, view);
    return session;
  }

  /** マイクのときはその入力 */
  private get listener(): KeyListener | null {
    return this.input instanceof KeyListener ? this.input : null;
  }

  close(): void {
    cancelAnimationFrame(this.raf);
    this.releaseScreen();
    this.input.close();
    this.view.lamp.classList.remove("on");
  }

  setFreq(freq: number): void {
    if (!this.listener) return;
    this.listener.autoFreq = false;
    this.listener.setFreq(freq);
  }

  setAutoFreq(auto: boolean): void {
    if (this.listener) this.listener.autoFreq = auto;
  }

  setSpeedLocked(locked: boolean): void {
    if (this.listener) this.listener.decoder.speedLocked = locked;
  }

  clear(): void {
    this.input.resetDecoder();
    this.text = "";
    this.marks = [];
    this.gaps = [];
  }

  /** 要求した音声処理と、実際に適用された設定 */
  describe(): HTMLElement {
    const { mic } = this.listener!;
    const track = mic.track;
    const settings = track.getSettings() as Partial<Record<keyof MicProcessing, boolean>> & MediaTrackSettings;
    const supported = navigator.mediaDevices.getSupportedConstraints() as Partial<Record<keyof MicProcessing, boolean>>;
    const onOff = (v: boolean) => (v ? "オン" : "オフ");
    const rows: [string, string][] = PROCESSING_LABELS.map(([key, label]) => {
      const actual = settings[key];
      const shown = actual === undefined ? (supported[key] ? "不明" : "指定できない") : onOff(actual);
      return [label, `要求 ${onOff(options.processing[key])} → 実際 ${shown}`];
    });
    rows.push(["入力", track.label || "（名前なし）"]);
    rows.push(["サンプリング周波数", `${mic.ctx.sampleRate} Hz`]);
    if (mic.ctx.baseLatency !== undefined) rows.push(["出力の基本遅延", `${(mic.ctx.baseLatency * 1000).toFixed(1)} ms`]);
    return h("table", { class: "lab-table" },
      ...rows.map(([k, v]) => h("tr", {}, h("th", {}, k), h("td", {}, v))));
  }

  private addFrames(frames: DetectorFrame[]): void {
    this.frames.push(...frames);
    const now = this.input.now;
    if (this.frames[0].t < now - 2 * HISTORY_SEC) this.frames = this.frames.filter((f) => f.t >= now - HISTORY_SEC);
  }

  private apply(events: DecodeEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case "mark":
          this.marks.push({ kind: e.kind, units: e.units });
          break;
        case "gap":
          this.gaps.push({ kind: e.kind, units: e.units });
          break;
        case "char":
          this.text += e.char ?? `(${prettyCode(e.code)})`;
          break;
        case "word":
          this.text += " ";
          break;
      }
    }
    if (this.marks.length > STATS_WINDOW * 2) this.marks = this.marks.slice(-STATS_WINDOW);
    if (this.gaps.length > STATS_WINDOW * 2) this.gaps = this.gaps.slice(-STATS_WINDOW);
    if (this.text.length > 400) this.text = this.text.slice(-300);
  }

  private readonly draw = (): void => {
    this.raf = requestAnimationFrame(this.draw);
    const { view, input, listener } = this;

    view.lamp.classList.toggle("on", input.keyDown);
    setText(view.wpm, this.marks.length > 0 || !listener ? `${input.decoder.wpm.toFixed(1)} WPM` : "―");
    setText(view.text, this.text);
    setText(view.pending, prettyCode(input.decoder.pendingCode));
    this.renderStats();
    if (!listener) return;

    const { detector } = listener;
    setText(view.freq, `${Math.round(detector.freq)} Hz`);
    setText(view.level, Number.isFinite(listener.rmsDb) ? `${Math.round(listener.rmsDb)} dBFS` : "―");
    const rate = listener.measuredRate;
    setText(view.rate, rate === null ? "" :
      `実際に届いた入力 ${Math.round(rate)} サンプル/秒（想定 ${listener.mic.ctx.sampleRate}）`);
    if (document.activeElement !== view.freqInput) {
      view.freqInput.value = String(Math.round(detector.freq));
      setText(view.freqValue, `${Math.round(detector.freq)} Hz`);
    }
    drawEnvelope(view.envelope, this.frames, listener.now);
    drawSpectrum(view.spectrum, listener.lastSpectrum, listener.binHz, detector.freq);
  };

  private renderStats(): void {
    const marks = this.marks.slice(-STATS_WINDOW);
    const gaps = this.gaps.slice(-STATS_WINDOW);
    const avg = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : "―");
    const of = <T extends { kind: string; units: number }>(xs: T[], kind: string) =>
      xs.filter((x) => x.kind === kind).map((x) => x.units);
    const rows: [string, number[], string][] = [
      ["短点", of(marks, "."), "1"],
      ["長点", of(marks, "-"), "3"],
      ["符号内の間", of(gaps, "element"), "1"],
      ["文字間", of(gaps, "char"), "3"],
      ["語間", of(gaps, "word"), "7"],
    ];
    const { dot, bias } = this.input.decoder;
    const stretch = (bias / dot).toFixed(2);
    const key = rows.map(([, xs]) => `${xs.length}:${avg(xs)}`).join("|") + `|${stretch}`;
    if (this.view.stats.dataset.key === key) return;
    this.view.stats.dataset.key = key;
    this.view.stats.replaceChildren(
      h("table", { class: "lab-table" },
        h("tr", {}, h("th", {}, ""), h("th", {}, "平均"), h("th", {}, "標準"), h("th", {}, "数")),
        ...rows.map(([label, xs, std]) =>
          h("tr", {}, h("th", {}, label), h("td", {}, avg(xs)), h("td", {}, std), h("td", {}, String(xs.length)))),
      ),
      h("p", { class: "note" }, this.listener
        ? `長さは推定短点長を 1 とし、残響などによる伸びを補正した値（直近 ${STATS_WINDOW} 個）。` +
          `推定の伸び ${stretch}（符号はこれだけ長く、間は短く測れている）`
        : this.input instanceof VirtualPaddle
          ? `長さは短点長を 1 とした値（直近 ${STATS_WINDOW} 個）。符号と符号内の間はエレキーが作るので、見るのは文字間・語間`
          : `長さは推定短点長を 1 とした値（直近 ${STATS_WINDOW} 個）。伸びは補正しないので、短点が長く符号内の間が短ければ送り方の癖`),
    );
  }
}

/** キャンバスを表示サイズに合わせ、描画用のコンテキストと色を返す */
function prepare(canvas: HTMLCanvasElement): { g: CanvasRenderingContext2D; w: number; h: number; color: (name: string) => string } | null {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (w === 0 || h === 0) return null;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.clearRect(0, 0, w, h);
  const style = getComputedStyle(canvas);
  return { g, w, h, color: (name) => style.getPropertyValue(name).trim() };
}

function drawEnvelope(canvas: HTMLCanvasElement, frames: DetectorFrame[], now: number): void {
  const p = prepare(canvas);
  if (!p) return;
  const { g, w, h, color } = p;
  const from = now - HISTORY_SEC;
  const x = (t: number) => ((t - from) / HISTORY_SEC) * w;
  // -90〜0 dBFS
  const y = (mag: number) => h * Math.min(1, Math.max(0, -(20 * Math.log10(Math.max(mag, 1e-6))) / 90));
  const visible = frames.filter((f) => f.t >= from);

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

  const line = (value: (f: DetectorFrame) => number, stroke: string, dash: number[]) => {
    g.beginPath();
    visible.forEach((f, i) => (i === 0 ? g.moveTo(x(f.t), y(value(f))) : g.lineTo(x(f.t), y(value(f)))));
    g.strokeStyle = stroke;
    g.setLineDash(dash);
    g.lineWidth = window.devicePixelRatio || 1;
    g.stroke();
  };
  line((f) => f.onLevel, color("--muted"), [4, 4]);
  line((f) => f.mag, color("--fg"), []);
  g.setLineDash([]);
}

function drawSpectrum(canvas: HTMLCanvasElement, db: Float32Array, binHz: number, freq: number): void {
  const p = prepare(canvas);
  if (!p) return;
  const { g, w, h, color } = p;
  const maxHz = 2000;
  const bins = Math.min(db.length, Math.floor(maxHz / binHz));
  // -120〜-20 dB
  const y = (v: number) => h * Math.min(1, Math.max(0, (-20 - v) / 100));
  g.beginPath();
  for (let i = 0; i < bins; i++) {
    const px = (i * binHz * w) / maxHz;
    if (i === 0) g.moveTo(px, y(db[i]));
    else g.lineTo(px, y(db[i]));
  }
  g.strokeStyle = color("--fg");
  g.lineWidth = window.devicePixelRatio || 1;
  g.stroke();
  g.fillStyle = color("--accent");
  g.fillRect((freq / maxHz) * w - 1, 0, 2 * (window.devicePixelRatio || 1), h);
}
