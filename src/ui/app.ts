import { MORSE } from "../audio/code";
import { MorsePlayer } from "../audio/player";
import { farnsworth } from "../audio/timing";
import { saveAttempt, saveAttempts } from "../storage/db";
import { saveSettings, type Settings } from "../storage/settings";
import { CHARSET_LABELS, charsetChars, type CharsetId } from "../training/charset";
import { GroupDrill, UNKNOWN, type GroupSummary } from "../training/groupDrill";
import { SingleDrill, type DrillResult, type DrillSummary, type Verdict } from "../training/singleDrill";
import { weakness, type CharStat } from "../training/stats";
import { h, prettyCode } from "./dom";
import { createKeyboard } from "./keyboard";

/** 実行中の練習。物理キーボードの入力を受け取る */
interface ActiveDrill {
  /** 処理したキーなら true */
  key(e: KeyboardEvent): boolean;
  abort(): void;
}

export class App {
  private readonly player = new MorsePlayer();
  private active: ActiveDrill | null = null;

  constructor(
    private readonly root: HTMLElement,
    private settings: Settings,
    private readonly stats: Map<string, CharStat>,
  ) {
    document.addEventListener("keydown", (e) => {
      if (!this.active || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        this.stopDrill();
        return;
      }
      if (this.active.key(e)) e.preventDefault();
    });
  }

  showHome(): void {
    this.render(
      h("h1", {}, "morse_one"),
      h("button", { class: "primary", type: "button", onclick: () => void this.startDrill() }, "単字即答をはじめる"),
      h("button", { class: "primary", type: "button", onclick: () => void this.startGroupDrill() }, "5文字グループをはじめる"),
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
      field("目標時間（単字）", select(
        [
          ["auto", `自動（現在 ${sec(s.limitMs)}）`],
          ...[5000, 3000, 2000, 1500, 1000, 700, 500].map((v): [string, string] => [String(v), sec(v)]),
        ],
        s.autoLimit ? "auto" : String(s.limitMs),
        (v) => update(v === "auto" ? { autoLimit: true } : { autoLimit: false, limitMs: Number(v) }),
      )),
      field("問題数（単字）", select(
        [20, 30, 50, 100].map((v) => [String(v), `${v} 問`]),
        String(s.questions),
        (v) => update({ questions: Number(v) }),
      )),
      field("実効速度（グループ）", select(
        [
          ["auto", `自動（現在 ${wpm(s.ewpm)}）`],
          ...[3, 4, 5, 6, 8, 10, 12, 15, 18, 20, 25].map((v): [string, string] => [String(v), wpm(v)]),
        ],
        s.autoEwpm ? "auto" : String(s.ewpm),
        (v) => update(v === "auto" ? { autoEwpm: true } : { autoEwpm: false, ewpm: Number(v) }),
      )),
      field("グループ数", select(
        [5, 10, 20, 30].map((v) => [String(v), `${v} 組`]),
        String(s.groups),
        (v) => update({ groups: Number(v) }),
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
    const keyboard = createKeyboard(charsetChars(this.settings.charset), (ch) => drill.input(ch));

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

    const drill = new SingleDrill({
      player: this.player,
      settings: this.settings,
      stats: this.stats,
      save: saveAttempt,
      onEvent: (e) => {
        switch (e.type) {
          case "question":
            progress.textContent = `${e.index + 1} / ${e.total}　目標 ${sec(e.limitMs)}`;
            display.className = "display listening";
            display.textContent = "?";
            detail.textContent = "";
            break;
          case "result": {
            display.className = `display ${VERDICT_CLASS[e.verdict]}`;
            display.textContent = e.target;
            const rt = { fast: `${e.rtMs} ms`, slow: `${e.rtMs} ms（遅い）`, wrong: "不正解", timeout: "時間切れ" }[e.verdict];
            detail.replaceChildren(
              h("div", {}, rt),
              h("div", { class: "code-line", dataset: { which: "target" } },
                `正解 ${e.target}　${prettyCode(MORSE[e.target])}`),
            );
            if (e.answer && e.answer !== e.target) {
              detail.append(h("div", { class: "code-line yours", dataset: { which: "answer" } },
                `あなたの答え ${e.answer}　${prettyCode(MORSE[e.answer])}`));
            }
            break;
          }
          case "replay":
            for (const line of detail.querySelectorAll<HTMLElement>(".code-line")) {
              line.classList.toggle("playing", line.dataset.which === e.which);
            }
            break;
          case "limit":
            this.settings = { ...this.settings, limitMs: e.limitMs };
            saveSettings(this.settings);
            break;
          case "finished":
            this.active = null;
            this.showResult(e.summary);
            break;
        }
      },
    });
    this.active = {
      key: (e) => {
        const ch = e.key.toUpperCase();
        if (!MORSE[ch]) return false;
        drill.input(ch);
        return true;
      },
      abort: () => drill.abort(),
    };
    drill.start();
  }

  private async startGroupDrill(): Promise<void> {
    await this.player.unlock();

    const progress = h("div", { class: "progress" });
    const speed = h("div", { class: "speed" });
    const slots = Array.from({ length: 5 }, () => h("div", { class: "slot" }));
    const answer = Array.from({ length: 5 }, () => h("div", { class: "slot answer" }));
    const status = h("div", { class: "status" });
    const nextBtn = h("button", { type: "button", class: "primary", onclick: () => drill.next() }, "次へ");
    const replayBtn = h("button", { type: "button", onclick: () => drill.replay() }, "もう一度聞く");
    const review = h("div", { class: "row review" }, replayBtn, nextBtn);
    const keyboard = createKeyboard(charsetChars(this.settings.charset), (ch) => drill.input(ch), [
      { label: "不明", onPress: () => drill.unknown() },
      { label: "⌫", onPress: () => drill.backspace() },
      { label: "確定", onPress: () => drill.submit(), class: "key-submit" },
    ]);

    this.render(
      h("div", { class: "drill" },
        h("div", { class: "row" },
          progress,
          h("button", { type: "button", class: "small", onclick: () => this.stopDrill() }, "中断"),
        ),
        speed,
        h("div", { class: "slots" }, ...slots),
        h("div", { class: "slots" }, ...answer),
        status,
        review,
        keyboard,
      ),
    );

    const drill = new GroupDrill({
      player: this.player,
      settings: this.settings,
      stats: this.stats,
      save: saveAttempts,
      onEvent: (e) => {
        switch (e.type) {
          case "group":
            progress.textContent = `${e.index + 1} / ${e.total}`;
            speed.textContent = `実効 ${wpm(e.ewpm)}（文字間 ${e.charGapSec.toFixed(2)} 秒）`;
            for (const a of answer) {
              a.textContent = "";
              a.className = "slot answer";
            }
            status.textContent = "再生中… 聞きながら入力できます";
            review.hidden = true;
            break;
          case "typed":
            slots.forEach((s, i) => {
              const c = e.typed[i] ?? "";
              s.textContent = c === UNKNOWN ? "?" : c;
              s.className = `slot${i === e.typed.length ? " cursor" : ""}${c === UNKNOWN ? " unknown" : ""}`;
            });
            break;
          case "played":
            status.textContent = "入力して「確定」（5文字入力で自動確定）";
            break;
          case "checked": {
            e.marks.forEach((ok, i) => {
              slots[i].classList.add(ok ? "ok" : "ng");
              answer[i].textContent = e.target[i];
              answer[i].classList.toggle("ng", !ok);
            });
            const n = e.marks.filter(Boolean).length;
            status.textContent = n === e.marks.length ? "全問正解！" : `${n} / ${e.marks.length} 正解`;
            review.hidden = n === e.marks.length;
            break;
          }
          case "ewpm":
            this.settings = { ...this.settings, ewpm: e.ewpm };
            saveSettings(this.settings);
            break;
          case "finished":
            this.active = null;
            this.showGroupResult(e.summary);
            break;
        }
      },
    });
    this.active = {
      key: (e) => {
        if (e.key === "Backspace") drill.backspace();
        else if (e.key === "Enter") review.hidden ? drill.submit() : drill.next();
        else if (e.key === " ") drill.unknown();
        else if (MORSE[e.key.toUpperCase()]) drill.input(e.key.toUpperCase());
        else return false;
        return true;
      },
      abort: () => drill.abort(),
    };
    drill.start();
  }

  private stopDrill(): void {
    this.active?.abort();
    this.active = null;
    this.showHome();
  }

  private showGroupResult(summary: GroupSummary): void {
    const misses = new Map<string, number>();
    const confusions = new Map<string, number>();
    for (const r of summary.results) {
      [...r.target].forEach((c, i) => {
        if (r.marks[i]) return;
        misses.set(c, (misses.get(c) ?? 0) + 1);
        const t = r.typed[i];
        if (t && t !== UNKNOWN) confusions.set(`${c}→${t}`, (confusions.get(`${c}→${t}`) ?? 0) + 1);
      });
    }
    const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
    const chips = (title: string, list: [string, number][]) =>
      list.length > 0 &&
      h("div", { class: "misses" },
        h("h2", {}, title),
        ...list.map(([c, n]) => h("span", { class: "chip" }, `${c} ×${n}`)),
      );
    const pct = summary.total ? Math.round((summary.correct / summary.total) * 100) : 0;

    this.render(
      h("h1", {}, "結果"),
      h("div", { class: "summary" },
        h("div", {}, `正解 ${summary.correct} / ${summary.total} 文字（${pct}%）`),
        h("div", {}, `実効速度 ${wpm(summary.startEwpm)} → ${wpm(summary.endEwpm)}`),
      ),
      chips("間違えた文字", sorted(misses)),
      chips("取り違え（正解→入力）", sorted(confusions)),
      h("div", { class: "row" },
        h("button", { class: "primary", type: "button", onclick: () => void this.startGroupDrill() }, "もう一度"),
        h("button", { type: "button", onclick: () => this.showHome() }, "ホーム"),
      ),
    );
  }

  private showResult(summary: DrillSummary): void {
    const total = summary.results.length;
    const misses = countBy(summary.results.filter((r) => r.verdict === "wrong" || r.verdict === "timeout"));
    const slows = countBy(summary.results.filter((r) => r.verdict === "slow"));
    const pct = (n: number) => `${Math.round((n / total) * 100)}%`;
    const chips = (title: string, list: [string, number][]) =>
      list.length > 0 &&
      h("div", { class: "misses" },
        h("h2", {}, title),
        ...list.map(([c, n]) => h("span", { class: "chip" }, `${c} ×${n}`)),
      );

    this.render(
      h("h1", {}, "結果"),
      h("div", { class: "summary" },
        h("div", {}, `正解 ${summary.correct} / ${total}（${pct(summary.correct)}）`),
        h("div", {}, `目標時間内 ${summary.fast} / ${total}（${pct(summary.fast)}）`),
        h("div", {}, `平均反応時間 ${summary.avgRtMs === null ? "―" : `${summary.avgRtMs} ms`}`),
        h("div", {}, `次回の目標時間 ${sec(summary.limitMs)}`),
      ),
      chips("間違えた文字", misses),
      chips("遅かった文字", slows),
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

  private render(...children: (Node | null | false)[]): void {
    this.root.replaceChildren(...children.filter((c): c is Node => !!c));
  }
}

const VERDICT_CLASS: Record<Verdict, string> = { fast: "ok", slow: "slow", wrong: "ng", timeout: "ng" };

function wpm(v: number): string {
  return `${Number.isInteger(v) ? v : v.toFixed(1)} WPM`;
}

function sec(ms: number): string {
  return `${(ms / 1000).toFixed(ms % 100 === 0 ? 1 : 2)} 秒`;
}

/** 文字ごとの回数を多い順に */
function countBy(results: DrillResult[]): [string, number][] {
  const m = new Map<string, number>();
  for (const r of results) m.set(r.target, (m.get(r.target) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
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
