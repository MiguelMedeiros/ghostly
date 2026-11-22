import { describe, expect, it } from "vitest";
import { beaconKeys, beaconRecords, createIdentity, readBeacon } from "@ghostly/core";
import { CommunityWorld, RELAY_NETWORK, seededRandom } from "./communityWorld";
// covers: groups.community.catch-up

/**
 * A hub back after a restart reads, for two minutes, the hubs listed anew in the beacon and looks fast for each. Any
 * member can write the beacon (its keys come from the group's rendezvous secret), keys of nobody included. Looked for
 * as listed anew, those stayed in what the hub expected for the rest of its run: no edge is ever opened to a key off
 * the roster, so the hub went on "letting someone in", and its reads of the beacon, the lobby and the bell went out
 * as the door's (not held back while links signal) 16 times a minute instead of 2 (CommunityWorld, 2026-11-17).
 */
describe("a beacon written while a hub is back from a restart", { timeout: 120_000 }, () => {
  for (const seed of [1, 2, 3]) it(`keeps no key of nobody listed there among those the hub looks for (seed ${seed})`, async () => {
    const world = new CommunityWorld(undefined, RELAY_NETWORK, seededRandom(seed));
    const alice = world.add("alice"), bob = world.add("bob");
    const id = await alice.groups.create("Check");
    const link = await alice.groups.enableLink(id);
    await bob.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
    await world.until(() => world.member(bob, id), 10 * 60_000);
    await world.run(3 * 60_000);
    alice.online = false; bob.online = false;
    await world.run(110_000);
    await world.restart(alice);
    await world.run(20_000);
    const keys = beaconKeys(alice.groups.communities.session(id)!.state.rv, id), beacon = keys.identity.pubKeyZ32;
    const listed = readBeacon(keys, world.pkarr.get(beacon) ?? []);
    const strangers = Array.from({ length: 8 - listed.length }, () => ({ key: createIdentity().pubKeyZ32, ts: world.now, load: 0 }));
    world.pkarr.set(beacon, beaconRecords(keys, [...listed, ...strangers]));
    await world.run(6 * 60_000);
    let door = 0;
    world.onPkarr = (p, op, _key, _background, asDoor) => { if (p === alice && op === "resolve" && asDoor) door++; };
    await world.run(60_000);
    // 16 a minute before; 2 with no key written in.
    expect(door).toBeLessThanOrEqual(3);
  });
});
