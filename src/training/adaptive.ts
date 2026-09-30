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

/** 実効速度を見直す間隔（グループ数） */
export const EWPM_WINDOW = 3;
/** 正答率がこれ以上なら実効速度を上げる（文字間を詰める） */
export const SPEED_UP_ACC = 0.9;
/** 正答率がこれ未満なら実効速度を下げる（文字間を広げる） */
export const SLOW_DOWN_ACC = 0.8;
export const MIN_EWPM = 2;

/** 直近 EWPM_WINDOW グループの正答率から次の実効速度を決める。文字速度を超えない */
export function adaptEwpm(ewpm: number, accuracy: number, cwpm: number): number {
  let next = ewpm;
  if (accuracy >= SPEED_UP_ACC) next = ewpm * 1.1;
  else if (accuracy < SLOW_DOWN_ACC) next = ewpm / 1.1;
  next = Math.round(next * 2) / 2;
  if (next === ewpm && accuracy >= SPEED_UP_ACC) next += 0.5;
  if (next === ewpm && accuracy < SLOW_DOWN_ACC) next -= 0.5;
  return Math.min(cwpm, Math.max(MIN_EWPM, next));
}

export const MIN_CPM = 10;
export const MAX_CPM = 150;

/**
 * 遅れ受信の速度（字/分）を 1 セッションごとに見直す。
 * 正答率 90% 以上で、かつ許容した遅れを超えなかったら約 1.1 倍、80% 未満なら約 1/1.1 倍
 */
export function adaptCpm(cpm: number, accuracy: number, lagKept: boolean): number {
  let next = cpm;
  if (accuracy >= SPEED_UP_ACC && lagKept) next = Math.max(cpm + 1, Math.round(cpm * 1.1));
  else if (accuracy < SLOW_DOWN_ACC) next = Math.min(cpm - 1, Math.round(cpm / 1.1));
  return Math.min(MAX_CPM, Math.max(MIN_CPM, next));
}
