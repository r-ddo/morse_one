import { describe, expect, it } from "vitest";
import type { DecodeEvent } from "../audio/decoder";
import { SendSingleDrill, sendSingleStats, type SendSingleResult } from "./sendSingle";
import type { CharStat } from "./stats";

/** start 秒に送り始めた文字 */
function sent(char: string | null, start: number, code = "?"): DecodeEvent {
  return { type: "char", char, code, start, end: start + 0.3, marks: [], gaps: [], dot: 0.1, bias: 0 };
}

function drill(chars: string[], questions = 3, limitMs = 1500) {
  const results: SendSingleResult[] = [];
  const d = new SendSingleDrill({
    chars,
    stats: new Map<string, CharStat>(),
    limitMs,
    questions,
    random: () => 0.99,
    onResult: (r) => results.push(r),
  });
  return { d, results };
}

describe("SendSingleDrill", () => {
  it("目標時間内に送り始めて正しければ fast とし、少し待って次の問題を出す", () => {
    const { d, results } = drill(["A", "B"]);
    d.start(10);
    const first = d.target;
    d.handle([sent(first, 10.8)], 11.2);
    expect(results).toEqual([{ target: first, sent: first, verdict: "fast", rtMs: 800, limitMs: 1500 }]);
    expect(d.phase).toBe("correct");
    expect(d.tick(11.3, false)).toBe(false);
    expect(d.tick(11.6, false)).toBe(true);
    expect(d.phase).toBe("question");
    expect(d.target).not.toBe(first);
  });

  it("目標時間を過ぎても送り始めなければ符号を表示し、そのあと送ったら hinted", () => {
    const { d, results } = drill(["A", "B"]);
    d.start(0);
    expect(d.tick(1.4, false)).toBe(false);
    expect(d.tick(1.6, false)).toBe(true);
    expect(d.showCode).toBe(true);
    d.handle([sent(d.target, 2)], 2.3);
    expect(results[0].verdict).toBe("hinted");
    expect(results[0].rtMs).toBeNull();
  });

  it("送っている途中なら、目標時間を過ぎても符号を表示しない", () => {
    const { d } = drill(["A", "B"]);
    d.start(0);
    d.tick(1.6, true);
    expect(d.showCode).toBe(false);
  });

  it("違う符号を送ったら符号を表示し、正しく送るまで次へ進まない。成績は最初の 1 回で付ける", () => {
    const { d, results } = drill(["A", "B"]);
    d.start(0);
    const target = d.target;
    const wrong = target === "A" ? "B" : "A";
    d.handle([sent(wrong, 0.5)], 0.8);
    expect(d.phase).toBe("retry");
    expect(d.showCode).toBe(true);
    expect(d.lastSent).toBe(wrong);
    d.handle([sent(null, 1.2, "-.-.-.")], 1.5);
    expect(d.phase).toBe("retry");
    d.handle([sent(target, 2)], 2.3);
    expect(d.phase).toBe("correct");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ target, sent: wrong, verdict: "wrong" });
    // 誤りのあとは少し長く待つ
    expect(d.tick(2.8, false)).toBe(false);
    expect(d.tick(3.3, false)).toBe(true);
  });

  it("符号を表示したあと無音が続いたら打ち切る", () => {
    const { d, results } = drill(["A", "B"]);
    d.start(0);
    d.tick(1.6, false);
    d.tick(9, false);
    expect(d.phase).toBe("question");
    d.tick(9.7, false);
    expect(results[0]).toMatchObject({ verdict: "timeout", sent: null });
  });

  it("問題を出す前に送り始めていた文字は数えない", () => {
    const { d, results } = drill(["A", "B"]);
    d.start(5);
    d.handle([sent(d.target, 4.9)], 5.2);
    expect(results).toHaveLength(0);
  });

  it("誤った文字は数問あとに復習として出し直す", () => {
    const { d } = drill(["A", "B", "C", "D", "E"], 10);
    d.start(0);
    const missed = d.target;
    let t = 0;
    const answer = (char: string) => {
      t += 1;
      d.handle([sent(char, t)], t + 0.3);
      t += 2;
      d.tick(t, false);
    };
    answer(missed === "E" ? "A" : "E");
    d.handle([sent(missed, t)], t + 0.3);
    t += 2;
    d.tick(t, false);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push(d.target);
      answer(d.target);
    }
    expect(seen).toContain(missed);
  });

  it("問題数に達したら終わる", () => {
    const { d } = drill(["A", "B"], 2);
    d.start(0);
    d.handle([sent(d.target, 0.5)], 0.8);
    d.tick(2, false);
    d.handle([sent(d.target, 2.5)], 2.8);
    d.tick(4, false);
    expect(d.phase).toBe("finished");
  });
});

describe("sendSingleStats", () => {
  it("記録を古い順に積み上げて文字ごとの成績を作る", () => {
    const stats = sendSingleStats([
      { ts: 2, target: "A", verdict: "wrong", rtMs: null },
      { ts: 1, target: "A", verdict: "fast", rtMs: 700 },
    ]);
    const a = stats.get("A")!;
    expect(a.attempts).toBe(2);
    expect(a.correct).toBe(1);
    expect(a.rtEma).toBe(700);
    expect(a.lastSeen).toBe(2);
  });
});
