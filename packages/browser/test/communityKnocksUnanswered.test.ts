import { describe, expect, it } from "vitest";
import { createIdentity, decodeCommunityLink, knockIdentity, knockRecords, type GroupEntryLink } from "@ghostly/core";
import { KNOCK_SHARDS } from "../src/engine/community";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.community.join

/**
 * Knock records anyone with the link can write, filled again and again with keys whose side of the entry session never
 * comes up: the door's sessions all go to them, and nobody real gets in. The admin is told, and a new link (the old one
 * reaches nobody) lets the next joiner in. A busy link with real joiners, some of whom leave before they are let in,
 * tells nothing.
 */
const record = (link: GroupEntryLink, n: number): GroupEntryLink => ({ g: `${link.g}.${n}`, host: link.host });

/** Every 2 s, 6 new keys in each knock record, written straight onto Pkarr: no app behind them. */
function flood(world: CommunityWorld, entry: GroupEntryLink) {
  let last = -Infinity;
  return (now: number) => {
    if (now - last < 2_000) return;
    last = now;
    for (let n = 0; n < KNOCK_SHARDS; n++) {
      const knocks = Array.from({ length: 6 }, () => ({ key: createIdentity().pubKeyZ32, ts: now }));
      world.pkarr.set(knockIdentity(record(entry, n)).pubKeyZ32, knockRecords(record(entry, n), knocks));
    }
  };
}

const told = (world: CommunityWorld, p: Peer, id: string) => !!world.view(p, id)?.community?.unansweredKnocks;

describe("knocks whose entry sessions never come up", { timeout: 300_000 }, () => {
  it("the admin is told nobody gets in, and a new link lets the next joiner in", async () => {
    const world = new CommunityWorld();
    const alice = world.add("alice");
    const id = await alice.groups.create("Door");
    const entry = decodeCommunityLink(await alice.groups.enableLink(id))!;
    await world.run(5_000);
    const tick = flood(world, entry);
    const step = async (ms: number) => { const end = world.now + ms; while (world.now < end) { tick(world.now); await world.run(1_000, 1_000); } };
    await step(6 * 60_000);
    expect(told(world, alice, id)).toBe(true);
    // One tap: the link is replaced. The old records keep filling; the new link's are another's.
    const fresh = await alice.groups.enableLink(id, true);
    expect(told(world, alice, id)).toBe(false);
    const carol = world.add("carol");
    await carol.groups.joinByLink(fresh);
    const end = world.now + 2 * 60_000;
    while (world.now < end && !world.member(carol, id)) { tick(world.now); await world.run(1_000, 1_000); }
    expect(world.member(carol, id)).toBe(true);
    await step(3 * 60_000);
    expect(told(world, alice, id)).toBe(false);
  });

  it("a busy link, a few joiners closing their app before they are in, tells nothing", async () => {
    const world = new CommunityWorld();
    const alice = world.add("alice");
    const id = await alice.groups.create("Door");
    const link = await alice.groups.enableLink(id);
    await world.run(5_000);
    let ever = false;
    const watch = async (ms: number) => { const end = world.now + ms; while (world.now < end) { await world.run(1_000, 1_000); ever ||= told(world, alice, id); } };
    // 24 people open the link over 12 minutes, one every 30 s; every third closes its app at once and never comes back.
    for (let i = 0; i < 24; i++) {
      const p = world.add(`joiner${i}`);
      await p.groups.joinByLink(link);
      if (i % 3 === 2) { await world.run(1_000, 1_000); p.online = false; }
      await watch(30_000);
    }
    await watch(5 * 60_000);
    expect(ever).toBe(false);
  });
});
