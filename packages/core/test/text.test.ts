import { describe, expect, it } from "vitest";
import {
  MAX_NICK_LENGTH,
  buildLinkRecords,
  createIdentity,
  decodeControl,
  decodeServices,
  encodeControl,
  generateEncryptionKey,
  parseLinkRecords,
  sanitizeDisplayText,
} from "../src";

/** Right-to-left override: everything after it renders backwards. */
const RLO = "\u202e";
/** First strong isolate, the modern way to do the same thing. */
const FSI = "\u2068";
const ZERO_WIDTH_SPACE = "\u200b";
const BYTE_ORDER_MARK = "\ufeff";

describe("display text from a peer", () => {
  it("removes what reorders or hides text", () => {
    expect(sanitizeDisplayText(`Alice${RLO}ecilA`, 64)).toBe("AliceecilA");
    expect(sanitizeDisplayText(`${FSI}Bob`, 64)).toBe("Bob");
    expect(sanitizeDisplayText(`Al${ZERO_WIDTH_SPACE}ice${BYTE_ORDER_MARK}`, 64)).toBe("Alice");
    expect(sanitizeDisplayText("two\nlines\u0007", 64)).toBe("twolines");
    expect(sanitizeDisplayText(`${RLO}${ZERO_WIDTH_SPACE}  `, 64)).toBeUndefined();
  });

  it("keeps emoji and the joiners scripts need", () => {
    expect(sanitizeDisplayText("👩\u200d👩\u200d👧 family", 64)).toBe("👩\u200d👩\u200d👧 family");
    expect(sanitizeDisplayText("زنجیر\u200cها", 64)).toBe("زنجیر\u200cها");
  });

  it("counts characters, not code units, so no emoji is cut in half", () => {
    expect(sanitizeDisplayText("👻".repeat(80), MAX_NICK_LENGTH)).toBe("👻".repeat(MAX_NICK_LENGTH));
  });
});

describe("a nickname from a peer", () => {
  const id = createIdentity();
  const key = generateEncryptionKey();

  it("is cut and stripped when it arrives in a record", () => {
    const built = buildLinkRecords(
      id.pubKeyZ32,
      { messages: [{ t: 1, m: "hi" }], ackTimestamp: 0, nick: `${RLO}Casper${ZERO_WIDTH_SPACE}` },
      key,
    );
    const link = parseLinkRecords(
      { pubKeyZ32: id.pubKeyZ32, timestampMicros: 5_000_000n, records: built.records },
      key,
    );
    expect(link.nick).toBe("Casper");
    expect(link.messages[0].nick).toBe("Casper");
  });

  it("is cut and stripped when it arrives in a hello frame", () => {
    const hello = encodeControl({ t: "hello", v: 1, svc: undefined, nick: `${RLO}${"n".repeat(200)}` });
    const frame = decodeControl(hello);
    expect(frame).toMatchObject({ t: "hello", nick: "n".repeat(MAX_NICK_LENGTH) });
  });

  it("has a nickname of nothing but hidden characters dropped", () => {
    const hello = encodeControl({ t: "hello", v: 1, svc: undefined, nick: `${RLO}${BYTE_ORDER_MARK}` });
    expect(decodeControl(hello)).toMatchObject({ t: "hello", nick: undefined });
  });
});

describe("a service name from a peer", () => {
  it("cannot read as another service's", () => {
    const wire = JSON.stringify({
      v: 1,
      s: [{ i: "atlas", t: "http", n: `Atlas${RLO}sltA`, m: { room: `1${ZERO_WIDTH_SPACE}2` } }],
    });
    expect(decodeServices(wire)).toEqual([
      { id: "atlas", type: "http", name: "AtlassltA", meta: { room: "12" } },
    ]);
  });

  it("still drops control characters, as it always did", () => {
    expect(decodeServices(JSON.stringify({ v: 1, s: [{ i: "ok", t: "http", n: "a\nb" }] }))).toEqual([
      { id: "ok", type: "http", name: "ab" },
    ]);
  });
});
