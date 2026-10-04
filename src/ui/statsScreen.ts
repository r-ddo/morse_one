import { MORSE } from "../audio/code";
import { backupFileName, makeBackup, parseBackup } from "../storage/backup";
import { loadAll, loadAttempts, loadSends, replaceAll, type Attempt, type SendRecord } from "../storage/db";
import { DEFAULT_SETTINGS, saveSettings } from "../storage/settings";
import { charsetChars } from "../training/charset";
import { dailySends, dailyStats, dayKey, streakDays } from "../training/history";
import { sendCharStats, sendConfusions, sendErrorRate } from "../training/sendWeak";
import { weakness } from "../training/stats";
import { chart } from "./chart";
import type { ScreenContext } from "./context";
import { h, prettyCode } from "./dom";

/** グラフに出す日数 */
const DAYS = 14;
/** 送信の苦手な文字・取り違えを集計する期間（ミリ秒） */
const SEND_WINDOW_MS = 60 * 86_400_000;
/** 最後に開いたタブ（端末ごとの表示の好みなので localStorage に置く） */
const TAB_KEY = "morse_one.statsTab";

type Tab = "receive" | "send";

export async function showStats(ctx: ScreenContext): Promise<void> {
  const attempts = await loadAttempts().catch((e): Attempt[] => {
    console.error("failed to load attempts", e);
    return [];
  });
  const sends = await loadSends().catch((e): SendRecord[] => {
    console.error("failed to load sends", e);
    return [];
  });
  const now = Date.now();
  const sections: Record<Tab, HTMLElement> = {
    receive: receiveSection(ctx, attempts, now),
    send: sendSection(sends, now),
  };
  const labels: Record<Tab, string> = { receive: "受信", send: "送信" };
  const tabs = (Object.keys(sections) as Tab[]).map((tab) =>
    h("button", { type: "button", onclick: () => select(tab) }, labels[tab]));
  const select = (tab: Tab) => {
    (Object.keys(sections) as Tab[]).forEach((t, i) => {
      sections[t].hidden = t !== tab;
      tabs[i].classList.toggle("selected", t === tab);
      tabs[i].setAttribute("aria-pressed", String(t === tab));
    });
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      // 覚えられなくても表示は続ける
    }
  };
  let initial: Tab = "receive";
  try {
    if (localStorage.getItem(TAB_KEY) === "send") initial = "send";
  } catch {
    // 既定のタブで表示する
  }

  ctx.render(
    h("h1", {}, "成績"),
    h("div", { class: "tabs" }, ...tabs),
    sections.receive,
    sections.send,
    backupSection(ctx),
    h("button", { type: "button", onclick: () => ctx.showHome() }, "ホーム"),
  );
  select(initial);
}

function tile(label: string, value: string): HTMLElement {
  return h("div", { class: "tile" }, h("div", { class: "tile-label" }, label), h("div", { class: "tile-value" }, value));
}

function receiveSection(ctx: ScreenContext, attempts: Attempt[], now: number): HTMLElement {
  const days = dailyStats(attempts, DAYS, now);
  const practiced = attempts.filter((a) => a.mode !== "contrast");
  const today = days[days.length - 1];

  const charts = [
    chart(days.map((d) => ({ label: d.label, value: d.chars })), {
      title: "練習した字数（字）",
      kind: "column",
      format: (v) => `${Math.round(v)} 字`,
    }),
    chart(days.map((d) => ({ label: d.label, value: d.chars ? (d.correct / d.chars) * 100 : null })), {
      title: "正答率（%）",
      kind: "line",
      format: (v) => `${Math.round(v)}%`,
    }),
    chart(days.map((d) => ({ label: d.label, value: d.rtMs })), {
      title: "単字即答の反応時間（ms・正解の平均）",
      kind: "line",
      format: (v) => `${Math.round(v)} ms`,
    }),
  ];
  if (days.some((d) => d.ewpm !== null)) {
    charts.push(chart(days.map((d) => ({ label: d.label, value: d.ewpm })), {
      title: "グループ受信の実効速度（WPM）",
      axisFormat: (v) => String(Number.isInteger(v) ? v : v.toFixed(1)),
      kind: "line",
      format: (v) => `${Number.isInteger(v) ? v : v.toFixed(1)} WPM`,
    }));
  }
  if (days.some((d) => d.cpm !== null)) {
    charts.push(chart(days.map((d) => ({ label: d.label, value: d.cpm })), {
      title: "遅れ受信の速度（字/分）",
      kind: "line",
      format: (v) => `${Math.round(v)} 字/分`,
    }));
  }

  const { limitMs, charset } = ctx.settings;
  const confusions = ctx.confusions.top(10, now);
  const rows = charsetChars(charset)
    .map((c) => ({ c, s: ctx.stats.get(c), w: weakness(ctx.stats.get(c), limitMs, now) }))
    .sort((a, b) => b.w - a.w);

  return h("section", { class: "stats-section" },
    h("div", { class: "tiles" },
      tile("今日", `${today.chars} 字`),
      tile("連続", `${streakDays(attempts, now)} 日`),
      tile("累計", `${practiced.length.toLocaleString("ja-JP")} 字`),
    ),
    h("p", { class: "note" }, `受信練習の直近 ${DAYS} 日。グラフをタップするとその日の値を表示します`),
    ...charts,
    h("h2", {}, "文字ごとの成績"),
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
    confusions.length > 0 &&
      h("div", { class: "misses" },
        h("h2", {}, "取り違え（最近のものほど上位）"),
        ...confusions.map((p) => h("span", { class: "chip" }, `${p.a} / ${p.b} ×${p.count}`)),
      ),
  );
}

function sendSection(sends: SendRecord[], now: number): HTMLElement {
  if (sends.length === 0) {
    return h("section", { class: "stats-section" },
      h("p", {}, "送信練習の記録はまだありません。ホームの「送信練習」から始められます"));
  }
  const days = dailySends(sends, DAYS, now);
  /** 実際に送った字数（未送信を除く） */
  const sentChars = (r: SendRecord) => (r.marks ? [...r.marks].filter((m) => m !== "-").length : r.target.length - r.unsent);
  const todayKey = dayKey(now);
  const todayChars = sends.filter((r) => dayKey(r.ts) === todayKey).reduce((a, r) => a + sentChars(r), 0);
  const recent = sends.slice(0, 10);
  const avgPoints = recent.reduce((a, r) => a + r.points, 0) / recent.length;

  const stats = sendCharStats(sends, now - SEND_WINDOW_MS);
  const rows = [...stats.values()].sort((a, b) => sendErrorRate(b) - sendErrorRate(a));
  const confusions = sendConfusions(stats, 10);
  const date = (ts: number) => new Date(ts).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });

  return h("section", { class: "stats-section" },
    h("div", { class: "tiles" },
      tile("今日", `${todayChars} 字`),
      tile("練習", `${sends.length} 回`),
      tile("最近の平均", `${Math.round(avgPoints)} 点`),
    ),
    h("p", { class: "note" }, `送信練習の直近 ${DAYS} 日。「最近の平均」は直近 ${recent.length} 回の得点の平均`),
    chart(days.map((d) => ({ label: d.label, value: d.points })), {
      title: "得点（点・その日の平均）",
      kind: "line",
      format: (v) => `${Math.round(v)} 点`,
    }),
    chart(days.map((d) => ({ label: d.label, value: d.cpm })), {
      title: "送信の速度（字/分・その日の平均）",
      kind: "line",
      format: (v) => `${Math.round(v)} 字/分`,
    }),
    h("h2", {}, "文字ごとの成績"),
    rows.length > 0
      ? h("div", {},
          h("p", { class: "note" },
            "直近 60 日。誤り率の高い順。誤り率は誤字・脱字を 1、符号不明りょうを 0.5 と数え、回数が少ないうちは 10% に寄せた値"),
          h("table", { class: "stats" },
            h("thead", {}, h("tr", {}, ...["文字", "符号", "回数", "誤り", "不明りょう", "誤り率"].map((t) => h("th", {}, t)))),
            h("tbody", {}, ...rows.map((r) => h("tr", {},
              h("td", { class: "char" }, r.char),
              h("td", {}, prettyCode(MORSE[r.char])),
              h("td", {}, String(r.attempts)),
              h("td", {}, String(r.errors)),
              h("td", {}, String(r.unclear)),
              h("td", {}, `${Math.round(sendErrorRate(r) * 100)}%`),
            ))),
          ),
        )
      : h("p", { class: "note" }, "文字ごとの記録は、この機能を入れたあとの練習から集計します"),
    confusions.length > 0 &&
      h("div", { class: "misses" },
        h("h2", {}, "取り違え（お題 → 送った符号）"),
        ...confusions.map(([t, sent, n]) =>
          h("span", { class: "chip" }, `${t} → ${sent.length > 1 ? prettyCode(sent) : sent} ×${n}`)),
      ),
    h("h2", {}, "最近の結果"),
    h("table", { class: "stats" },
      h("thead", {}, h("tr", {}, ...["日付", "種類", "得点", "速度", "字数"].map((t) => h("th", {}, t)))),
      h("tbody", {}, ...recent.map((r) => h("tr", {},
        h("td", {}, date(r.ts)),
        h("td", {}, r.mode === "mock" ? `模擬 ${r.minutes} 分` : "グループ"),
        h("td", {}, `${r.points} 点`),
        h("td", {}, r.cpm === null ? "―" : `${Math.round(r.cpm)} 字/分`),
        h("td", {}, `${sentChars(r)} 字`),
      ))),
    ),
  );
}

function backupSection(ctx: ScreenContext): HTMLElement {
  const message = h("p", { class: "note" });
  const fileInput = h("input", { type: "file", accept: "application/json,.json", hidden: true });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    fileInput.value = "";
    if (file) void importBackup(file, message);
  });

  return h("section", { class: "backup" },
    h("h2", {}, "データのバックアップ"),
    h("p", { class: "note" },
      "記録はこの端末の中にだけ保存されています。ホーム画面のアイコンを削除したり機種を変えたりすると消えるので、" +
      "ときどき書き出してファイルアプリや iCloud Drive に保存してください"),
    h("div", { class: "row" },
      h("button", { type: "button", onclick: () => void exportBackup(ctx, message) }, "書き出す"),
      h("button", { type: "button", onclick: () => fileInput.click() }, "読み込む"),
    ),
    fileInput,
    message,
  );
}

async function exportBackup(ctx: ScreenContext, message: HTMLElement): Promise<void> {
  try {
    const backup = makeBackup(await loadAll(), ctx.settings);
    const name = backupFileName();
    const file = new File([JSON.stringify(backup)], name, { type: "application/json" });
    // iPhone では共有シートから「ファイルに保存」できる
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        message.textContent = `${name} を書き出しました`;
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
      }
    }
    const url = URL.createObjectURL(file);
    const a = h("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    message.textContent = `${name} を書き出しました`;
  } catch (e) {
    console.error("failed to export", e);
    message.textContent = "書き出しに失敗しました";
  }
}

async function importBackup(file: File, message: HTMLElement): Promise<void> {
  try {
    const backup = parseBackup(await file.text());
    const when = new Date(backup.exportedAt).toLocaleString("ja-JP");
    const ok = confirm(
      `${when} に書き出したデータ（解答 ${backup.attempts.length} 件・模擬試験 ${backup.mocks.length} 件・送信 ${backup.sends.length} 件）で、` +
      "今のデータと設定をすべて置き換えます。よろしいですか？",
    );
    if (!ok) return;
    await replaceAll(backup);
    saveSettings({ ...DEFAULT_SETTINGS, ...backup.settings });
    // 読み込んだデータで成績・取り違えを作り直すため再起動する
    location.reload();
  } catch (e) {
    console.error("failed to import", e);
    message.textContent = `読み込めませんでした: ${e instanceof Error ? e.message : String(e)}`;
  }
}
