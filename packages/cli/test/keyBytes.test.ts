import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import { AFTER, keyBytes } from "../src/runtime/keyBytes";
// covers: headless.storage

/** fake-indexeddb's own order of keys is the oracle: the bytes must sort as it does, for any keys. */
const cmp = (a: unknown, b: unknown) => new IDBFactory().cmp(a, b);

let seed = 7;
const random = (below: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % below; };
const NUMBERS = [0, -0, 1, -1, 0.5, -0.5, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE, 1e21, 1_790_000_000_000, 2 ** 53, -(2 ** 53)];
const STRINGS = ["", "a", "ab", "b", "\u0000", "\u0000a", "\u007d", "\u007e", "\u007f", "}~", "\u0080", "\uffff", "\ud83d\ude00", "\ud800", "\u00e9", "z\u0000", "peer_1", "me_10"];
function key(depth = 0): unknown {
  switch (random(depth > 2 ? 4 : 5)) {
    case 0: return random(3) ? NUMBERS[random(NUMBERS.length)] : (random(2000) - 1000) / (1 + random(7));
    case 1: return new Date(NUMBERS[random(4) + 2]! * 1000 + random(1000));
    case 2: return random(2) ? STRINGS[random(STRINGS.length)] : Array.from({ length: random(4) }, () => STRINGS[random(STRINGS.length)]).join("");
    case 3: return new Uint8Array(Array.from({ length: random(4) }, () => [0, 1, 15, 16, 255][random(5)]!)).buffer;
    default: return Array.from({ length: random(4) }, () => key(depth + 1));
  }
}
const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);

it("orders the bytes of any two keys as IndexedDB orders the keys", () => {
  for (let i = 0; i < 20_000; i++) {
    const a = key(), b = key();
    const x = keyBytes(a), y = keyBytes(b);
    expect(sign(x < y ? -1 : x > y ? 1 : 0), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`).toBe(sign(cmp(a, b)));
  }
});

it("makes no key's bytes the start of another's, so a key then a record key sorts as the pair, and AFTER ends a key's pairs", () => {
  for (let i = 0; i < 5_000; i++) {
    const a = key(), b = key();
    const x = keyBytes(a), y = keyBytes(b);
    if (x !== y) expect(y.startsWith(x), `${JSON.stringify(a)} starts ${JSON.stringify(b)}`).toBe(false);
    const p = keyBytes(key());
    // Every pair of a key lies before the key followed by AFTER, and after the key itself.
    expect(x + p > x && x + p < x + AFTER).toBe(true);
  }
  // IndexedDB holds -0 and 0 as one key.
  expect(keyBytes(-0)).toBe(keyBytes(0));
  expect(() => keyBytes({})).toThrow(/Not an IndexedDB key/);
});
