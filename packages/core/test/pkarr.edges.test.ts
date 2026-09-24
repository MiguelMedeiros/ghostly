import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { concatBytes, utf8Encode } from "../src/bytes";
import { encodeTxtPacket } from "../src/dns";
import { createIdentity, sign } from "../src/identity";
import { MAX_DNS_PACKET_BYTES, PacketTooLargeError, createRelayPayload, measureRecords, parseRelayPayload } from "../src/pkarr";

const id = createIdentity();

/** A relay payload around any DNS packet, signed the BEP44 way by `seed`. */
function payload(dns: Uint8Array, ts: bigint, seed = id.seed): Uint8Array {
  const signature = sign(concatBytes(utf8Encode(`3:seqi${ts}e1:v${dns.length}:`), dns), seed);
  const stamp = new Uint8Array(8);
  new DataView(stamp.buffer).setBigUint64(0, ts);
  return concatBytes(signature, stamp, dns);
}

describe("relay payloads", () => {
  it("round-trips records and the timestamp, with default TTLs", () => {
    const signed = createRelayPayload(id, [{ label: "_ts", value: "5" }, { label: "_nick", value: "n", ttl: 60 }], 123n);
    expect(parseRelayPayload(id.pubKeyZ32, signed)).toEqual({
      pubKeyZ32: id.pubKeyZ32, timestampMicros: 123n, records: [{ label: "_ts", value: "5", ttl: 300 }, { label: "_nick", value: "n", ttl: 60 }],
    });
  });

  it("round-trips arbitrary records and timestamps", () => {
    const record = fc.record({ label: fc.stringMatching(/^_[a-z]{1,8}$/), value: fc.string({ maxLength: 60 }), ttl: fc.nat() });
    fc.assert(fc.property(fc.array(record, { maxLength: 5 }), fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), (records, ts) => {
      const parsed = parseRelayPayload(id.pubKeyZ32, createRelayPayload(id, records, ts));
      expect(parsed.timestampMicros).toBe(ts);
      expect(parsed.records).toEqual(records);
    }), { numRuns: 50 });
  });

  it("works on a payload that is a view into a larger buffer", () => {
    const signed = createRelayPayload(id, [{ label: "_ts", value: "5" }], 7n);
    const big = new Uint8Array(signed.length + 20);
    big.set(signed, 10);
    expect(parseRelayPayload(id.pubKeyZ32, big.subarray(10, 10 + signed.length)).timestampMicros).toBe(7n);
  });

  it("refuses a payload one byte shorter than a signature, a timestamp and a DNS header", () => {
    expect(() => parseRelayPayload(id.pubKeyZ32, new Uint8Array(64 + 8 + 11))).toThrow("Relay payload too short");
    expect(() => parseRelayPayload(id.pubKeyZ32, new Uint8Array(0))).toThrow("Relay payload too short");
    // Exactly the minimum gets as far as the signature check.
    expect(() => parseRelayPayload(id.pubKeyZ32, new Uint8Array(64 + 8 + 12))).toThrow("Invalid signature");
  });

  it("refuses a payload over the BEP44 limit, and accepts one exactly at it", () => {
    expect(() => parseRelayPayload(id.pubKeyZ32, new Uint8Array(64 + 8 + MAX_DNS_PACKET_BYTES + 1))).toThrow(PacketTooLargeError);
    const dns = encodeTxtPacket([{ name: `_x.${id.pubKeyZ32}`, value: "", ttl: 1 }]);
    const padded = concatBytes(dns, new Uint8Array(MAX_DNS_PACKET_BYTES - dns.length));
    expect(parseRelayPayload(id.pubKeyZ32, payload(padded, 1n)).records).toEqual([{ label: "_x", value: "", ttl: 1 }]);
  });

  it("refuses a payload signed by another key, or with its timestamp or packet changed", () => {
    const signed = createRelayPayload(id, [{ label: "_ts", value: "5" }], 10n);
    expect(() => parseRelayPayload(createIdentity().pubKeyZ32, signed)).toThrow("Invalid signature");
    const stamp = signed.slice();
    stamp[64 + 7] ^= 1;
    expect(() => parseRelayPayload(id.pubKeyZ32, stamp)).toThrow("Invalid signature");
    const body = signed.slice();
    body[body.length - 1] ^= 1;
    expect(() => parseRelayPayload(id.pubKeyZ32, body)).toThrow("Invalid signature");
    expect(() => parseRelayPayload(id.pubKeyZ32, payload(encodeTxtPacket([]), 10n, createIdentity().seed))).toThrow("Invalid signature");
  });

  it("refuses a public key that is not z-base-32", () => {
    const signed = createRelayPayload(id, [], 1n);
    expect(() => parseRelayPayload("short", signed)).toThrow(/Invalid public key/);
  });

  it("keeps a record named outside the publisher's origin under its full name, so it never passes for one of ours", () => {
    const other = createIdentity().pubKeyZ32;
    const dns = encodeTxtPacket([{ name: `_msgs.${other}`, value: "x", ttl: 1 }, { name: `_ts.${id.pubKeyZ32}`, value: "1", ttl: 1 }]);
    expect(parseRelayPayload(id.pubKeyZ32, payload(dns, 1n)).records.map(r => r.label)).toEqual([`_msgs.${other}`, "_ts"]);
  });

  it("refuses to sign a packet over the limit, reporting its size", () => {
    const records = [{ label: "_big", value: "x".repeat(MAX_DNS_PACKET_BYTES) }];
    const size = measureRecords(id.pubKeyZ32, records);
    expect(size).toBeGreaterThan(MAX_DNS_PACKET_BYTES);
    try {
      createRelayPayload(id, records, 1n);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PacketTooLargeError);
      expect((error as PacketTooLargeError).size).toBe(size);
      expect((error as Error).message).toBe(`DNS packet is too large, expected max ${MAX_DNS_PACKET_BYTES} bytes but got: ${size}`);
    }
  });

  it("only ever throws an Error on random payloads", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 1200 }), bytes => {
      try { parseRelayPayload(id.pubKeyZ32, bytes); } catch (error) { expect(error).toBeInstanceOf(Error); }
    }), { numRuns: 200 });
  });
});
