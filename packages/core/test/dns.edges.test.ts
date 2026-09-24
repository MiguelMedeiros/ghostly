import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { concatBytes, utf8Encode } from "../src/bytes";
import { decodeTxtPacket, encodeTxtPacket, type TxtRecord } from "../src/dns";

// covers: core.records

const header = (questions: number, answers: number) => Uint8Array.of(0, 0, 0x80, 0, questions >> 8, questions & 0xff, answers >> 8, answers & 0xff, 0, 0, 0, 0);
const name = (...labels: string[]) => concatBytes(...labels.flatMap(l => [Uint8Array.of(utf8Encode(l).length), utf8Encode(l)]), Uint8Array.of(0));
/** type, class IN, ttl, rdlength */
const rrHeader = (type: number, ttl: number, rdLength: number) =>
  Uint8Array.of(type >> 8, type & 0xff, 0, 1, ttl >>> 24, (ttl >>> 16) & 0xff, (ttl >>> 8) & 0xff, ttl & 0xff, rdLength >> 8, rdLength & 0xff);
const txt = (...strings: Uint8Array[]) => concatBytes(...strings.flatMap(s => [Uint8Array.of(s.length), s]));

describe("DNS TXT encoding", () => {
  it("round-trips an empty value and values at and just over one character-string", () => {
    const records: TxtRecord[] = [
      { name: "_a.origin", value: "", ttl: 1 },
      { name: "_b.origin", value: "x".repeat(255), ttl: 2 },
      { name: "_c.origin", value: "y".repeat(256), ttl: 0xffffffff },
    ];
    expect(decodeTxtPacket(encodeTxtPacket(records))).toEqual(records);
  });

  it("splits by UTF-8 bytes, not characters, and still round-trips", () => {
    const records = [{ name: "_n.origin", value: "\u{1f47b}".repeat(100), ttl: 300 }];
    expect(decodeTxtPacket(encodeTxtPacket(records))).toEqual(records);
  });

  it("refuses a label longer than 63 bytes and accepts exactly 63", () => {
    expect(() => encodeTxtPacket([{ name: `${"a".repeat(64)}.origin`, value: "v", ttl: 1 }])).toThrow(/DNS label too long/);
    const ok = [{ name: `${"a".repeat(63)}.origin`, value: "v", ttl: 1 }];
    expect(decodeTxtPacket(encodeTxtPacket(ok))).toEqual(ok);
  });

  it("drops empty labels from a name", () => {
    expect(decodeTxtPacket(encodeTxtPacket([{ name: "_a..origin.", value: "v", ttl: 1 }]))).toEqual([{ name: "_a.origin", value: "v", ttl: 1 }]);
  });

  it("stays decodable when the packet grows past the reach of compression pointers", () => {
    const records = Array.from({ length: 80 }, (_, i) => ({ name: `_r${i}.${"o".repeat(52)}`, value: "v".repeat(250), ttl: 300 }));
    const encoded = encodeTxtPacket(records);
    expect(encoded.length).toBeGreaterThan(0x3fff);
    expect(decodeTxtPacket(encoded)).toEqual(records);
  });

  it("round-trips arbitrary records", () => {
    const label = fc.stringMatching(/^[a-z0-9_-]{1,20}$/);
    const record = fc.record({ name: fc.array(label, { minLength: 1, maxLength: 4 }).map(l => l.join(".")), value: fc.string({ maxLength: 600 }), ttl: fc.nat() });
    fc.assert(fc.property(fc.array(record, { maxLength: 6 }), records => {
      expect(decodeTxtPacket(encodeTxtPacket(records))).toEqual(records);
    }), { numRuns: 200 });
  });
});

describe("DNS decoding of untrusted packets", () => {
  it("refuses a packet shorter than its header", () => {
    expect(() => decodeTxtPacket(new Uint8Array(11))).toThrow("DNS packet too short");
    expect(decodeTxtPacket(header(0, 0))).toEqual([]);
  });

  it("skips questions and reads the answers after them", () => {
    const packet = concatBytes(header(1, 1), name("q", "origin"), Uint8Array.of(0, 16, 0, 1), name("_a", "origin"), rrHeader(16, 7, 3), txt(utf8Encode("hi")));
    expect(decodeTxtPacket(packet)).toEqual([{ name: "_a.origin", value: "hi", ttl: 7 }]);
  });

  it("skips records that are not TXT, and TXT values that are not UTF-8", () => {
    const packet = concatBytes(
      header(0, 3),
      name("_a"), rrHeader(1, 1, 4), Uint8Array.of(127, 0, 0, 1),
      name("_b"), rrHeader(16, 1, 3), txt(Uint8Array.of(0xff, 0xfe)),
      name("_c"), rrHeader(16, 1, 6), txt(utf8Encode("ab"), utf8Encode("cd")),
    );
    expect(decodeTxtPacket(packet)).toEqual([{ name: "_c", value: "abcd", ttl: 1 }]);
  });

  it("follows a compression pointer to an earlier name", () => {
    const first = name("_a", "origin");
    const packet = concatBytes(header(0, 2), first, rrHeader(16, 1, 2), txt(utf8Encode("1")),
      Uint8Array.of(2), utf8Encode("_b"), Uint8Array.of(0xc0, 12 + 3), rrHeader(16, 1, 2), txt(utf8Encode("2")));
    expect(decodeTxtPacket(packet).map(r => r.name)).toEqual(["_a.origin", "_b.origin"]);
  });

  it.each([
    ["a name that runs past the end", concatBytes(header(0, 1), Uint8Array.of(5), utf8Encode("ab")), "DNS label out of bounds"],
    ["a name with no terminator", concatBytes(header(0, 1), Uint8Array.of(2), utf8Encode("ab")), "DNS name out of bounds"],
    ["a pointer cut in half", concatBytes(header(0, 1), Uint8Array.of(0xc0)), "DNS pointer out of bounds"],
    ["a pointer past the end", concatBytes(header(0, 1), Uint8Array.of(0xc0, 0xff)), "DNS name out of bounds"],
    ["a pointer loop", concatBytes(header(0, 1), Uint8Array.of(0xc0, 12)), "DNS name has too many compression pointers"],
    ["an extended label type", concatBytes(header(0, 1), Uint8Array.of(0x40, 0)), "Unsupported DNS label type"],
    ["a reserved label type", concatBytes(header(0, 1), Uint8Array.of(0x80, 0)), "Unsupported DNS label type"],
    ["a truncated record header", concatBytes(header(0, 1), name("_a"), Uint8Array.of(0, 16, 0, 1)), "DNS record out of bounds"],
    ["rdata longer than the packet", concatBytes(header(0, 1), name("_a"), rrHeader(16, 1, 10), txt(utf8Encode("x"))), "DNS rdata out of bounds"],
    ["a character-string longer than its rdata", concatBytes(header(0, 1), name("_a"), rrHeader(16, 1, 2), Uint8Array.of(5, 0x61), utf8Encode("bcdef")), "DNS character-string out of bounds"],
    ["more answers than the packet holds", concatBytes(header(0, 2), name("_a"), rrHeader(16, 1, 2), txt(utf8Encode("x"))), "DNS name out of bounds"],
    ["a question with no room for its type", concatBytes(header(2, 0), name("q")), "DNS name out of bounds"],
  ])("throws on %s", (_, packet, message) => {
    expect(() => decodeTxtPacket(packet)).toThrow(message);
  });

  it("throws on a name that is not UTF-8", () => {
    expect(() => decodeTxtPacket(concatBytes(header(0, 1), Uint8Array.of(1, 0xff, 0), rrHeader(16, 1, 0)))).toThrow();
  });

  it("only ever throws an Error on random bytes, and never loops", () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 12, maxLength: 300 }), bytes => {
      try { decodeTxtPacket(bytes); } catch (error) { expect(error).toBeInstanceOf(Error); }
    }), { numRuns: 300 });
  });

  it("survives any single corrupted byte of a real packet", () => {
    const packet = encodeTxtPacket([{ name: "_msgs.origin", value: "hello", ttl: 300 }, { name: "_ts.origin", value: "1", ttl: 300 }]);
    fc.assert(fc.property(fc.nat({ max: packet.length - 1 }), fc.integer({ min: 0, max: 255 }), (i, v) => {
      const copy = packet.slice();
      copy[i] = v;
      try { decodeTxtPacket(copy); } catch (error) { expect(error).toBeInstanceOf(Error); }
    }), { numRuns: 300 });
  });
});
