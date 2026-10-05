import { describe, expect, it } from "vitest";
import { communityCommitHash, decodeCommunityLink, knockIdentity } from "@ghostly/core";
import { CommunityWorld, RELAY_NETWORK, type Peer } from "./communityWorld";
// covers: groups.community.remove, groups.community.join, groups.community.send, groups.protocol.community-topology

/**
 * A member removed from a community while its app is closed (WISP 903 · Group Community § Leaving and removal): when
 * it comes back it is told, by the commit that took it out and nothing after; it is no hub and gets no edge but the
 * one that tells it; what it sends is refused; and the group's link lets it in again.
 */
interface Scene { world: CommunityWorld; admin: Peer; bob: Peer; carol: Peer; dave: Peer; id: string; link: string; daveKey: string; seen: { at: number; from: string; to: string; t: string }[] }

async function removedWhileAway(): Promise<Scene> {
  const world = new CommunityWorld();
  const admin = world.add("admin"), bob = world.add("bob"), carol = world.add("carol"), dave = world.add("dave");
  const id = await admin.groups.create("Open door");
  const link = await admin.groups.enableLink(id);
  for (const p of [bob, carol, dave]) await p.groups.joinByLink(link);
  await world.until(() => [bob, carol, dave].every(p => world.member(p, id)), 10 * 60_000);
  await world.run(20_000);
  await dave.groups.send(id, "dave, while a member");
  await world.run(5_000);
  const daveKey = world.view(dave, id)!.myKey!;
  dave.online = false;
  await world.run(5_000);
  await admin.groups.remove(id, daveKey);
  await world.run(10_000);
  const seen: Scene["seen"] = [];
  world.drop = (from, to, frame) => { if (from === dave || to === dave) seen.push({ at: world.now, from: from.name, to: to.name, t: String(frame.t) }); return false; };
  return { world, admin, bob, carol, dave, id, link, daveKey, seen };
}

const session = (peer: Peer, id: string) => peer.groups.communities.session(id)!;
const edgesTo = (world: CommunityWorld, key: string, but: Peer) => [...world.peers.values()].filter(p => p !== but).flatMap(p => [...p.links.values()].filter(e => e.kind === "edge" && e.peer === key));

describe("a community member removed while its app was closed", { timeout: 120_000 }, () => {
  it("is told when it comes back, by the commit that took it out and nothing after", async () => {
    const { world, admin, bob, dave, id, daveKey, seen } = await removedWhileAway();
    // Meanwhile the group goes on: a new link, someone new, and things said.
    const next = await admin.groups.enableLink(id, true);
    const erin = world.add("erin");
    await erin.groups.joinByLink(next);
    await world.until(() => world.member(erin, id), 5 * 60_000);
    await bob.groups.send(id, "said while dave was away");
    await world.run(5_000);
    const removal = session(admin, id).state.chain.findIndex(c => c.k === "remove" && c.s === daveKey);
    const entryBefore = session(dave, id).entryKey;
    seen.length = 0;

    await world.restart(dave);
    expect(world.view(dave, id)).toMatchObject({ status: "active", canSend: true });
    const took = await world.until(() => world.view(dave, id)?.status === "removed", 90_000);
    expect(took).toBeLessThanOrEqual(75_000);
    expect(world.view(dave, id)).toMatchObject({ status: "removed", statusReason: "You were removed from this group", canSend: false });
    expect(dave.messages.filter(m => m.event === "removed")).toHaveLength(1);

    // What Dave holds ends with his removal: no later commit (the new link's key among them), on his branch or beside it.
    const state = session(dave, id).state, hashes = new Set(session(admin, id).state.chain.slice(removal + 1).map(c => communityCommitHash(c)));
    expect(state.chain).toHaveLength(removal + 1);
    expect([...state.chain, ...state.side].some(c => hashes.has(communityCommitHash(c)))).toBe(false);
    expect(state.entry.key).toBe(entryBefore);
    expect(decodeCommunityLink(next)?.host).not.toBe(entryBefore);

    // The group goes on among its members: an edge to him carried the commits up to his removal.
    await bob.groups.send(id, "after dave was told");
    await erin.groups.send(id, "erin too");
    await world.run(5 * 60_000);
    const toDave = seen.filter(f => f.to === "dave");
    expect(toDave.length).toBeGreaterThan(0);
    expect(new Set(toDave.map(f => f.t))).toEqual(new Set(["group-commit"]));
    expect(toDave.length).toBeLessThanOrEqual(removal + 1);
    expect(world.texts(dave, id)).toEqual(["dave, while a member"]);
    // No hub and no member keeps an edge to him, and he is nobody's hub.
    expect(edgesTo(world, daveKey, dave)).toEqual([]);
    expect(dave.groups.communities.isHub(id)).toBe(false);
    expect([...dave.links.values()].filter(e => e.kind === "edge")).toEqual([]);
    expect(world.texts(erin, id)).toEqual(expect.arrayContaining(["after dave was told", "erin too"]));
  });

  it("is no hub for the members while it lists itself as one: hubs exchange the group's frames with members only", async () => {
    const { world, admin, bob, carol, dave, id, daveKey, seen } = await removedWhileAway();
    // The hubs' commits are lost on the way: he stays as he was, and becomes a hub of his own.
    world.drop = (from, to, frame) => { if (from === dave || to === dave) seen.push({ at: world.now, from: from.name, to: to.name, t: String(frame.t) }); return to === dave; };
    await world.restart(dave);
    // (A while: each hub opens him an edge for its farewell, and a member waits a minute for a hub whose side is there.)
    await world.until(() => dave.groups.communities.isHub(id), 5 * 60_000);
    await bob.groups.send(id, "after the removal");
    await carol.groups.send(id, "after the removal, too");
    await world.run(3 * 60_000);
    // Hubs speak the group's frames to members: an edge to him carries the commit that tells him.
    expect(new Set(seen.filter(f => f.to === "dave").map(f => f.t))).toEqual(new Set(["group-commit"]));
    // And no member takes him for a hub: theirs are the three of them at most, his edges at most the few a farewell keeps.
    for (const p of [admin, bob, carol]) {
      expect(world.view(p, id)?.community?.hubs).toBeLessThanOrEqual(3);
      expect([...p.links.values()].filter(e => e.kind === "edge" && e.peer === daveKey).length).toBeLessThanOrEqual(1);
    }
    expect(world.texts(admin, id)).toEqual(expect.arrayContaining(["after the removal", "after the removal, too"]));
    // Once the commit gets through, he is told.
    world.drop = null;
    await world.until(() => world.view(dave, id)?.status === "removed", 12 * 60_000);
    expect(dave.groups.communities.isHub(id)).toBe(false);
  });

  it("is refused when it sends or reacts, and gets back in with the group's link, under the same key", async () => {
    const { world, admin, bob, dave, id, link, daveKey } = await removedWhileAway();
    await bob.groups.send(id, "while dave was out");
    await world.restart(dave);
    await world.until(() => world.view(dave, id)?.status === "removed", 90_000);
    expect(await dave.groups.send(id, "anyone?")).toEqual({ error: "You were removed from this group", refused: true });
    await expect(dave.groups.sendCommunityApp(id, { t: "reaction", id: "x", e: "👍", n: 1 })).rejects.toThrow("You were removed from this group");

    expect(await dave.groups.joinByLink(link)).toBe(id);
    // Knocking, as any joiner; his history stays.
    expect(world.view(dave, id)?.invitation).toMatchObject({ viaLink: true });
    await world.until(() => world.member(dave, id), 5 * 60_000);
    expect(world.view(dave, id)?.myKey).toBe(daveKey);
    expect(world.view(admin, id)?.members.map(m => m.key)).toContain(daveKey);
    await world.run(20_000);
    expect((await dave.groups.send(id, "dave is back")).error).toBeNull();
    await bob.groups.send(id, "welcome back");
    await world.run(10_000);
    expect(world.texts(admin, id)).toContain("dave is back");
    // He reads what comes after, what he read before, and nothing from between.
    expect(world.texts(dave, id)).toEqual(expect.arrayContaining(["dave, while a member", "dave is back", "welcome back"]));
    expect(world.texts(dave, id)).not.toContain("while dave was out");
    expect(dave.messages.filter(m => m.event === "joined" && m.text === "You joined again")).toHaveLength(1);
  });

  it("opening the link before it was told lets it in again all the same", async () => {
    const { world, admin, dave, id, link, daveKey } = await removedWhileAway();
    // The hubs' farewell never reaches him: his app still says he is a member when he opens the link.
    world.drop = (_, to, frame) => to === dave && frame.t === "group-commit";
    await world.restart(dave);
    await world.run(15_000);
    expect(world.view(dave, id)?.status).toBe("active");
    await dave.groups.joinByLink(link);
    world.drop = null;
    await world.until(() => world.view(admin, id)?.members.some(m => m.key === daveKey) === true && world.member(dave, id) && world.view(dave, id)?.members.length === 4, 5 * 60_000);
    await world.run(20_000);
    expect((await dave.groups.send(id, "in again")).error).toBeNull();
    await world.run(10_000);
    expect(world.texts(admin, id)).toContain("in again");
    // His history says what happened, in order: removed, then in again.
    const lines = dave.messages.filter(m => m.event === "removed" || (m.event === "joined" && !m.member)).sort((a, b) => a.timestamp - b.timestamp).map(m => m.text);
    expect(lines.slice(-2)).toEqual(["You were removed from this group", "You joined again"]);
  });

  it("is told although its clock runs minutes behind the admin's", async () => {
    const world = new CommunityWorld();
    const admin = world.add("admin"), bob = world.add("bob"), dave = world.add("dave");
    const id = await admin.groups.create("Open door");
    const link = await admin.groups.enableLink(id);
    for (const p of [bob, dave]) await p.groups.joinByLink(link);
    await world.until(() => [bob, dave].every(p => world.member(p, id)), 10 * 60_000);
    await world.run(20_000);
    const daveKey = world.view(dave, id)!.myKey!;
    dave.online = false;
    await world.run(5_000);
    // The commit carries the admin's time: three minutes ahead of everything Dave will write when he is back.
    await session(admin, id).remove(daveKey, world.now + 3 * 60_000);
    await world.run(10_000);
    await world.restart(dave);
    await world.until(() => world.view(dave, id)?.status === "removed", 90_000);
  });
});

describe("someone removed that still lists itself as a hub", { timeout: 120_000 }, () => {
  it("is not at the door: whoever opens the link is let in by a member, without waiting for its turn", async () => {
    for (let attempt = 0; ; attempt++) {
      const world = new CommunityWorld();
      const admin = world.add("admin"), others = [world.add("bob")];
      const id = await admin.groups.create("Open door");
      const link = await admin.groups.enableLink(id);
      for (const p of others) await p.groups.joinByLink(link);
      await world.until(() => others.every(p => world.member(p, id)), 10 * 60_000);
      await world.run(20_000);
      // With a key below the admin's, Bob would be the door once he has been a hub for a minute.
      const key = (p: Peer) => world.view(p, id)!.myKey!;
      const out = others[0], outKey = key(out);
      if (outKey > key(admin) && attempt < 40) continue;
      expect(outKey < key(admin)).toBe(true);
      out.online = false;
      await world.run(5_000);
      await admin.groups.remove(id, outKey);
      await world.run(10_000);
      // Never told (the commit is lost on the way): it comes back, becomes a hub of its own and lists itself.
      world.drop = (_, to, frame) => to === out && frame.t === "group-commit";
      await world.restart(out);
      await world.until(() => out.groups.communities.isHub(id), 3 * 60_000);
      await world.run(100_000);
      expect(out.groups.communities.isHub(id)).toBe(true);
      // Someone opens the link, out of its reach: the members' door answers.
      const erin = world.add("erin");
      // (It would answer the knock too, on the same entry session as the door, and neither would get through, until it
      // is told. This is about the members' side: here it does not see the knock.)
      const entry = decodeCommunityLink(link)!;
      const knocks = new Set([0, 1, 2, 3].map(n => knockIdentity({ g: `${entry.g}.${n}`, host: entry.host }).pubKeyZ32));
      world.failRead = (peer, k) => peer === out && knocks.has(k);
      await erin.groups.joinByLink(link);
      const took = await world.until(() => world.member(erin, id), 5 * 60_000);
      expect(took).toBeLessThan(60_000);
      expect(world.view(admin, id)?.members.map(m => m.key)).not.toContain(outKey);
      return;
    }
  });
});

describe("a member that opens the link of a community it is in", { timeout: 120_000 }, () => {
  it("asks the door, is told it is still in, and keeps what it has", async () => {
    const world = new CommunityWorld();
    const admin = world.add("admin"), bob = world.add("bob"), carol = world.add("carol");
    const id = await admin.groups.create("Open door");
    const link = await admin.groups.enableLink(id);
    // Alone in the group: nobody to ask, nothing happens.
    await admin.groups.joinByLink(link);
    expect((await admin.store.getGroups())[0].joining).toBeUndefined();
    for (const p of [bob, carol]) await p.groups.joinByLink(link);
    await world.until(() => [bob, carol].every(p => world.member(p, id)), 10 * 60_000);
    await world.run(60_000);
    await bob.groups.send(id, "before");
    await world.run(5_000);
    const before = session(carol, id);
    // The door itself asks too (its own knock is not one it answers), and whoever else is a hub tells it.
    const door = session(admin, id);
    const answered: string[] = [], openEntry = admin.host.openEntry;
    admin.host.openEntry = async (l, role, seed, other) => { if (role === "host") answered.push(other); return openEntry(l, role, seed, other); };
    await admin.groups.joinByLink(link);
    expect(await carol.groups.joinByLink(link)).toBe(id);
    // Still shown as the member it is while it asks.
    expect(world.view(carol, id)).toMatchObject({ status: "active", canSend: true });
    await world.run(60_000);
    expect((await carol.store.getGroups())[0].joining).toBeUndefined();
    expect(session(carol, id)).toBe(before);
    await world.run(3 * 60_000);
    expect((await admin.store.getGroups())[0].joining).toBeUndefined();
    expect(session(admin, id)).toBe(door);
    expect(answered).not.toContain(door.myKey);
    expect([...admin.links.values()].filter(e => e.kind !== "edge")).toEqual([]);
    expect(world.view(admin, id)?.members).toHaveLength(3);
    expect([...carol.links.values()].filter(e => e.kind === "guest")).toEqual([]);
    await carol.groups.send(id, "after");
    await world.run(5_000);
    expect(world.texts(admin, id)).toEqual(expect.arrayContaining(["before", "after"]));
  });

  it("stops asking after a while when nobody is at the door", async () => {
    const world = new CommunityWorld();
    const admin = world.add("admin"), bob = world.add("bob");
    const id = await admin.groups.create("Open door");
    const link = await admin.groups.enableLink(id);
    await bob.groups.joinByLink(link);
    await world.until(() => world.member(bob, id), 10 * 60_000);
    admin.online = false;
    await world.run(5_000);
    const before = session(bob, id);
    await bob.groups.joinByLink(link);
    expect((await bob.store.getGroups())[0].joining).toMatchObject({ check: true });
    await world.run(4 * 60_000);
    expect((await bob.store.getGroups())[0].joining).toBeUndefined();
    expect(session(bob, id)).toBe(before);
    expect(world.view(bob, id)?.status).toBe("active");
  });
});

describe("a community hub removed while its app is open", { timeout: 120_000 }, () => {
  it("gets back in through the link when it opens it at once", async () => {
    const world = new CommunityWorld(undefined, RELAY_NETWORK);
    const admin = world.add("admin");
    const id = await admin.groups.create("Open door");
    const link = await admin.groups.enableLink(id);
    await world.run(60_000);
    const others = ["bob", "carol", "dave", "erin"].map(name => world.add(name));
    for (const p of others) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 10 * 60_000, 500); }
    // A member that became a hub (with five members there are two).
    await world.until(() => others.some(p => p.groups.communities.isHub(id)), 10 * 60_000);
    const hub = others.find(p => p.groups.communities.isHub(id))!;
    await admin.groups.remove(id, world.view(hub, id)!.myKey!);
    await world.settle();
    expect(world.view(hub, id)!.status).toBe("removed");
    // It opens the link the moment it is told, before its engine's next tick (a bot that rejoins on being removed).
    await hub.groups.joinByLink(link);
    const took = await world.until(() => world.member(hub, id), 5 * 60_000);
    expect(took).toBeLessThanOrEqual(60_000);
    expect((await hub.groups.send(id, "back in")).error).toBeNull();
    await world.until(() => world.texts(admin, id).includes("back in"), 2 * 60_000);
    // Nobody is left running an entry session for it.
    await world.run(60_000);
    for (const p of [admin, ...others]) expect([...p.links.values()].filter(e => e.kind !== "edge"), p.name).toHaveLength(0);
  });
});
