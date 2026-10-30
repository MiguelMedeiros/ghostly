import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelayTransport } from "../src/relay";

// covers: core.relay-client

/**
 * Each read that takes turns dropped the stale turns by walking every key's: with 200 chats that was 12-14% of an idle
 * web app's script, the reads of all chats costing in proportion to the square of the chats. The walk is at most once a
 * second now; a key's own turn over a minute old still starts a new one when it asks again.
 */

const NOW = 1_800_000_000_000;
type Turn = { servedAt: number; askedAt: number; waiting: boolean };
type Asker = Record<"background" | "group" | "urgent" | "door" | "write" | "signal" | "watch" | "watchWrite" | "departed" | "resume" | "back", boolean>;
type Inside = {
  keyTurns: Map<string, Turn>;
  readTurns: Map<string, Turn>;
  turnAsked(key: string, who: Asker, now: number): void;
  readAsked(key: string, who: Asker, now: number): void;
};

const asker = (over: Partial<Asker> = {}): Asker => ({
  background: true, group: false, urgent: false, door: false, write: false, signal: false, watch: false, watchWrite: false, departed: false, resume: false, back: false, ...over,
});

/** Counts the turns a walk of `turns` visits. */
function counted(turns: Map<string, Turn>): { visited: () => number } {
  let visited = 0;
  const walk = turns[Symbol.iterator].bind(turns);
  (turns as { [Symbol.iterator]: () => Iterator<[string, Turn]> })[Symbol.iterator] = function* () { for (const entry of walk()) { visited++; yield entry; } };
  return { visited: () => visited };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => void vi.useRealTimers());

describe("relay transport: the keys' turns are pruned at most once a second", () => {
  const ask = [
    { name: "a read in turn", map: "keyTurns", call: "turnAsked", who: asker() },
    { name: "a group's read", map: "readTurns", call: "readAsked", who: asker({ background: false, group: true }) },
  ] as const;

  for (const { name, map, call, who } of ask) {
    it(`does not walk every key's turn on each ask of ${name}`, () => {
      const inside = new RelayTransport({ relays: ["https://a.test"], log: () => {} }) as unknown as Inside;
      const walks = counted(inside[map]);
      const KEYS = 2_000;
      for (let i = 0; i < KEYS; i++) inside[call](`key${i}`, who, NOW + i / 10);
      // Within 200 ms the 2,000 asks walked the turns once: before, each did, 2 million turns in all.
      expect(inside[map].size).toBe(KEYS);
      expect(walks.visited()).toBeLessThanOrEqual(KEYS);
    });

    it(`still drops ${name}'s turns over a minute old, and one asking again starts a new turn`, () => {
      const inside = new RelayTransport({ relays: ["https://a.test"], log: () => {} }) as unknown as Inside;
      for (const key of ["old", "again"]) {
        inside[call](key, who, NOW);
        inside[map].get(key)!.servedAt = NOW;
      }
      inside[call]("kept", who, NOW + 30_000);
      inside[call]("walked", who, NOW + 59_800);
      // Within a second of the last walk: the stale turns stay, but one asking again starts anew, as if it was dropped.
      inside[call]("again", who, NOW + 60_200);
      expect(inside[map].get("again")!.servedAt).toBe(-Infinity);
      expect(inside[map].has("old")).toBe(true);
      // A second after the last walk, the next one drops it.
      inside[call]("other", who, NOW + 60_700);
      expect(inside[map].has("old")).toBe(true);
      inside[call]("other", who, NOW + 61_000);
      expect(inside[map].has("old")).toBe(false);
      expect(inside[map].has("kept")).toBe(true);
    });
  }
});
