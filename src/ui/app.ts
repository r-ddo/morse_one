import { MORSE } from "../audio/code";
import { MorsePlayer } from "../audio/player";
import { farnsworth } from "../audio/timing";
import { saveAttempt } from "../storage/db";
import { saveSettings, type Settings } from "../storage/settings";
import { CHARSET_LABELS, charsetChars, type CharsetId } from "../training/charset";
import { SingleDrill, type DrillSummary } from "../training/singleDrill";
import { weakness, type CharStat } from "../training/stats";
import { h, prettyCode } from "./dom";
import { createKeyboard } from "./keyboard";

export class App {
  private readonly player = new MorsePlayer();
  private drill: SingleDrill | null = null;

  constructor(
    private readonly root: HTMLElement,
    private settings: Settings,
    private readonly stats: Map<string, CharStat>,
  ) {
    document.addEventListener("keydown", (e) => {
      if (!this.drill || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        this.stopDrill();
        return;
      }
      const ch = e.key.toUpperCase();
      if (MORSE[ch]) {
        e.preventDefault();
        this.drill.input(ch);
      }
    });
  }

  showHome(): void {
    this.render(
      h("h1", {}, "morse_one"),
      h("button", { class: "primary", type: "button", onclick: () => void this.startDrill() }, "単字即答をはじめる"),
      this.settingsForm(),
      h("div", { class: "row" },
        h("button", { type: "button", onclick: () => void this.testTone() }, "試聴"),
        h("button", { type: "button", onclick: () => this.showStats() }, "成績"),
      ),
    );
  }

  private settingsForm(): HTMLElement {
    const s = this.settings;
    const update = (patch: Partial<Settings>) => {
      this.settings = { ...this.settings, ...patch };
      saveSettings(this.settings);
    };
    return h("div", { class: "settings" },
      field("文字セット", select(
        Object.entries(CHARSET_LABELS).map(([v, l]) => [v, l]),
        s.charset,
        (v) => update({ charset: v as CharsetId }),
      )),
      field("文字速度", select(
        [15, 18, 20, 22, 25, 28, 30, 35].map((v) => [String(v), `${v} WPM`]),
        String(s.cwpm),
        (v) => update({ cwpm: Number(v) }),
      )),
      field("制限時間", select(
        [2000, 1500, 1200, 1000, 800, 700, 600, 500].map((v) => [String(v), `${(v / 1000).toFixed(1)} 秒`]),
        String(s.limitMs),
        (v) => update({ limitMs: Number(v) }),
      )),
      field("問題数", select(
        [20, 30, 50, 100].map((v) => [String(v), `${v} 問`]),
        String(s.questions),
        (v) => update({ questions: Number(v) }),
      )),
      field("周波数", range(400, 900, 10, s.freq, (v) => `${v} Hz`, (v) => update({ freq: v }))),
      field("音量", range(0.05, 1, 0.05, s.volume, (v) => `${Math.round(v * 100)}%`, (v) => update({ volume: v }))),
    );
  }

  private async testTone(): Promise<void> {
    await this.player.unlock();
    const { cwpm, freq, volume } = this.settings;
    this.player.play("PARIS", farnsworth(cwpm, cwpm), { freq, volume });
  }

  private async startDrill(): Promise<void> {
    await this.player.unlock();

    const progress = h("div", { class: "progress" });
    const display = h("div", { class: "display" });
    const detail = h("div", { class: "detail" });
    const keyboard = createKeyboard(charsetChars(this.settings.charset), (ch) => this.drill?.input(ch));

    this.render(
      h("div", { class: "drill" },
        h("div", { class: "row" },
          progress,
          h("button", { type: "button", class: "small", onclick: () => this.stopDrill() }, "中断"),
        ),
        display,
        detail,
        keyboard,
      ),
    );

    this.drill = new SingleDrill({
      player: this.player,
      settings: this.settings,
      stats: this.stats,
      save: saveAttempt,
      onEvent: (e) => {
        switch (e.type) {
          case "question":
            progress.textContent = `${e.index + 1} / ${e.total}`;
            display.className = "display listening";
            display.textContent = "?";
            detail.textContent = "";
            break;
          case "result": {
            display.className = `display ${e.correct ? "ok" : "ng"}`;
            display.textContent = e.target;
            const rt = e.rtMs === null ? "時間切れ" : `${e.rtMs} ms`;
            detail.replaceChildren(h("div", {}, `${prettyCode(MORSE[e.target])}　${rt}`));
            if (e.answer && e.answer !== e.target) {
              detail.append(h("div", { class: "yours" }, `あなたの答え ${e.answer}　${prettyCode(MORSE[e.answer])}`));
            }
            break;
          }
          case "finished":
            this.drill = null;
            this.showResult(e.summary);
            break;
        }
      },
    });
    this.drill.start();
  }

  private stopDrill(): void {
    this.drill?.abort();
    this.drill = null;
    this.showHome();
  }

  private showResult(summary: DrillSummary): void {
    const total = summary.results.length;
    const misses = new Map<string, number>();
    for (const r of summary.results) {
      if (!r.correct) misses.set(r.target, (misses.get(r.target) ?? 0) + 1);
    }
    const missList = [...misses.entries()].sort((a, b) => b[1] - a[1]);

    this.render(
      h("h1", {}, "結果"),
      h("div", { class: "summary" },
        h("div", {}, `正答 ${summary.correct} / ${total}（${Math.round((summary.correct / total) * 100)}%）`),
        h("div", {}, `平均反応時間 ${summary.avgRtMs === null ? "―" : `${summary.avgRtMs} ms`}`),
      ),
      missList.length > 0
        ? h("div", { class: "misses" },
            h("h2", {}, "間違えた文字"),
            ...missList.map(([c, n]) => h("span", { class: "chip" }, `${c} ×${n}`)),
          )
        : h("p", {}, "全問正解！"),
      h("div", { class: "row" },
        h("button", { class: "primary", type: "button", onclick: () => void this.startDrill() }, "もう一度"),
        h("button", { type: "button", onclick: () => this.showHome() }, "ホーム"),
      ),
    );
  }

  private showStats(): void {
    const now = Date.now();
    const { limitMs } = this.settings;
    const rows = charsetChars(this.settings.charset)
      .map((c) => ({ c, s: this.stats.get(c), w: weakness(this.stats.get(c), limitMs, now) }))
      .sort((a, b) => b.w - a.w);

    this.render(
      h("h1", {}, "成績"),
      h("p", { class: "note" }, "苦手度の高い順。正答率・反応時間は直近の結果を重視した平均"),
      h("table", { class: "stats" },
        h("thead", {}, h("tr", {},
          ...["文字", "符号", "回数", "正答率", "反応", "苦手度"].map((t) => h("th", {}, t)),
        )),
        h("tbody", {}, ...rows.map(({ c, s, w }) => h("tr", {},
          h("td", { class: "char" }, c),
          h("td", {}, prettyCode(MORSE[c])),
          h("td", {}, String(s?.attempts ?? 0)),
          h("td", {}, s?.attempts ? `${Math.round(s.accEma * 100)}%` : "―"),
          h("td", {}, s?.rtEma != null ? `${Math.round(s.rtEma)}` : "―"),
          h("td", {}, w.toFixed(2)),
        ))),
      ),
      h("button", { type: "button", onclick: () => this.showHome() }, "ホーム"),
    );
  }

  private render(...children: Node[]): void {
    this.root.replaceChildren(...children);
  }
}

function field(label: string, control: HTMLElement): HTMLElement {
  return h("label", { class: "field" }, h("span", {}, label), control);
}

function select(options: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const el = h("select", {}, ...options.map(([v, l]) => h("option", { value: v, textContent: l })));
  el.value = value;
  el.addEventListener("change", () => onChange(el.value));
  return el;
}

function range(
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
