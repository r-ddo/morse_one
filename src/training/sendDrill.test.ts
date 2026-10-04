import { describe, expect, it } from "vitest";
import { MorseDecoder } from "../audio/decoder";
import { toIntervals } from "../audio/player";
import { farnsworth } from "../audio/timing";
import { SendSession, sendGroups } from "./sendDrill";

const TIMING = farnsworth(20, 20);

/** 区間のとおりにキーを上げ下げし、10 ms ごとに時間を進めながら session に渡す */
function play(session: SendSession, decoder: MorseDecoder, intervals: [number, number][], until: number): void {
  const edges = intervals.flatMap(([on, off]) => [
    { t: on, down: true },
    { t: off, down: false },
  ]);
  let k = 0;
  let down = false;
  for (let now = 0; now <= until && session.phase !== "finished"; now += 0.01) {
    while (k < edges.length && edges[k].t <= now) {
      const e = edges[k++];
      down = e.down;
      session.handle(down ? decoder.keyDown(e.t) : decoder.keyUp(e.t), now);
    }
    session.handle(decoder.tick(now), now);
    session.tick(now, down);
  }
}

/** text を start 秒から送ったときの区間 */
function at(text: string, start: number): [number, number][] {
  return toIntervals(text, TIMING).map(([a, b]) => [a + start, b + start]);
}

describe("SendSession", () => {
  it("warms up, takes the prompt and finishes after silence", () => {
    const session = new SendSession(["ABCDE", "FGHIJ"]);
    const warmup = at("VVV", 0.2);
    const promptStart = warmup.at(-1)![1] + 1.5;
    const prompt = at("ABCDE FGHIJ", promptStart);
    play(session, new MorseDecoder(), [...warmup, ...prompt], prompt.at(-1)![1] + 5);
    expect(session.phase).toBe("finished");
    expect(session.chars.map((c) => c.char).join("")).toBe("ABCDEFGHIJ");
    expect(session.result.score.deduction).toBe(0);
    expect(session.position).toBe(10);
  });

  it("does not count warm-up characters", () => {
    const session = new SendSession(["ABCDE"]);
    play(session, new MorseDecoder(), at("VVV", 0.2), 4);
    expect(session.phase).toBe("ready");
    expect(session.chars).toHaveLength(0);
  });

  it("waits for V before getting ready", () => {
    const session = new SendSession(["ABCDE"]);
    play(session, new MorseDecoder(), at("EEE TTT", 0.2), 5);
    expect(session.phase).toBe("warmup");
  });

  it("stays in sending until the whole prompt is sent", () => {
    const session = new SendSession(["ABCDE", "FGHIJ"]);
    session.skipWarmup();
    play(session, new MorseDecoder(), at("ABCDE", 0.2), 10);
    expect(session.phase).toBe("sending");
    expect(session.position).toBe(5);
  });

  it("builds a record", () => {
    const session = new SendSession(["ABCDE"]);
    session.skipWarmup();
    play(session, new MorseDecoder(), at("ABXDE", 0.2), 10);
    const r = session.toRecord({ mode: "group", charset: "alnum", wpm: 20, ts: 1 });
    expect(r).toMatchObject({ ts: 1, target: "ABCDE", sent: ["A", "B", "X", "D", "E"], wrong: 1, points: 97 });
  });
});

describe("sendGroups", () => {
  it("makes groups without immediate repeats", () => {
    const groups = sendGroups(20, ["A", "B", "C"]);
    expect(groups).toHaveLength(20);
    const all = groups.join("");
    expect(all).toMatch(/^[ABC]{100}$/);
    for (let i = 1; i < all.length; i++) expect(all[i]).not.toBe(all[i - 1]);
  });
});
