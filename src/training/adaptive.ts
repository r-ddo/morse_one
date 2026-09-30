/** 目標時間を見直す間隔（問題数） */
export const ADAPT_WINDOW = 10;
/** 目標時間内の正答率がこれ以上なら目標を短くする */
export const TIGHTEN_RATE = 0.9;
/** 目標時間内の正答率がこれ未満なら目標を長くする */
export const LOOSEN_RATE = 0.6;
export const MIN_LIMIT_MS = 400;
export const MAX_LIMIT_MS = 6000;

/** 直近 ADAPT_WINDOW 問の「目標時間内の正答」の割合から次の目標時間を決める */
export function adaptLimit(limitMs: number, fastRate: number): number {
  let next = limitMs;
  if (fastRate >= TIGHTEN_RATE) next = limitMs * 0.9;
  else if (fastRate < LOOSEN_RATE) next = limitMs * 1.15;
  next = Math.round(next / 50) * 50;
  return Math.min(MAX_LIMIT_MS, Math.max(MIN_LIMIT_MS, next));
}

/** 答えが出てこないときに打ち切るまでの時間 */
export function giveUpMs(limitMs: number): number {
  return Math.min(10_000, Math.max(3_000, limitMs * 3));
}
