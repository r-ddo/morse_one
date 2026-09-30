/** 文字ごとの成績 */
export interface CharStat {
  char: string;
  attempts: number;
  correct: number;
  /** 正答率の指数移動平均（0〜1） */
  accEma: number;
  /** 正答時の反応時間の指数移動平均（ミリ秒）。正答がまだなければ null */
  rtEma: number | null;
  /** 最終出題日時（epoch ミリ秒） */
  lastSeen: number;
}

export interface Outcome {
  correct: boolean;
  /** 反応時間（ミリ秒）。時間切れなら null */
  rtMs: number | null;
  ts: number;
}

/** 直近の結果をどれだけ重視するか */
const ALPHA = 0.2;

/** 苦手度の重み（誤答率・遅さ・久しぶり度） */
export const WEIGHTS = { error: 1.0, slow: 0.5, stale: 0.2 };

/** 未出題の文字の苦手度 */
export const UNSEEN_WEAKNESS = 1.5;

export function newStat(char: string): CharStat {
  return { char, attempts: 0, correct: 0, accEma: 0, rtEma: null, lastSeen: 0 };
}

export function updateStat(s: CharStat, o: Outcome): CharStat {
  const hit = o.correct ? 1 : 0;
  const first = s.attempts === 0;
  const rtEma =
    o.correct && o.rtMs !== null
      ? s.rtEma === null
        ? o.rtMs
        : s.rtEma + ALPHA * (o.rtMs - s.rtEma)
      : s.rtEma;
  return {
    char: s.char,
    attempts: s.attempts + 1,
    correct: s.correct + hit,
    accEma: first ? hit : s.accEma + ALPHA * (hit - s.accEma),
    rtEma,
    lastSeen: o.ts,
  };
}

/** 苦手度。大きいほど苦手 */
export function weakness(s: CharStat | undefined, limitMs: number, now: number): number {
  if (!s || s.attempts === 0) return UNSEEN_WEAKNESS;
  const error = 1 - s.accEma;
  const slow = s.rtEma === null ? 1 : Math.min(s.rtEma / limitMs, 1.5);
  const days = (now - s.lastSeen) / 86_400_000;
  const stale = Math.min(Math.max(days, 0) / 7, 1);
  return WEIGHTS.error * error + WEIGHTS.slow * slow + WEIGHTS.stale * stale;
}
