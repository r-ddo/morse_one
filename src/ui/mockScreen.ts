import { loadMocks, saveMock, type MockResult } from "../storage/db";
import { MORSE } from "../audio/code";
import { averageCodeUnits, maxCharsPerMinute } from "../audio/timing";
import { CHARSET_LABELS, charsetChars } from "../training/charset";
import { MockExam, mockLength } from "../training/mockExam";
import { selfScore } from "../training/scoring";
import type { ScreenContext } from "./context";
import { h } from "./dom";
import { field, select, speedLimitNote } from "./form";
import { keepScreenOn } from "./wakeLock";

/** 1 総通の欧文暗語受信: 1 分間 80 字・約 5 分間 */
const EXAM_CPM = 80;
const EXAM_MINUTES = 5;
/** 1 行に並べるグループ数 */
const GROUPS_PER_LINE = 5;

export async function showMockMenu(ctx: ScreenContext): Promise<void> {
  const mocks = await loadMocks().catch((e): MockResult[] => {
    console.error("failed to load mocks", e);
    return [];
  });
  const s = ctx.settings;
  const length = h("div", { class: "note" });
  const warning = h("div", { class: "warning" });
  const updateLength = () => {
    const { mockCpm, mockMinutes, charset, cwpm } = ctx.settings;
    length.textContent = `${mockLength(mockCpm, mockMinutes)} 字（${CHARSET_LABELS[charset]}）`;
    const avg = averageCodeUnits(charsetChars(charset).map((c) => MORSE[c]));
    warning.textContent = speedLimitNote(mockCpm, maxCharsPerMinute(cwpm, avg), cwpm);
  };
  updateLength();

  ctx.render(
    h("h1", {}, "模擬試験"),
    h("p", { class: "note" },
      `1総通の欧文暗語受信は 1 分間 ${EXAM_CPM} 字・約 ${EXAM_MINUTES} 分間（約 400 字）。` +
      "紙と鉛筆を用意し、聞きながら書き取ってください。終了後に正解を表示するので自己採点します"),
    h("div", { class: "settings" },
      field("速度", select(
        [30, 40, 50, 60, 70, 80, 90, 100].map((v) => [String(v), v === EXAM_CPM ? `${v} 字/分（試験）` : `${v} 字/分`]),
        String(s.mockCpm),
        (v) => {
          ctx.updateSettings({ mockCpm: Number(v) });
          updateLength();
        },
      )),
      field("長さ", select(
        [1, 3, 5].map((v) => [String(v), v === EXAM_MINUTES ? `${v} 分（試験）` : `${v} 分`]),
        String(s.mockMinutes),
        (v) => {
          ctx.updateSettings({ mockMinutes: Number(v) });
          updateLength();
        },
      )),
      length,
      warning,
    ),
    h("button", { class: "primary", type: "button", onclick: () => void startMock(ctx) }, "はじめる"),
    mocks.length > 0 &&
      h("div", { class: "history" },
        h("h2", {}, "これまでの結果"),
        h("table", { class: "stats" },
          h("thead", {}, h("tr", {}, ...["日付", "速度", "字数", "得点"].map((t) => h("th", {}, t)))),
          h("tbody", {}, ...mocks.slice(0, 20).map((m) => h("tr", {},
            h("td", {}, new Date(m.ts).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })),
            h("td", {}, `${m.cpm} 字/分`),
            h("td", {}, String(m.chars)),
            h("td", { class: m.score >= 70 ? "pass" : "" }, `${m.score} 点`),
          ))),
        ),
      ),
    h("button", { type: "button", onclick: () => ctx.showHome() }, "ホーム"),
  );
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function startMock(ctx: ScreenContext): Promise<void> {
  await ctx.player.unlock();
  const release = await keepScreenOn();

  const timer = h("div", { class: "timer" }, "0:00");
  const bar = h("div", { class: "bar-fill" });
  const status = h("div", { class: "status" }, "「HR HR」の後に本文が始まります");
  let ticker: ReturnType<typeof setInterval> | undefined;

  ctx.render(
    h("div", { class: "drill" },
      h("div", { class: "row" },
        h("div", { class: "progress" }, `模擬試験 ${ctx.settings.mockCpm} 字/分`),
        h("button", { type: "button", class: "small", onclick: () => ctx.stopDrill() }, "中断"),
      ),
      timer,
      h("div", { class: "bar" }, bar),
      status,
    ),
  );

  const exam = new MockExam({
    player: ctx.player,
    settings: ctx.settings,
    onEvent: (e) => {
      if (e.type === "start") {
        const totalMs = e.endPerf - e.startPerf;
        ticker = setInterval(() => {
          const elapsed = Math.min(totalMs, Math.max(0, performance.now() - e.startPerf));
          timer.textContent = `${clock(elapsed)} / ${clock(totalMs)}`;
          bar.style.width = `${(elapsed / totalMs) * 100}%`;
          if (performance.now() >= e.startPerf) status.textContent = "書き取り中…";
        }, 200);
      } else {
        clearInterval(ticker);
        release();
        ctx.setActive(null);
        showMockCheck(ctx, e.groups);
      }
    },
  });
  ctx.setActive({
    key: () => false,
    abort: () => {
      clearInterval(ticker);
      exam.abort();
      release();
    },
  });
  exam.start();
}

function showMockCheck(ctx: ScreenContext, groups: string[]): void {
  const { mockCpm, mockMinutes, charset } = ctx.settings;
  const chars = groups.length * 5;
  const counts = { wrong: 0, missing: 0, extra: 0, corrections: 0 };
  const scoreView = h("div", { class: "score" });
  const updateScore = () => {
    const score = selfScore(counts.wrong, counts.missing, counts.extra, counts.corrections);
    scoreView.textContent = `${score} 点`;
    scoreView.classList.toggle("pass", score >= 70);
    return score;
  };
  const counter = (label: string, key: keyof typeof counts, note: string) => {
    const input = h("input", { type: "number", inputMode: "numeric", min: "0", value: "0", class: "count" });
    input.addEventListener("input", () => {
      counts[key] = Math.max(0, Math.floor(Number(input.value) || 0));
      updateScore();
    });
    return field(`${label}（${note}）`, input);
  };

  const lines: string[][] = [];
  for (let i = 0; i < groups.length; i += GROUPS_PER_LINE) lines.push(groups.slice(i, i + GROUPS_PER_LINE));
  updateScore();

  ctx.render(
    h("h1", {}, "答え合わせ"),
    h("p", { class: "note" }, `${chars} 字（${mockCpm} 字/分・${mockMinutes} 分）。書き取った紙と照らし合わせてください`),
    h("div", { class: "answer-sheet" },
      ...lines.map((line, li) => h("div", { class: "answer-line" },
        h("span", { class: "line-no" }, String(li + 1)),
        ...line.map((g) => h("span", { class: "answer-group" }, g)),
      )),
    ),
    h("div", { class: "settings" },
      counter("誤字", "wrong", "3 点"),
      counter("脱字", "missing", "1 点"),
      counter("冗字", "extra", "3 点"),
      counter("抹消・訂正", "corrections", "3 字ごと 1 点"),
      h("div", { class: "field" }, h("span", {}, "得点（品位を除く）"), scoreView),
    ),
    h("p", { class: "note" }, "合格の目安: 和文・欧文暗語・欧文普通語の合計 210 点以上（平均 70 点）、かつ各 30 点以上"),
    h("div", { class: "row" },
      h("button", {
        class: "primary",
        type: "button",
        onclick: () => {
          const score = updateScore();
          saveMock({ ts: Date.now(), cpm: mockCpm, minutes: mockMinutes, chars, charset, ...counts, score })
            .catch((e) => console.error("failed to save mock", e))
            .finally(() => void showMockMenu(ctx));
        },
      }, "記録して戻る"),
      h("button", { type: "button", onclick: () => void showMockMenu(ctx) }, "記録しない"),
    ),
  );
}
