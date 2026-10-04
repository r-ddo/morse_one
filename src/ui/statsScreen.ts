import { MORSE } from "../audio/code";
import { backupFileName, makeBackup, parseBackup } from "../storage/backup";
import { loadAll, loadAttempts, replaceAll, type Attempt } from "../storage/db";
import { DEFAULT_SETTINGS, saveSettings } from "../storage/settings";
import { charsetChars } from "../training/charset";
import { dailyStats, streakDays } from "../training/history";
import { weakness } from "../training/stats";
import { chart } from "./chart";
import type { ScreenContext } from "./context";
import { h, prettyCode } from "./dom";

/** グラフに出す日数 */
const DAYS = 14;

export async function showStats(ctx: ScreenContext): Promise<void> {
  const attempts = await loadAttempts().catch((e): Attempt[] => {
    console.error("failed to load attempts", e);
    return [];
  });
  const now = Date.now();
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

  const tile = (label: string, value: string) =>
    h("div", { class: "tile" }, h("div", { class: "tile-label" }, label), h("div", { class: "tile-value" }, value));

  ctx.render(
    h("h1", {}, "成績"),
    h("div", { class: "tiles" },
      tile("今日", `${today.chars} 字`),
      tile("連続", `${streakDays(attempts, now)} 日`),
      tile("累計", `${practiced.length.toLocaleString("ja-JP")} 字`),
    ),
    h("p", { class: "note" }, `直近 ${DAYS} 日。グラフをタップするとその日の値を表示します`),
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
    backupSection(ctx),
    h("button", { type: "button", onclick: () => ctx.showHome() }, "ホーム"),
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
