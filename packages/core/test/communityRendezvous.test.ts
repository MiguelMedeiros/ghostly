import { describe, expect, it } from "vitest";
import { createIdentity } from "../src/identity";
import { randomBytes, toBase64Url } from "../src/bytes";
import {
// covers: groups.protocol.community-topology
  COMMUNITY_TOPOLOGY, beaconKeys, beaconRecords, freshHubs, lobbyKeys, lobbyRecords, mergeBeacon, mergeLobby, pickHubs, rankHubs, readBeacon, readLobby, shouldBeHub,
  type Hub,
} from "../src/communityRendezvous";

const rv = toBase64Url(randomBytes(32));
const G = "AAAAAAAAAAAAAAAAAAAAAA";
const keys = (n: number) => Array.from({ length: n }, () => createIdentity().pubKeyZ32);

describe("community rendezvous: beacon and lobbies", () => {
  it("seals the beacon so only holders of the rendezvous secret read it, within one Pkarr value", () => {
    const now = Date.now();
    const hubs: Hub[] = keys(COMMUNITY_TOPOLOGY.maxHubs + 3).map((key, i) => ({ key, ts: now - i * 1000, load: i }));
    const records = beaconRecords(beaconKeys(rv, G), hubs);
    expect(records[0].value.length).toBeLessThanOrEqual(900);
    const read = readBeacon(beaconKeys(rv, G), records);
    expect(read).toHaveLength(COMMUNITY_TOPOLOGY.maxHubs);
    expect(read[0]).toEqual({ key: hubs[0].key, ts: Math.floor(hubs[0].ts / 1000) * 1000, load: 0, since: Math.floor(hubs[0].ts / 1000) * 1000 });
    expect(readBeacon(beaconKeys(toBase64Url(randomBytes(32)), G), records)).toEqual([]);
    expect(readBeacon(beaconKeys(rv, "BBBBBBBBBBBBBBBBBBBBBB"), records)).toEqual([]);
    // Another group, another identity; the same group, the same one for everyone.
    expect(beaconKeys(rv, G).identity.pubKeyZ32).toBe(beaconKeys(rv, G).identity.pubKeyZ32);
    expect(beaconKeys(rv, "BBBBBBBBBBBBBBBBBBBBBB").identity.pubKeyZ32).not.toBe(beaconKeys(rv, G).identity.pubKeyZ32);
  });

  it("merges: my entry refreshed, stale and departed hubs dropped, newest first, bounded", () => {
    const now = Date.now(), [me, a, b, c] = keys(4);
    const existing: Hub[] = [{ key: a, ts: now - 10_000, load: 3 }, { key: b, ts: now - COMMUNITY_TOPOLOGY.beaconFreshMs - 1, load: 1 }, { key: me, ts: now - 50_000, load: 9 }, { key: c, ts: now - 5_000, load: 0 }];
    const merged = mergeBeacon(existing, me, { key: me, ts: now, load: 2 }, now, key => key !== c);
    expect(merged.map(h => h.key)).toEqual([me, a]);
    expect(mergeBeacon(existing, me, null, now).map(h => h.key)).toEqual([c, a]);
  });

  it("lobbies hold the latest few requests, per hub", () => {
    const now = Date.now(), [hub, other] = keys(2);
    let entries: { key: string; ts: number }[] = [];
    for (const key of keys(COMMUNITY_TOPOLOGY.lobbyEntries + 2)) entries = mergeLobby(entries, { key, ts: now }, now);
    expect(entries).toHaveLength(COMMUNITY_TOPOLOGY.lobbyEntries);
    const records = lobbyRecords(lobbyKeys(rv, G, hub), entries);
    expect(records[0].value.length).toBeLessThanOrEqual(900);
    expect(readLobby(lobbyKeys(rv, G, hub), records).map(e => e.key)).toEqual(entries.map(e => e.key));
    expect(readLobby(lobbyKeys(rv, G, other), records)).toEqual([]);
    expect(lobbyKeys(rv, G, hub).identity.pubKeyZ32).not.toBe(lobbyKeys(rv, G, other).identity.pubKeyZ32);
    expect(mergeLobby([{ key: "x", ts: now - COMMUNITY_TOPOLOGY.lobbyFreshMs - 1 }], { key: hub, ts: now }, now)).toEqual([{ key: hub, ts: now }]);
  });

  it("becomes a hub when there are too few, or all are full; otherwise picks the least loaded", () => {
    const now = Date.now(), [me, a, b, c] = keys(4);
    expect(shouldBeHub(me, [], now)).toBe(true);
    expect(shouldBeHub(me, [{ key: a, ts: now, load: 0 }], now)).toBe(true);
    const two: Hub[] = [{ key: a, ts: now, load: 5 }, { key: b, ts: now, load: 1 }];
    expect(shouldBeHub(me, two, now)).toBe(false);
    expect(pickHubs(me, [...two, { key: c, ts: now, load: COMMUNITY_TOPOLOGY.hubCapacity }], now)).toEqual([b]);
    expect(pickHubs(me, two, now, new Set([b]))).toEqual([a]);
    const full: Hub[] = [{ key: a, ts: now, load: COMMUNITY_TOPOLOGY.hubCapacity }, { key: b, ts: now, load: COMMUNITY_TOPOLOGY.hubCapacity }];
    expect(shouldBeHub(me, full, now)).toBe(true);
    const many: Hub[] = keys(COMMUNITY_TOPOLOGY.maxHubs).map(key => ({ key, ts: now, load: COMMUNITY_TOPOLOGY.hubCapacity }));
    expect(shouldBeHub(me, many, now)).toBe(false);
    expect(freshHubs([{ key: a, ts: now - COMMUNITY_TOPOLOGY.beaconFreshMs, load: 0 }], now)).toEqual([]);
  });

  it("ranks hubs per subject: one order for everyone, different subjects spread", () => {
    const hubs = keys(5), subjects = keys(40);
    expect(rankHubs(subjects[0], hubs)).toEqual(rankHubs(subjects[0], [...hubs].reverse()));
    const firsts = new Set(subjects.map(s => rankHubs(s, hubs)[0]));
    expect(firsts.size).toBeGreaterThan(2);
  });
});
