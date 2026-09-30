import type { Attempt } from "../storage/db";

/** 1 日分の集計 */
export interface DayStat {
  /** 例: "2026-09-30"（端末のタイムゾーン） */
  date: string;
  /** 例: "9/30" */
  label: string;
  /** 練習した字数（聞き分け練習の 2 択は除く） */
  chars: number;
  correct: number;
  /** 単字即答の正解の平均反応時間（ミリ秒） */
  rtMs: number | null;
  /** グループ受信の平均実効速度（WPM） */
  ewpm: number | null;
  /** 遅れ受信の平均速度（字/分） */
  cpm: number | null;
}

const DAY_MS = 86_400_000;

export function dayKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 端末のタイムゾーンでその日の 0 時 */
function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** 今日を含む直近 days 日を古い順に集計する。練習していない日も 0 字として含める */
export function dailyStats(attempts: readonly Attempt[], days: number, now: number): DayStat[] {
  const today = startOfDay(now);
  const buckets = new Map<string, Attempt[]>();
  for (let i = days - 1; i >= 0; i--) {
    // 夏時間のある地域でも日付がずれないよう、正午を基準に 1 日ずつ戻る
    buckets.set(dayKey(today - i * DAY_MS + DAY_MS / 2), []);
  }
  for (const a of attempts) {
    if (a.mode === "contrast") continue;
    buckets.get(dayKey(a.ts))?.push(a);
  }
  return [...buckets.entries()].map(([date, list]) => {
    const [, m, d] = date.split("-").map(Number);
    const rts = list.filter((a) => a.mode === "single" && a.correct && a.rtMs !== null).map((a) => a.rtMs!);
    return {
      date,
      label: `${m}/${d}`,
      chars: list.length,
      correct: list.filter((a) => a.correct).length,
      rtMs: mean(rts),
      ewpm: mean(list.filter((a) => a.mode === "group" && a.ewpm !== undefined).map((a) => a.ewpm!)),
      cpm: mean(list.filter((a) => a.mode === "stream" && a.cpm !== undefined).map((a) => a.cpm!)),
    };
  });
}

/** 今日（まだなら昨日）までの連続練習日数 */
export function streakDays(attempts: readonly Attempt[], now: number): number {
  const days = new Set(attempts.filter((a) => a.mode !== "contrast").map((a) => dayKey(a.ts)));
  let t = startOfDay(now) + DAY_MS / 2;
  if (!days.has(dayKey(t))) t -= DAY_MS;
  let streak = 0;
  while (days.has(dayKey(t))) {
    streak++;
    t -= DAY_MS;
  }
  return streak;
}
