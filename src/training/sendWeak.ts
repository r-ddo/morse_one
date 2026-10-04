import type { SendRecord } from "../storage/db";

/** 送信での文字ごとの成績 */
export interface SendCharStat {
  char: string;
  /** お題に出て、送った（未送信を除く）回数 */
  attempts: number;
  /** 誤字・脱字の回数 */
  errors: number;
  /** 符号不明りょうの回数 */
  unclear: number;
  /** 誤字のとき、代わりに送った文字（符号表にない符号は符号のまま）と回数 */
  confusions: Map<string, number>;
}

/** 誤り率の事前分布（記録が少ない文字を 10% 前後とみなす） */
const PRIOR_N = 4;
const PRIOR_ERRORS = 0.4;
/** 誤り率から出題の重みへの係数。誤り率 50% の文字は 5 倍、10% の文字は 1.8 倍出る */
const WEIGHT_SCALE = 8;

/** since（ミリ秒）以降の送信の記録から、文字ごとの成績を集計する。文字ごとの判定を持たない古い記録は除く */
export function sendCharStats(records: readonly SendRecord[], since = 0): Map<string, SendCharStat> {
  const stats = new Map<string, SendCharStat>();
  for (const r of records) {
    if (r.ts < since || !r.marks) continue;
    [...r.target].forEach((c, i) => {
      const m = r.marks![i];
      if (m === undefined || m === "-") return;
      let s = stats.get(c);
      if (!s) stats.set(c, (s = { char: c, attempts: 0, errors: 0, unclear: 0, confusions: new Map() }));
      s.attempts++;
      if (m === "w" || m === "m") s.errors++;
      if (m === "u") s.unclear++;
      const sent = r.sentAt?.[i];
      if (m === "w" && sent) s.confusions.set(sent, (s.confusions.get(sent) ?? 0) + 1);
    });
  }
  return stats;
}

/** 誤り率（符号不明りょうは半分に数える）。記録が少ないうちは 10% に寄せる */
export function sendErrorRate(s: SendCharStat | undefined): number {
  if (!s) return PRIOR_ERRORS / PRIOR_N;
  return (s.errors + 0.5 * s.unclear + PRIOR_ERRORS) / (s.attempts + PRIOR_N);
}

/** 出題の重み（chars と同じ順） */
export function sendWeights(stats: Map<string, SendCharStat>, chars: readonly string[]): number[] {
  return chars.map((c) => 1 + WEIGHT_SCALE * sendErrorRate(stats.get(c)));
}

/** 誤り率の高い順に、minAttempts 回以上送った文字 */
export function weakSendChars(stats: Map<string, SendCharStat>, count: number, minAttempts = 3): SendCharStat[] {
  return [...stats.values()]
    .filter((s) => s.attempts >= minAttempts && s.errors + s.unclear > 0)
    .sort((a, b) => sendErrorRate(b) - sendErrorRate(a))
    .slice(0, count);
}

/** 多い順の取り違え（お題の文字、代わりに送った文字、回数） */
export function sendConfusions(stats: Map<string, SendCharStat>, count: number): [string, string, number][] {
  const list: [string, string, number][] = [];
  for (const s of stats.values()) for (const [sent, n] of s.confusions) list.push([s.char, sent, n]);
  return list.sort((a, b) => b[2] - a[2]).slice(0, count);
}
