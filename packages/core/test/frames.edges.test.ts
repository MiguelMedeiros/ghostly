import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  CHUNK_FLAG_END,
  CHUNK_KIND,
  LIMITS,
  MAX_CHUNK_PAYLOAD_BYTES,
  decodeChunk,
  decodeControl,
  encodeChunk,
  encodeControl,
  sendBody,
  wrapDataChannel,
  type ChunkFrame,
  type ControlFrame,
  type FrameChannel,
} from "../src/frames";

const KNOWN_KINDS = new Set(["hello", "m", "call", "svc", "req", "res", "file", "pay-req", "pay", "pay-ask", "pay-res", "rst", "ping", "pong"]);
const decode = (value: unknown) => decodeControl(JSON.stringify(value));
/** Pads a `svc` frame so its JSON is exactly `bytes` long. */
const svcFrameOf = (bytes: number) => {
  const overhead = JSON.stringify({ t: "svc", svc: "" }).length;
  return { t: "svc" as const, svc: "x".repeat(bytes - overhead) };
};

describe("control frame size limit", () => {
  it("encodes a frame of exactly the limit and refuses one byte more", () => {
    expect(encodeControl(svcFrameOf(LIMITS.maxControlFrameBytes))).toHaveLength(LIMITS.maxControlFrameBytes);
    expect(() => encodeControl(svcFrameOf(LIMITS.maxControlFrameBytes + 1))).toThrow("Control frame too large");
  });

  it("counts UTF-8 bytes, not characters, when encoding", () => {
    // 3 bytes per character: well under the limit in characters, over it in bytes.
    const frame = { t: "svc" as const, svc: "€".repeat(LIMITS.maxControlFrameBytes / 2) };
    expect(JSON.stringify(frame).length).toBeLessThan(LIMITS.maxControlFrameBytes);
    expect(() => encodeControl(frame)).toThrow("Control frame too large");
  });

  it("decodes a frame of exactly the limit and drops one over it", () => {
    expect(decodeControl(JSON.stringify(svcFrameOf(LIMITS.maxControlFrameBytes)))).toMatchObject({ t: "svc" });
    expect(decodeControl(JSON.stringify(svcFrameOf(LIMITS.maxControlFrameBytes + 1)))).toBeNull();
  });
});

describe("decodeControl refuses what is not a known frame", () => {
  it.each(["", "{", "not json", "null", "0", "true", '"hello"', "[]", "{}", '{"t":1}', '{"t":"nope"}', '{"t":"HELLO","v":1}'])(
    "drops %j",
    (text) => expect(decodeControl(text)).toBeNull(),
  );

  it("takes the last value of a duplicated key, as JSON.parse does, and still validates it", () => {
    expect(decodeControl('{"t":"m","t":"ping","ts":1}')).toEqual({ t: "ping", ts: 1 });
    expect(decodeControl('{"t":"ping","ts":1,"ts":"1"}')).toBeNull();
  });

  it("copies only known fields, so a peer cannot smuggle extra ones through", () => {
    const req = decode({ t: "req", id: 1, s: "a", m: "GET", p: "/", h: [], b: false, url: "http://evil.example", target: "x" });
    expect(req).toEqual({ t: "req", id: 1, s: "a", m: "GET", p: "/", h: [], b: false });
    const file = decode({ t: "file", id: 1, f: "abcdefgh", ts: 1, n: "a", s: 1, m: "text/plain", path: "/etc/passwd" });
    expect(Object.keys(file!).sort()).toEqual(["f", "id", "m", "n", "s", "t", "ts"]);
  });

  it("does not pollute prototypes through a __proto__ key", () => {
    decodeControl('{"t":"svc","svc":{"__proto__":{"polluted":true}},"__proto__":{"polluted":true}}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("hello, chat, call, svc and ping frames", () => {
  it("requires a numeric version on hello and passes the service list through untouched", () => {
    expect(decode({ t: "hello" })).toBeNull();
    expect(decode({ t: "hello", v: "1" })).toBeNull();
    const svc = [{ id: "a" }];
    expect(decode({ t: "hello", v: 1, svc })).toEqual({ t: "hello", v: 1, svc, nick: undefined });
    expect(decode({ t: "hello", v: 1, nick: 42 })).toMatchObject({ nick: undefined });
  });

  it("bounds chat text at the chat limit and requires a numeric timestamp", () => {
    const max = "a".repeat(LIMITS.maxChatMessageBytes);
    expect(decode({ t: "m", ts: 1, m: max })).toEqual({ t: "m", ts: 1, m: max });
    expect(decode({ t: "m", ts: 1, m: `${max}a` })).toBeNull();
    expect(decode({ t: "m", ts: "1", m: "hi" })).toBeNull();
    expect(decode({ t: "m", ts: 1, m: 5 })).toBeNull();
    expect(decode({ t: "m", ts: 1 })).toBeNull();
  });

  it("bounds a call signal and requires it to be text", () => {
    expect(decode({ t: "call", s: "x".repeat(LIMITS.maxChatMessageBytes) })).toMatchObject({ t: "call" });
    expect(decode({ t: "call", s: "x".repeat(LIMITS.maxChatMessageBytes + 1) })).toBeNull();
    expect(decode({ t: "call", s: {} })).toBeNull();
  });

  it("accepts a svc frame with any service list, validated later by the services decoder", () => {
    expect(decode({ t: "svc" })).toEqual({ t: "svc", svc: undefined });
    expect(decode({ t: "svc", svc: [1, 2] })).toEqual({ t: "svc", svc: [1, 2] });
  });

  it("requires a numeric timestamp on ping and pong", () => {
    expect(decode({ t: "ping", ts: 5 })).toEqual({ t: "ping", ts: 5 });
    expect(decode({ t: "pong", ts: 6 })).toEqual({ t: "pong", ts: 6 });
    expect(decode({ t: "ping" })).toBeNull();
    expect(decode({ t: "pong", ts: null })).toBeNull();
  });
});

describe("http request and response frames", () => {
  const req = { t: "req", id: 1, s: "atlas", m: "GET", p: "/", h: [] as [string, string][], b: false };

  it("accepts stream ids from 0 to 2^32-1 and nothing else", () => {
    expect(decode({ ...req, id: 0 })).toMatchObject({ id: 0 });
    expect(decode({ ...req, id: 0xffffffff })).toMatchObject({ id: 0xffffffff });
    for (const id of [-1, 0x100000000, 1.5, "1", null, undefined]) expect(decode({ ...req, id })).toBeNull();
  });

  it("requires text service, method and path, and bounds the path", () => {
    expect(decode({ ...req, s: 1 })).toBeNull();
    expect(decode({ ...req, m: null })).toBeNull();
    expect(decode({ ...req, p: 7 })).toBeNull();
    expect(decode({ ...req, p: "/".padEnd(LIMITS.maxPathBytes, "a") })).toMatchObject({ t: "req" });
    expect(decode({ ...req, p: "/".padEnd(LIMITS.maxPathBytes + 1, "a") })).toBeNull();
  });

  it("bounds the header count, header name and header value", () => {
    const headers = (n: number) => Array.from({ length: n }, (_, i) => [`h${i}`, "v"]);
    expect(decode({ ...req, h: headers(LIMITS.maxHeaderCount) })).toMatchObject({ t: "req" });
    expect(decode({ ...req, h: headers(LIMITS.maxHeaderCount + 1) })).toBeNull();
    expect(decode({ ...req, h: [["n".repeat(256), "v"]] })).toMatchObject({ t: "req" });
    expect(decode({ ...req, h: [["n".repeat(257), "v"]] })).toBeNull();
    expect(decode({ ...req, h: [["n", "v".repeat(LIMITS.maxHeaderValueBytes)]] })).toMatchObject({ t: "req" });
    expect(decode({ ...req, h: [["n", "v".repeat(LIMITS.maxHeaderValueBytes + 1)]] })).toBeNull();
  });

  it("refuses header lists of the wrong shape", () => {
    for (const h of [undefined, {}, "a: b", [["a"]], [["a", "b", "c"]], [["a", 1]], [[1, "a"]], ["ab"]]) {
      expect(decode({ ...req, h })).toBeNull();
    }
  });

  it("treats only a literal true as announcing a body", () => {
    expect(decode({ ...req, b: true })).toMatchObject({ b: true });
    for (const b of ["true", 1, "yes", undefined]) expect(decode({ ...req, b })).toMatchObject({ b: false });
  });

  it("accepts status codes 100 to 599 as integers only", () => {
    const res = { t: "res", id: 2, h: [], b: true };
    expect(decode({ ...res, st: 100 })).toEqual({ ...res, st: 100 });
    expect(decode({ ...res, st: 599 })).toMatchObject({ st: 599 });
    for (const st of [99, 600, 200.5, "200", undefined]) expect(decode({ ...res, st })).toBeNull();
    expect(decode({ ...res, st: 200, id: -1 })).toBeNull();
    expect(decode({ ...res, st: 200, h: [["a"]] })).toBeNull();
  });
});

describe("file frames", () => {
  const file = { t: "file", id: 3, f: "abcdefgh", ts: 1, n: "a.txt", s: 10, m: "text/plain" };

  it("accepts a well formed announcement", () => {
    expect(decode(file)).toEqual(file);
    expect(decode({ ...file, s: 0 })).toMatchObject({ s: 0 });
    expect(decode({ ...file, s: Number.MAX_SAFE_INTEGER })).toMatchObject({ s: Number.MAX_SAFE_INTEGER });
  });

  it("refuses sizes that are negative, fractional or beyond safe integers", () => {
    for (const s of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 1e300, "10", null]) expect(decode({ ...file, s })).toBeNull();
  });

  it("refuses missing or mistyped fields", () => {
    for (const patch of [{ id: -1 }, { f: 1 }, { ts: "1" }, { n: null }, { m: 5 }]) expect(decode({ ...file, ...patch })).toBeNull();
  });
});

describe("payment frames", () => {
  const id = "abcd1234";
  const payReq = { t: "pay-req", id, ts: 1, v: "21", u: "sat", e: [["btc-lightning-bolt11", "lnbc1"]] };
  const pay = { t: "pay", id, ts: 1, v: "21", u: "sat", e: ["cashu", "cashuA..."] };

  it("accepts payment ids of 8 to 64 url-safe characters only", () => {
    expect(decode({ ...payReq, id: "a".repeat(8) })).toMatchObject({ t: "pay-req" });
    expect(decode({ ...payReq, id: "a".repeat(64) })).toMatchObject({ t: "pay-req" });
    for (const bad of ["a".repeat(7), "a".repeat(65), "abcd 1234", "abcd.1234", 12345678]) {
      expect(decode({ ...payReq, id: bad })).toBeNull();
      expect(decode({ ...pay, id: bad })).toBeNull();
    }
  });

  it("accepts decimal amounts without leading zeros, at most 16 integer and 8 fraction digits", () => {
    for (const v of ["0", "1", "0.5", "1234567890123456", "1.12345678"]) expect(decode({ ...payReq, v })).toMatchObject({ v });
    for (const v of ["01", "1.", ".5", "-1", "1e3", "12345678901234567", "1.123456789", " 1", "1,5", 1]) {
      expect(decode({ ...payReq, v })).toBeNull();
    }
  });

  it("accepts short lowercase units only", () => {
    expect(decode({ ...payReq, u: "a".repeat(12) })).toMatchObject({ t: "pay-req" });
    for (const u of ["", "SAT", "a".repeat(13), "sat!", 1]) expect(decode({ ...payReq, u })).toBeNull();
  });

  it("requires 1 to 8 well formed endpoints on a request", () => {
    expect(decode({ ...payReq, e: Array(8).fill(["cashu", "x"]) })).toMatchObject({ t: "pay-req" });
    for (const e of [[], Array(9).fill(["cashu", "x"]), ["cashu", "x"], "cashu", [["cashu"]], [["cashu", "x", "y"]]]) {
      expect(decode({ ...payReq, e })).toBeNull();
    }
  });

  it("validates endpoint identifiers and bounds their payload", () => {
    const ok = (identifier: string, payload = "x") => decode({ ...payReq, e: [[identifier, payload]] }) !== null;
    expect(ok("ark/1")).toBe(true);
    expect(ok("a".repeat(64))).toBe(true);
    expect(ok("a".repeat(65))).toBe(false);
    for (const bad of ["Ark", "-ark", "ark/0", "ark/01", "ark/", "ark/1/2", "ark x", "", "../x"]) expect(ok(bad)).toBe(false);
    expect(ok("cashu", "p".repeat(32 * 1024))).toBe(true);
    expect(ok("cashu", "p".repeat(32 * 1024 + 1))).toBe(false);
    expect(decode({ ...payReq, e: [[1, "x"]] })).toBeNull();
    expect(decode({ ...payReq, e: [["cashu", 1]] })).toBeNull();
  });

  it("drops an invalid answered-ask id instead of passing it on", () => {
    expect(decode({ ...payReq, a: "short" })).toMatchObject({ a: undefined });
    expect(decode({ ...payReq, a: "a".repeat(10) })).toMatchObject({ a: "a".repeat(10) });
  });

  it("truncates memos to 140 characters and ignores non-text memos", () => {
    expect(decode({ ...payReq, memo: "m".repeat(500) })).toMatchObject({ memo: "m".repeat(140) });
    expect(decode({ ...pay, memo: { x: 1 } })).toMatchObject({ memo: undefined });
  });

  it("requires a single endpoint on a payment and a valid request id when one is named", () => {
    expect(decode(pay)).toEqual({ ...pay, rid: undefined, memo: undefined });
    expect(decode({ ...pay, e: [["cashu", "x"]] })).toBeNull();
    expect(decode({ ...pay, rid: "short" })).toBeNull();
    expect(decode({ ...pay, rid: 12345678 })).toBeNull();
    expect(decode({ ...pay, rid: "r".repeat(10) })).toMatchObject({ rid: "r".repeat(10) });
    expect(decode({ ...pay, ts: "1" })).toBeNull();
  });

  it("accepts pay-ask only for known methods", () => {
    const ask = { t: "pay-ask", id, ts: 1, v: "1", u: "sat" };
    for (const m of ["arkade", "usdt", "bark", "bitcoin"]) expect(decode({ ...ask, m })).toMatchObject({ m, memo: undefined });
    for (const m of ["cashu", "", undefined, "ARKADE"]) expect(decode({ ...ask, m })).toBeNull();
    expect(decode({ ...ask, m: "bark", v: "01" })).toBeNull();
    expect(decode({ ...ask, m: "bark", memo: "z".repeat(200) })).toMatchObject({ memo: "z".repeat(140) });
  });

  it("requires a boolean outcome on pay-res, validates the credited amount and truncates the error", () => {
    expect(decode({ t: "pay-res", id, ok: true })).toEqual({ t: "pay-res", id, ok: true, v: undefined, err: undefined });
    expect(decode({ t: "pay-res", id, ok: "true" })).toBeNull();
    expect(decode({ t: "pay-res", id: "x", ok: true })).toBeNull();
    expect(decode({ t: "pay-res", id, ok: true, v: "1.5" })).toMatchObject({ v: "1.5" });
    expect(decode({ t: "pay-res", id, ok: true, v: 1 })).toBeNull();
    expect(decode({ t: "pay-res", id, ok: false, err: "e".repeat(300) })).toMatchObject({ err: "e".repeat(200) });
    expect(decode({ t: "pay-res", id, ok: false, err: 5 })).toMatchObject({ err: undefined });
  });
});

describe("reset frames", () => {
  it("accepts only the three stream directions", () => {
    for (const d of ["q", "s", "f"]) expect(decode({ t: "rst", id: 1, d, e: "x" })).toEqual({ t: "rst", id: 1, d, e: "x" });
    for (const d of ["Q", "", undefined, "x"]) expect(decode({ t: "rst", id: 1, d })).toBeNull();
    expect(decode({ t: "rst", id: -1, d: "q" })).toBeNull();
  });

  it("defaults a missing reason to empty and truncates a long one", () => {
    expect(decode({ t: "rst", id: 1, d: "q" })).toMatchObject({ e: "" });
    expect(decode({ t: "rst", id: 1, d: "q", e: 7 })).toMatchObject({ e: "" });
    expect(decode({ t: "rst", id: 1, d: "q", e: "r".repeat(1000) })).toMatchObject({ e: "r".repeat(256) });
  });
});

describe("control frame properties", () => {
  const streamId = fc.integer({ min: 0, max: 0xffffffff });
  const shortText = fc.string({ maxLength: 40 });
  const header = fc.tuple(fc.string({ maxLength: 20 }), fc.string({ maxLength: 40 }));
  const payId = fc.stringMatching(/^[A-Za-z0-9_-]{8,64}$/);
  const amount = fc.stringMatching(/^(0|[1-9]\d{0,15})(\.\d{1,8})?$/);
  const unit = fc.stringMatching(/^[a-z0-9]{1,12}$/);
  const endpoint = fc.tuple(fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}(?:\/[1-9][0-9]{0,3})?$/), fc.string({ maxLength: 60 }));
  const finite = fc.double({ noNaN: true, noDefaultInfinity: true });

  const validFrame: fc.Arbitrary<ControlFrame> = fc.oneof(
    fc.record({ t: fc.constant("m" as const), ts: finite, m: fc.string({ maxLength: 200 }) }),
    fc.record({ t: fc.constant("call" as const), s: shortText }),
    fc.record({ t: fc.constant("req" as const), id: streamId, s: shortText, m: shortText, p: shortText, h: fc.array(header, { maxLength: 5 }), b: fc.boolean() }),
    fc.record({ t: fc.constant("res" as const), id: streamId, st: fc.integer({ min: 100, max: 599 }), h: fc.array(header, { maxLength: 5 }), b: fc.boolean() }),
    fc.record({ t: fc.constant("file" as const), id: streamId, f: shortText, ts: finite, n: shortText, s: fc.maxSafeNat(), m: shortText }),
    fc.record({ t: fc.constant("rst" as const), id: streamId, d: fc.constantFrom("q" as const, "s" as const, "f" as const), e: fc.string({ maxLength: 256 }) }),
    fc.record({ t: fc.constantFrom("ping" as const, "pong" as const), ts: finite }),
    fc.record({ t: fc.constant("pay-res" as const), id: payId, ok: fc.boolean(), v: amount, err: fc.string({ maxLength: 200 }) }),
    fc.record({ t: fc.constant("pay-ask" as const), id: payId, ts: finite, v: amount, u: unit, m: fc.constantFrom("arkade" as const, "usdt" as const, "bark" as const, "bitcoin" as const), memo: fc.string({ maxLength: 140 }) }),
    fc.record({ t: fc.constant("pay" as const), id: payId, ts: finite, rid: payId, v: amount, u: unit, memo: fc.string({ maxLength: 140 }), e: endpoint }),
    fc.record({ t: fc.constant("pay-req" as const), id: payId, ts: finite, v: amount, u: unit, memo: fc.string({ maxLength: 140 }), e: fc.array(endpoint, { minLength: 1, maxLength: 8 }), a: payId }),
  );

  it("round-trips every well formed frame unchanged", () => {
    fc.assert(
      fc.property(validFrame, (frame) => {
        // -0 is not representable in JSON; compare against what JSON itself preserves.
        expect(decodeControl(encodeControl(frame))).toEqual(JSON.parse(JSON.stringify(frame)));
      }),
      { numRuns: 300 },
    );
  });

  it("never throws on arbitrary text", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (text) => {
        const frame = decodeControl(text);
        expect(frame === null || KNOWN_KINDS.has(frame.t)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("never throws on arbitrary JSON under a known discriminator, and what it returns is well typed", () => {
    const garbage = fc.record(
      { t: fc.constantFrom(...KNOWN_KINDS), id: fc.jsonValue(), ts: fc.jsonValue(), s: fc.jsonValue(), m: fc.jsonValue(), p: fc.jsonValue(), h: fc.jsonValue(), st: fc.jsonValue(), v: fc.jsonValue(), u: fc.jsonValue(), e: fc.jsonValue(), d: fc.jsonValue(), ok: fc.jsonValue(), f: fc.jsonValue(), n: fc.jsonValue() },
      { requiredKeys: ["t"] },
    );
    fc.assert(
      fc.property(garbage, (value) => {
        const frame = decodeControl(JSON.stringify(value));
        if (frame === null) return;
        expect(frame.t).toBe(value.t);
        if ("id" in frame && typeof frame.id === "number") {
          expect(Number.isInteger(frame.id) && frame.id >= 0 && frame.id <= 0xffffffff).toBe(true);
        }
        if (frame.t === "req" || frame.t === "res") {
          expect(frame.h.every((h) => Array.isArray(h) && h.length === 2 && h.every((x) => typeof x === "string"))).toBe(true);
          expect(typeof frame.b).toBe("boolean");
        }
        if (frame.t === "file") expect(Number.isSafeInteger(frame.s) && frame.s >= 0).toBe(true);
        if (frame.t === "rst") expect(["q", "s", "f"]).toContain(frame.d);
      }),
      { numRuns: 400 },
    );
  });
});

describe("chunks", () => {
  it("encodes the header as kind, big-endian stream id and flags", () => {
    const bytes = encodeChunk({ kind: CHUNK_KIND.fileBody, id: 0x01020304, end: true, payload: Uint8Array.of(9) });
    expect([...bytes]).toEqual([3, 1, 2, 3, 4, CHUNK_FLAG_END, 9]);
  });

  it("carries a payload of exactly the maximum and refuses one byte more", () => {
    const payload = new Uint8Array(MAX_CHUNK_PAYLOAD_BYTES).fill(7);
    const bytes = encodeChunk({ kind: CHUNK_KIND.requestBody, id: 1, end: false, payload });
    expect(bytes).toHaveLength(LIMITS.maxChunkMessageBytes);
    expect(decodeChunk(bytes)?.payload).toEqual(payload);
    expect(() => encodeChunk({ kind: CHUNK_KIND.requestBody, id: 1, end: false, payload: new Uint8Array(MAX_CHUNK_PAYLOAD_BYTES + 1) })).toThrow(
      "Chunk payload too large",
    );
  });

  it("decodes a header-only chunk and refuses anything shorter", () => {
    expect(decodeChunk(Uint8Array.of(2, 0, 0, 0, 5, 1))).toEqual({ kind: 2, id: 5, end: true, payload: new Uint8Array(0) });
    expect(decodeChunk(Uint8Array.of(2, 0, 0, 0, 5))).toBeNull();
    expect(decodeChunk(new Uint8Array(0))).toBeNull();
  });

  it("refuses unknown kinds, including 0 and 4", () => {
    for (const kind of [0, 4, 255]) expect(decodeChunk(Uint8Array.of(kind, 0, 0, 0, 1, 0))).toBeNull();
  });

  it("reads only the END bit of the flags byte", () => {
    expect(decodeChunk(Uint8Array.of(1, 0, 0, 0, 1, 0xfe))?.end).toBe(false);
    expect(decodeChunk(Uint8Array.of(1, 0, 0, 0, 1, 0xff))?.end).toBe(true);
  });

  it("decodes a view into a larger buffer at its own offset", () => {
    const buffer = new Uint8Array(20).fill(0xaa);
    buffer.set(encodeChunk({ kind: CHUNK_KIND.responseBody, id: 77, end: false, payload: Uint8Array.of(1, 2) }), 5);
    const view = buffer.subarray(5, 13);
    expect(decodeChunk(view)).toEqual({ kind: CHUNK_KIND.responseBody, id: 77, end: false, payload: Uint8Array.of(1, 2) });
  });

  it("round-trips any chunk within the limits", () => {
    const chunk = fc.record({
      kind: fc.constantFrom(CHUNK_KIND.requestBody, CHUNK_KIND.responseBody, CHUNK_KIND.fileBody),
      id: fc.integer({ min: 0, max: 0xffffffff }),
      end: fc.boolean(),
      payload: fc.uint8Array({ maxLength: 512 }),
    });
    fc.assert(fc.property(chunk, (c: ChunkFrame) => void expect(decodeChunk(encodeChunk(c))).toEqual(c)), { numRuns: 200 });
  });

  it("never throws on arbitrary bytes, and accepts them only with a known kind and a full header", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        const chunk = decodeChunk(bytes);
        const acceptable = bytes.length >= 6 && [1, 2, 3].includes(bytes[0]);
        expect(chunk !== null).toBe(acceptable);
        if (chunk) expect(chunk.payload).toEqual(bytes.subarray(6));
      }),
      { numRuns: 300 },
    );
  });
});

/** A channel that records what was sent and can simulate a full send buffer. */
function recordingChannel(buffered = 0) {
  const sent: (string | Uint8Array)[] = [];
  const channel: FrameChannel & { buffered: number } = {
    buffered,
    get bufferedAmount() {
      return this.buffered;
    },
    drained: vi.fn(async () => {
      channel.buffered = 0;
    }),
    send: (data) => void sent.push(data),
    close() {},
    onMessage: null,
    onClose: null,
  };
  return { channel, sent, chunks: () => sent.map((s) => decodeChunk(s as Uint8Array)!) };
}

describe("sendBody", () => {
  it("splits a large part into maximum-size chunks and ends with an empty END chunk", async () => {
    const { channel, chunks } = recordingChannel();
    const body = new Uint8Array(MAX_CHUNK_PAYLOAD_BYTES * 2 + 3).map((_, i) => i % 256);
    await sendBody(channel, CHUNK_KIND.responseBody, 9, [body]);
    const out = chunks();
    expect(out.map((c) => [c.payload.length, c.end, c.id, c.kind])).toEqual([
      [MAX_CHUNK_PAYLOAD_BYTES, false, 9, 2],
      [MAX_CHUNK_PAYLOAD_BYTES, false, 9, 2],
      [3, false, 9, 2],
      [0, true, 9, 2],
    ]);
    expect(out.flatMap((c) => [...c.payload])).toEqual([...body]);
  });

  it("sends only the END chunk for an empty body, from sync or async sources", async () => {
    const sync = recordingChannel();
    await sendBody(sync.channel, CHUNK_KIND.fileBody, 1, []);
    expect(sync.chunks()).toEqual([{ kind: CHUNK_KIND.fileBody, id: 1, end: true, payload: new Uint8Array(0) }]);

    const async = recordingChannel();
    await sendBody(async.channel, CHUNK_KIND.fileBody, 1, (async function* () {})());
    expect(async.chunks()).toHaveLength(1);
  });

  it("stops without an END chunk once cancelled", async () => {
    const { channel, chunks } = recordingChannel();
    let calls = 0;
    const body = new Uint8Array(MAX_CHUNK_PAYLOAD_BYTES * 3);
    await sendBody(channel, CHUNK_KIND.requestBody, 2, [body], () => ++calls > 1);
    expect(chunks().map((c) => c.end)).toEqual([false]);

    const late = recordingChannel();
    let done = false;
    await sendBody(late.channel, CHUNK_KIND.requestBody, 2, (async function* () { yield Uint8Array.of(1); done = true; })(), () => done);
    expect(late.chunks().map((c) => c.end)).toEqual([false]);
  });

  it("waits for the channel to drain above the high water mark", async () => {
    const { channel, sent } = recordingChannel(LIMITS.sendHighWaterMark + 1);
    await sendBody(channel, CHUNK_KIND.requestBody, 3, [Uint8Array.of(1)]);
    expect(channel.drained).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(2);

    const atMark = recordingChannel(LIMITS.sendHighWaterMark);
    await sendBody(atMark.channel, CHUNK_KIND.requestBody, 3, [Uint8Array.of(1)]);
    expect(atMark.channel.drained).not.toHaveBeenCalled();
  });

  it("propagates a send failure to the caller", async () => {
    const { channel } = recordingChannel();
    channel.send = () => {
      throw new Error("Data link is not open");
    };
    await expect(sendBody(channel, CHUNK_KIND.requestBody, 4, [Uint8Array.of(1)])).rejects.toThrow("Data link is not open");
  });
});

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  binaryType = "blob";
  bufferedAmountLowThreshold = 0;
  sent: unknown[] = [];
  closed = 0;
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.closed++;
  }
  message(data: unknown) {
    const event = new Event("message") as Event & { data: unknown };
    event.data = data;
    this.dispatchEvent(event);
  }
}

describe("wrapDataChannel", () => {
  const wrap = () => {
    const dc = new FakeDataChannel();
    return { dc, channel: wrapDataChannel(dc as unknown as RTCDataChannel) };
  };

  it("configures binary as ArrayBuffer and the low water threshold", () => {
    const { dc } = wrap();
    expect(dc.binaryType).toBe("arraybuffer");
    expect(dc.bufferedAmountLowThreshold).toBe(LIMITS.sendLowWaterMark);
  });

  it("sends text and bytes while open and refuses once it is not", () => {
    const { dc, channel } = wrap();
    channel.send("hi");
    channel.send(Uint8Array.of(1));
    expect(dc.sent).toEqual(["hi", Uint8Array.of(1)]);
    dc.readyState = "closing";
    expect(() => channel.send("x")).toThrow("Data link is not open");
  });

  it("delivers text as text and ArrayBuffers as bytes, ignoring anything else", () => {
    const { dc, channel } = wrap();
    const got: unknown[] = [];
    channel.onMessage = (data) => got.push(data);
    dc.message("hello");
    dc.message(Uint8Array.of(4, 5).buffer);
    dc.message(new Blob(["x"]));
    dc.message(null);
    expect(got).toEqual(["hello", Uint8Array.of(4, 5)]);
  });

  it("tolerates messages and close before handlers are set, and reports close once set", () => {
    const { dc, channel } = wrap();
    dc.message("early");
    dc.dispatchEvent(new Event("close"));
    const onClose = vi.fn();
    channel.onClose = onClose;
    dc.dispatchEvent(new Event("close"));
    expect(onClose).toHaveBeenCalledOnce();
    channel.close();
    expect(dc.closed).toBe(1);
  });

  it("reports the underlying buffered amount", () => {
    const { dc, channel } = wrap();
    dc.bufferedAmount = 1234;
    expect(channel.bufferedAmount).toBe(1234);
  });

  it("resolves drained at once below the low water mark or when not open", async () => {
    const { dc, channel } = wrap();
    dc.bufferedAmount = LIMITS.sendLowWaterMark;
    await channel.drained();
    dc.bufferedAmount = LIMITS.sendLowWaterMark + 1;
    dc.readyState = "closed";
    await channel.drained();
  });

  it("resolves drained on bufferedamountlow or on close, and stops listening afterwards", async () => {
    for (const event of ["bufferedamountlow", "close"]) {
      const { dc, channel } = wrap();
      dc.bufferedAmount = LIMITS.sendLowWaterMark + 1;
      const remove = vi.spyOn(dc, "removeEventListener");
      let resolved = false;
      const drained = channel.drained().then(() => (resolved = true));
      await Promise.resolve();
      expect(resolved).toBe(false);
      dc.dispatchEvent(new Event(event));
      await drained;
      expect(remove.mock.calls.map(([name]) => name).sort()).toEqual(["bufferedamountlow", "close"]);
    }
  });
});
