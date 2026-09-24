import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, toBase64Url, utf8Encode } from "../src/bytes";
import { KNOCK_TTL_MS, MAX_KNOCKS, decodeGroupEntryLink, encodeGroupEntryLink, groupEntryUrl, knockRecords, mergeKnocks, readKnocks } from "../src/groupEntry";
import { createIdentity, publicKeyFromZ32 } from "../src/identity";

// covers: groups.protocol.entry

const g = "AbCdEfGhIjKlMnOpQrStUv";
const host = createIdentity();
const link = { g, host: host.pubKeyZ32 };

/** A knock record sealed with the link's key around any body: what a holder of the link could publish. */
function sealedKnocks(body: string): { label: string; value: string }[] {
  const key = hkdf(sha256, publicKeyFromZ32(link.host), utf8Encode(link.g), utf8Encode("ghostly-group-entry/1 knock key"), 32);
  const nonce = new Uint8Array(24).fill(1);
  return [{ label: "_knock", value: toBase64Url(concatBytes(nonce, xchacha20poly1305(key, nonce, utf8Encode(link.g)).encrypt(utf8Encode(body)))) }];
}

describe("entry link parsing", () => {
  it("round-trips any group id and entry key, through the code and the app URL", () => {
    fc.assert(fc.property(fc.uint8Array({ minLength: 16, maxLength: 16 }), bytes => {
      const l = { g: toBase64Url(bytes), host: createIdentity().pubKeyZ32 };
      expect(decodeGroupEntryLink(encodeGroupEntryLink(l))).toEqual(l);
      expect(decodeGroupEntryLink(groupEntryUrl("https://x.test///", l))).toEqual(l);
    }), { numRuns: 50 });
  });

  it("refuses extra or missing path segments and an empty input", () => {
    const code = encodeGroupEntryLink(link);
    expect(decodeGroupEntryLink(`${code}/extra`)).toBeNull();
    expect(decodeGroupEntryLink(`group1/${g}`)).toBeNull();
    expect(decodeGroupEntryLink("")).toBeNull();
    expect(decodeGroupEntryLink(`GROUP1/${g}/${host.pubKeyZ32}`)).toBeNull();
  });

  it("refuses an entry key of the right alphabet but the wrong length", () => {
    expect(decodeGroupEntryLink(`group1/${g}/${host.pubKeyZ32.slice(0, 51)}`)).toBeNull();
    expect(decodeGroupEntryLink(`group1/${g}/${host.pubKeyZ32}y`)).toBeNull();
  });

  it("never throws on arbitrary input", () => {
    fc.assert(fc.property(fc.string({ maxLength: 200 }), input => {
      const decoded = decodeGroupEntryLink(input);
      if (decoded) expect(decodeGroupEntryLink(encodeGroupEntryLink(decoded))).toEqual(decoded);
    }), { numRuns: 200 });
  });
});

describe("knock records from strangers", () => {
  const joiner = createIdentity().pubKeyZ32;

  it("keeps only the latest knocks when publishing more than fit", () => {
    const knocks = Array.from({ length: MAX_KNOCKS + 3 }, (_, i) => ({ key: createIdentity().pubKeyZ32, ts: i + 1 }));
    expect(readKnocks(link, knockRecords(link, knocks))).toEqual(knocks.slice(-MAX_KNOCKS));
  });

  it("refuses a record value over 900 characters without opening it", () => {
    expect(readKnocks(link, [{ label: "_knock", value: "A".repeat(901) }])).toEqual([]);
  });

  it("reads nothing from a sealed body that is not JSON or not an array", () => {
    expect(readKnocks(link, sealedKnocks("not json"))).toEqual([]);
    expect(readKnocks(link, sealedKnocks(JSON.stringify({ key: joiner, ts: 1 })))).toEqual([]);
    expect(readKnocks(link, sealedKnocks("\"string\""))).toEqual([]);
  });

  it("drops malformed entries and keeps the well-formed ones", () => {
    const body = JSON.stringify([[joiner, 5], [joiner], ["not-a-key", 5], [joiner, "5"], [joiner, 1.5], [joiner, 6, "extra"]]);
    expect(readKnocks(link, sealedKnocks(body))).toEqual([{ key: joiner, ts: 5 }, { key: joiner, ts: 6 }]);
    const more = JSON.stringify([[joiner, 2 ** 53], null, 7, { key: joiner, ts: 1 }, [5, joiner], [joiner, 7]]);
    expect(readKnocks(link, sealedKnocks(more))).toEqual([{ key: joiner, ts: 7 }]);
  });

  it("reads at most the knock cap from a record carrying more", () => {
    const body = JSON.stringify(Array.from({ length: MAX_KNOCKS + 4 }, (_, i) => [joiner, i]));
    expect(readKnocks(link, sealedKnocks(body))).toHaveLength(MAX_KNOCKS);
  });

  it("ignores records under other labels and one that is only a nonce", () => {
    const [record] = knockRecords(link, [{ key: joiner, ts: 1 }]);
    expect(readKnocks(link, [{ ...record, label: "_msgs" }])).toEqual([]);
    expect(readKnocks(link, [{ label: "_knock", value: toBase64Url(new Uint8Array(24)) }])).toEqual([]);
    expect(readKnocks(link, [{ label: "_knock", value: "" }])).toEqual([]);
  });

  it("never throws, and never reads knocks from random records", () => {
    fc.assert(fc.property(fc.string({ maxLength: 300 }), value => {
      expect(readKnocks(link, [{ label: "_knock", value }])).toEqual([]);
    }), { numRuns: 200 });
  });
});

describe("knock merging", () => {
  const now = 1_000_000_000;
  const key = () => createIdentity().pubKeyZ32;

  it("drops knocks from further than a minute in the future, and exactly at the TTL", () => {
    const future = { key: key(), ts: now + 60_001 }, nearFuture = { key: key(), ts: now + 60_000 };
    const expired = { key: key(), ts: now - KNOCK_TTL_MS }, fresh = { key: key(), ts: now - KNOCK_TTL_MS + 1 };
    const mine = { key: key(), ts: now };
    expect(mergeKnocks([future, nearFuture, expired, fresh], mine, now)).toEqual([fresh, nearFuture, mine]);
  });

  it("publishes only mine when nothing else is fresh", () => {
    const mine = { key: key(), ts: now };
    expect(mergeKnocks([], mine, now)).toEqual([mine]);
  });
});
