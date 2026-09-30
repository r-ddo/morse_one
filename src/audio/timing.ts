export interface Timing {
  /** 短点の長さ（秒） */
  dot: number;
  /** 文字間の長さ（秒） */
  charGap: number;
  /** 語間（グループ間）の長さ（秒） */
  wordGap: number;
}

/**
 * Farnsworth（ARRL）方式のタイミング。
 * 文字速度 cwpm で符号を送り、文字間・語間を伸ばして実効速度 ewpm にする。
 */
export function farnsworth(cwpm: number, ewpm: number): Timing {
  const dot = 1.2 / cwpm;
  if (ewpm >= cwpm) {
    return { dot, charGap: 3 * dot, wordGap: 7 * dot };
  }
  const ta = (60 * cwpm - 37.2 * ewpm) / (cwpm * ewpm);
  return { dot, charGap: (3 * ta) / 19, wordGap: (7 * ta) / 19 };
}

/** 字数に数える符号 1 個の平均の長さ（短点単位。符号内の間を含み、文字間は含まない） */
export function averageCodeUnits(codes: readonly string[]): number {
  const units = codes.map((code) => {
    let u = code.length - 1;
    for (const x of code) u += x === "-" ? 3 : 1;
    return u;
  });
  return units.reduce((a, b) => a + b, 0) / units.length;
}

/** 5 字 1 組で送ったときの 1 分間あたりの字数 */
export function charsPerMinute(timing: Timing, avgUnits: number, groupLen = 5): number {
  const groupSec = groupLen * avgUnits * timing.dot + (groupLen - 1) * timing.charGap + timing.wordGap;
  return (60 * groupLen) / groupSec;
}

/**
 * 1 分間 charsPerMin 字（5 字 1 組）になるタイミング。
 * 符号は文字速度 cwpm で送り、文字間・語間を標準の比率（3:7）のまま伸縮する。
 * 文字速度が足りず届かない場合は標準間隔（それ以上は速くならない）。
 */
export function timingForCharRate(cwpm: number, charsPerMin: number, avgUnits: number, groupLen = 5): Timing {
  const dot = 1.2 / cwpm;
  const groupSec = (60 * groupLen) / charsPerMin;
  // groupSec = groupLen·avgUnits·dot + (groupLen − 1)·g + (7/3)·g
  const g = (groupSec - groupLen * avgUnits * dot) / (groupLen - 1 + 7 / 3);
  const charGap = Math.max(g, 3 * dot);
  return { dot, charGap, wordGap: (7 / 3) * charGap };
}

/** 文字速度 cwpm・標準間隔で出せる最大の字数（字/分、5 字 1 組） */
export function maxCharsPerMinute(cwpm: number, avgUnits: number, groupLen = 5): number {
  return charsPerMinute(farnsworth(cwpm, cwpm), avgUnits, groupLen);
}
