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
