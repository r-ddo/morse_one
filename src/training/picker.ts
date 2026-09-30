import { weakness, type CharStat } from "./stats";

/** 苦手な文字から出題する割合。残りは全体から一様に出題 */
export const WEAK_RATIO = 0.6;

export interface PickOptions {
  limitMs: number;
  now: number;
  /** 直前に出した文字（連続出題を避ける） */
  exclude?: string;
  random?: () => number;
}

export function pickChar(
  chars: readonly string[],
  stats: ReadonlyMap<string, CharStat>,
  opts: PickOptions,
): string {
  const random = opts.random ?? Math.random;
  const pool = chars.length > 1 ? chars.filter((c) => c !== opts.exclude) : [...chars];

  if (random() >= WEAK_RATIO) {
    return pool[Math.floor(random() * pool.length)];
  }

  const weights = pool.map((c) => weakness(stats.get(c), opts.limitMs, opts.now));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = random() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r < 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/** 配列をシャッフルした新しい配列を返す */
export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
