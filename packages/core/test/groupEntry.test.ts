import { describe, expect, it } from "vitest";
import {
  KNOCK_TTL_MS, MAX_KNOCKS, decodeGroupEntryLink, encodeGroupEntryLink, entryParams, groupEntryUrl, knockIdentity, knockRecords, mergeKnocks, readKnocks,
} from "../src/groupEntry";
import { edgeParams } from "../src/groupCrypto";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { fromBase64Url } from "../src/bytes";
// covers: groups.protocol.entry

const g = "AbCdEfGhIjKlMnOpQrStUv";
const host = createIdentity();
const link = { g, host: host.pubKeyZ32 };

describe("group entry links (group-entry/1)", () => {
  it("round-trips as a code, an app address and a pasted link, and refuses anything else", () => {
    const code = encodeGroupEntryLink(link);
    expect(code).toBe(`group1/${g}/${host.pubKeyZ32}`);
    expect(decodeGroupEntryLink(code)).toEqual(link);
    const url = groupEntryUrl("https://app.ghostly.tools/", link);
    expect(url).toBe(`https://app.ghostly.tools/#/join/${code}`);
    expect(decodeGroupEntryLink(url)).toEqual(link);
    expect(decodeGroupEntryLink(`  /join/${code}\n`)).toEqual(link);
    expect(decodeGroupEntryLink(`group2/${g}/${host.pubKeyZ32}`)).toBeNull();
    expect(decodeGroupEntryLink(`group1/short/${host.pubKeyZ32}`)).toBeNull();
    expect(decodeGroupEntryLink(`group1/${g}/not-a-key`)).toBeNull();
    // A chat invite is not a group link.
    expect(decodeGroupEntryLink(`pair1/${"A".repeat(43)}/${host.pubKeyZ32}/${"B".repeat(43)}`)).toBeNull();
  });

  it("gives every holder the same knock identity, and a different one per link", () => {
    expect(knockIdentity(link).pubKeyZ32).toBe(knockIdentity({ ...link }).pubKeyZ32);
    expect(knockIdentity(link).pubKeyZ32).not.toBe(knockIdentity({ g, host: createIdentity().pubKeyZ32 }).pubKeyZ32);
    expect(knockIdentity(link).pubKeyZ32).not.toBe(knockIdentity({ g: "ZZZZEfGhIjKlMnOpQrStUv", host: host.pubKeyZ32 }).pubKeyZ32);
    expect(knockIdentity(link).pubKeyZ32).not.toBe(host.pubKeyZ32);
  });

  it("seals knocks with the link: they read back under it, and are nothing under another link or tampered", () => {
    const joiner = createIdentity().pubKeyZ32;
    const records = knockRecords(link, [{ key: joiner, ts: 1_000 }]);
    expect(records[0].value).not.toContain(joiner);
    expect(readKnocks(link, records)).toEqual([{ key: joiner, ts: 1_000 }]);
    expect(readKnocks({ g, host: createIdentity().pubKeyZ32 }, records)).toEqual([]);
    const tampered = [{ ...records[0], value: records[0].value.slice(0, -2) + (records[0].value.endsWith("A") ? "BB" : "AA") }];
    expect(readKnocks(link, tampered)).toEqual([]);
    expect(readKnocks(link, [])).toEqual([]);
    expect(readKnocks(link, [{ label: "_knock", value: "!!" }])).toEqual([]);
    expect(fromBase64Url(records[0].value).length).toBeLessThan(900);
  });

  it("merges knocks: mine refreshed and last, stale and duplicate ones dropped, at most a few kept", () => {
    const now = 10 * KNOCK_TTL_MS;
    const keys = Array.from({ length: 9 }, () => createIdentity().pubKeyZ32);
    const existing = [
      { key: keys[0], ts: now - KNOCK_TTL_MS - 1 },
      ...keys.slice(1, 8).map((key, i) => ({ key, ts: now - 1_000 + i })),
      { key: keys[8], ts: now - 5_000 },
    ];
    const merged = mergeKnocks(existing, { key: keys[8], ts: now }, now);
    expect(merged).toHaveLength(MAX_KNOCKS);
    expect(merged[merged.length - 1]).toEqual({ key: keys[8], ts: now });
    expect(merged.some(k => k.key === keys[0])).toBe(false);
    expect(merged.filter(k => k.key === keys[8])).toHaveLength(1);
    expect(readKnocks(link, knockRecords(link, merged))).toEqual(merged);
  });

  it("derives one entry session for both ends, pinned to the other, distinct from any edge", () => {
    const joiner = createIdentity();
    const hostSide = entryParams(link, host.seed, host.pubKeyZ32, joiner.pubKeyZ32);
    const joinerSide = entryParams(link, joiner.seed, joiner.pubKeyZ32, host.pubKeyZ32);
    expect(hostSide.encKeyB64).toBe(joinerSide.encKeyB64);
    expect(hostSide.peerPubKeyZ32).toBe(identityFromSeedB64(joinerSide.seedB64).pubKeyZ32);
    expect(joinerSide.peerPubKeyZ32).toBe(identityFromSeedB64(hostSide.seedB64).pubKeyZ32);
    const edge = edgeParams(g, host.seed, host.pubKeyZ32, joiner.pubKeyZ32);
    expect(edge.seedB64).not.toBe(hostSide.seedB64);
    expect(edge.encKeyB64).not.toBe(hostSide.encKeyB64);
  });
});
