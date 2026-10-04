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

/** 対応付けの 1 手。t は問題の位置、s は入力の位置（null はそちら側に対応がない） */
export interface AlignStep {
  t: number | null;
  s: number | null;
}

export interface AlignCost {
  /** 問題 t に入力 s を対応付ける */
  pair(t: number, s: number): number;
  /** 問題 t に対応する入力がない */
  skipTarget(t: number): number;
  /** 入力 s に対応する問題がない */
  skipInput(s: number): number;
}

/** 費用の合計が最小になるように、長さ n の問題と長さ m の入力を先頭から対応付ける */
export function align(n: number, m: number, cost: AlignCost): AlignStep[] {
  // dp[i][j]: 問題 [0, i) と入力 [0, j) の最小費用
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) dp[i][0] = dp[i - 1][0] + cost.skipTarget(i - 1);
  for (let j = 1; j <= m; j++) dp[0][j] = dp[0][j - 1] + cost.skipInput(j - 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j - 1] + cost.pair(i - 1, j - 1),
        dp[i - 1][j] + cost.skipTarget(i - 1),
        dp[i][j - 1] + cost.skipInput(j - 1),
      );
    }
  }
  const steps: AlignStep[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + cost.pair(i - 1, j - 1)) {
      steps.push({ t: --i, s: --j });
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + cost.skipTarget(i - 1)) {
      steps.push({ t: --i, s: null });
    } else {
      steps.push({ t: null, s: --j });
    }
  }
  return steps.reverse();
}

/**
 * 入力を問題文に対応付けて採点する。減点が最小になる対応付けを選ぶ
 * （1 字抜かしてもそれ以降がすべて誤字にならないようにするため）。
 * unknown は「聞き取れなかった」印で、脱字として扱う。
 */
export function scoreExam(target: string, typed: string, unknown = "_"): ExamScore {
  const sub = (t: string, c: string) => (c === t ? 0 : c === unknown ? PENALTY.missing : PENALTY.wrong);
  const steps = align(target.length, typed.length, {
    pair: (i, j) => sub(target[i], typed[j]),
    skipTarget: () => PENALTY.missing,
    skipInput: (j) => (typed[j] === unknown ? 0 : PENALTY.extra),
  });

  const marks: CharMark[] = new Array(target.length);
  const typedAt: (string | null)[] = new Array(target.length).fill(null);
  let wrong = 0;
  let missing = 0;
  let extra = 0;
  for (const { t, s } of steps) {
    if (t === null) {
      if (typed[s!] !== unknown) extra++;
    } else if (s === null) {
      marks[t] = "missing";
      missing++;
    } else {
      const c = typed[s];
      if (c === target[t]) marks[t] = "ok";
      else if (c === unknown) (marks[t] = "missing"), missing++;
      else (marks[t] = "wrong"), wrong++;
      typedAt[t] = c === unknown ? null : c;
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
