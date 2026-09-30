/**
 * 電気通信術（モールス受信）の採点基準に沿った採点。
 * 誤字・冗字は 1 字 3 点、脱字は 1 字 1 点の減点。100 点から減点し、0 点未満にはしない。
 */
export const PENALTY = { wrong: 3, missing: 1, extra: 3 } as const;

export type CharMark = "ok" | "wrong" | "missing";

export interface ExamScore {
  /** 問題の各文字の判定 */
  marks: CharMark[];
  /** 問題の各文字に対応する入力（脱字なら null） */
  typedAt: (string | null)[];
  wrong: number;
  missing: number;
  extra: number;
  deduction: number;
}

/**
 * 入力を問題文に対応付けて採点する。減点が最小になる対応付けを選ぶ
 * （1 字抜かしてもそれ以降がすべて誤字にならないようにするため）。
 * unknown は「聞き取れなかった」印で、脱字として扱う。
 */
export function scoreExam(target: string, typed: string, unknown = "_"): ExamScore {
  const n = target.length;
  const m = typed.length;
  // dp[i][j]: target[0..i) と typed[0..j) の最小減点
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const extraCost = (c: string) => (c === unknown ? 0 : PENALTY.extra);
  for (let i = 1; i <= n; i++) dp[i][0] = dp[i - 1][0] + PENALTY.missing;
  for (let j = 1; j <= m; j++) dp[0][j] = dp[0][j - 1] + extraCost(typed[j - 1]);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const t = target[i - 1];
      const c = typed[j - 1];
      const sub = c === t ? 0 : c === unknown ? PENALTY.missing : PENALTY.wrong;
      dp[i][j] = Math.min(
        dp[i - 1][j - 1] + sub,
        dp[i - 1][j] + PENALTY.missing,
        dp[i][j - 1] + extraCost(c),
      );
    }
  }

  const marks: CharMark[] = new Array(n);
  const typedAt: (string | null)[] = new Array(n).fill(null);
  let wrong = 0;
  let missing = 0;
  let extra = 0;
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const t = target[i - 1];
      const c = typed[j - 1];
      const sub = c === t ? 0 : c === unknown ? PENALTY.missing : PENALTY.wrong;
      if (dp[i][j] === dp[i - 1][j - 1] + sub) {
        if (c === t) marks[i - 1] = "ok";
        else if (c === unknown) (marks[i - 1] = "missing"), missing++;
        else (marks[i - 1] = "wrong"), wrong++;
        typedAt[i - 1] = c === unknown ? null : c;
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && dp[i][j] === dp[i - 1][j] + PENALTY.missing) {
      marks[i - 1] = "missing";
      missing++;
      i--;
    } else {
      if (typed[j - 1] !== unknown) extra++;
      j--;
    }
  }
  return {
    marks,
    typedAt,
    wrong,
    missing,
    extra,
    deduction: wrong * PENALTY.wrong + missing * PENALTY.missing + extra * PENALTY.extra,
  };
}

/** 減点から得点（100 点満点）を出す。scaleTo を渡すとその字数に換算する */
export function examPoints(deduction: number, chars: number, scaleTo = chars): number {
  const scaled = chars > 0 ? (deduction * scaleTo) / chars : 0;
  return Math.max(0, Math.round(100 - scaled));
}

/** 紙に書き取った結果を自己採点する（品位の減点は含めない）。抹消・訂正は 3 字までごとに 1 点 */
export function selfScore(wrong: number, missing: number, extra: number, corrections: number): number {
  const deduction =
    wrong * PENALTY.wrong + missing * PENALTY.missing + extra * PENALTY.extra + Math.ceil(corrections / 3);
  return Math.max(0, 100 - deduction);
}
