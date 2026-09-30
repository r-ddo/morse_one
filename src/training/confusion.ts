/** 取り違えの重みが半分になるまでの日数 */
export const HALF_LIFE_DAYS = 14;

/** 記録がないときの候補。符号が似ていて取り違えやすい組み合わせ */
export const COMMON_PAIRS: [string, string][] = [
  ["H", "5"],
  ["S", "H"],
  ["B", "6"],
  ["V", "4"],
  ["U", "V"],
  ["D", "B"],
  ["W", "J"],
  ["G", "Z"],
  ["K", "C"],
  ["2", "3"],
];

export interface ConfusionPair {
  /** 組み合わせ（文字コード順） */
  a: string;
  b: string;
  /** 古い記録ほど小さくした重み */
  weight: number;
  /** 取り違えた回数 */
  count: number;
}

function key(x: string, y: string): string {
  return x < y ? `${x}${y}` : `${y}${x}`;
}

/** 取り違え（正解 → 入力）を向きを区別せずに集計する */
export class ConfusionTracker {
  private readonly events = new Map<string, number[]>();

  add(target: string, answer: string, ts: number): void {
    if (target === answer) return;
    const k = key(target, answer);
    const list = this.events.get(k);
    if (list) list.push(ts);
    else this.events.set(k, [ts]);
  }

  /** 重みの大きい順に最大 n 組 */
  top(n: number, now: number): ConfusionPair[] {
    const halfLifeMs = HALF_LIFE_DAYS * 86_400_000;
    return [...this.events.entries()]
      .map(([k, tss]) => ({
        a: k[0],
        b: k[1],
        weight: tss.reduce((w, ts) => w + 0.5 ** (Math.max(0, now - ts) / halfLifeMs), 0),
        count: tss.length,
      }))
      .sort((x, y) => y.weight - x.weight)
      .slice(0, n);
  }
}
