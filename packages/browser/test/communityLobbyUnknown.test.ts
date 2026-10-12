import { describe, expect, it } from "vitest";
import { createIdentity, lobbyKeys, lobbyRecords, rosterHas } from "@ghostly/core";
import type { Groups } from "../src/engine/groups";
import { CommunityWorld, type Peer } from "./communityWorld";
// covers: groups.community.remove, groups.community.join, groups.community.send, groups.protocol.community-topology

/**
 * A key asking in a hub's lobby that no commit the hub holds names (WISP 903 · Group Community § Removed while away,
 * A key no commit names): it may be a member let in by a commit the hub has not heard yet, so it gets an edge for a
 * moment, on which the hub says where it is and takes commits. It is no member of the hub's: nothing the group says
 * is relayed to it, it takes no place among the hub's members, and the edge ends unless a commit names the key.
 */
const session = (peer: Peer, id: string) => peer.groups.communities.session(id)!;
const keyOf = (peer: Peer, id: string) => session(peer, id).myKey;
const isHub = (peer: Peer, id: string) => peer.groups.communities.isHub(id);
const membersOf = (hub: Peer, id: string) => [...(hub.groups.communities as unknown as { live: Map<string, { members: Map<string, number> }> }).live.get(id)!.members.keys()];
const edgeTo = (peer: Peer, key: string) => [...peer.links.values()].find(e => e.kind === "edge" && e.peer === key);

async function threeMembers(): Promise<{ world: CommunityWorld; admin: Peer; bob: Peer; carol: Peer; id: string; link: string }> {
  const world = new CommunityWorld();
  const admin = world.add("admin"), bob = world.add("bob"), carol = world.add("carol");
  const id = await admin.groups.create("Lobby");
  const link = await admin.groups.enableLink(id);
  for (const p of [bob, carol]) { await p.groups.joinByLink(link); await world.until(() => world.member(p, id), 5 * 60_000); }
  await world.run(2 * 60_000);
  return { world, admin, bob, carol, id, link };
}

/** An app that holds the group's rendezvous secret and a key of its own making: it opens its side of an edge to `hub`, and keeps what comes. */
function stranger(world: CommunityWorld, id: string, hub: Peer): { key: string; heard: Record<string, unknown>[]; ask: () => void } {
  const key = createIdentity().pubKeyZ32, hubKey = keyOf(hub, id), heard: Record<string, unknown>[] = [];
  const groups = {
    tick: async () => {}, communityIdle: async () => {}, isCommunityGroup: () => true, meshSize: () => 0,
    fileSession: () => {}, edgeReady: () => {}, filesFrame: async () => {},
    handleEdgeFrame: async (_g: string, _from: string, frame: Record<string, unknown>) => { heard.push(frame); },
  } as unknown as Groups;
  const peer = { name: "stranger", groups, links: new Map(), online: true, nick: "stranger", sent: { frames: 0, bytes: 0 }, spent: [], spentBackground: [], refused: 0, messages: [] } as unknown as Peer;
  peer.links.set("edge:stranger", { g: id, me: key, peer: hubKey, kind: "edge", announced: false, openedAt: world.now, fastUntil: 0, lastPoll: -Infinity, polls: 0 });
  world.peers.set("stranger", peer);
  const lobby = lobbyKeys(session(hub, id).state.rv, id, hubKey);
  return { key, heard, ask: () => { world.pkarr.set(lobby.identity.pubKeyZ32, lobbyRecords(lobby, [{ key, ts: world.now }])); } };
}

describe("a key no commit names, asking in a hub's lobby", { timeout: 120_000 }, () => {
  it("hears nothing the group says, takes no place among the hub's members, and keeps no edge", async () => {
    const { world, admin, bob, carol, id } = await threeMembers();
    const hub = [admin, bob, carol].find(p => isHub(p, id))!, others = [admin, bob, carol].filter(p => p !== hub);
    const before = membersOf(hub, id).length;
    const { key, heard, ask } = stranger(world, id, hub);

    // It asks, and goes on asking, while the group talks and its admin changes the link.
    ask();
    await world.until(() => !!edgeTo(hub, key), 60_000);
    for (let i = 0; i < 6; i++) {
      ask();
      for (const p of others) await p.groups.send(id, `${p.name} says ${i}`);
      await hub.groups.send(id, `the hub says ${i}`);
      if (i === 2) await admin.groups.enableLink(id, true);
      await world.run(5_000);
      expect(membersOf(hub, id), "the hub's members").not.toContain(key);
      expect(membersOf(hub, id).length).toBeLessThanOrEqual(before);
    }
    for (const p of [admin, bob, carol]) expect(world.texts(p, id)).toContain("the hub says 5");
    // Where the hub is (its question to someone who may be ahead of it), and nothing else.
    expect(new Set(heard.map(f => f.t))).toEqual(new Set(["group-sync"]));

    // The edge ends, and asking again does not bring it back at once.
    for (let s = 0; s < 4 * 60; s += 5) { ask(); await world.run(5_000); if (!edgeTo(hub, key)) break; }
    expect(edgeTo(hub, key), "the hub's edge to the key").toBeUndefined();
    ask();
    await world.run(30_000);
    expect(edgeTo(hub, key)).toBeUndefined();
    expect(membersOf(hub, id)).not.toContain(key);
    expect(new Set(heard.map(f => f.t))).toEqual(new Set(["group-sync"]));
  });

  it("a hub keeps a few such edges at a time, whatever its lobby says", async () => {
    const { world, admin, bob, carol, id } = await threeMembers();
    const hub = [admin, bob, carol].find(p => isHub(p, id))!;
    const lobby = lobbyKeys(session(hub, id).state.rv, id, keyOf(hub, id));
    const made = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const keys = Array.from({ length: 6 }, () => createIdentity().pubKeyZ32);
      for (const k of keys) made.add(k);
      world.pkarr.set(lobby.identity.pubKeyZ32, lobbyRecords(lobby, keys.map(key => ({ key, ts: world.now }))));
      await world.run(10_000);
      expect([...hub.links.values()].filter(e => e.kind === "edge" && made.has(e.peer)).length).toBeLessThanOrEqual(4);
      expect(membersOf(hub, id).filter(k => made.has(k))).toEqual([]);
    }
  });

  it("a member one commit ahead of the hub still gets its edge, and the hub the commit", async () => {
    const { world, admin, bob, carol, id, link } = await threeMembers();
    const all = [admin, bob, carol];
    // The hub that was not at the door falls behind: the commit that lets Erin in never reaches it.
    const erin = world.add("erin");
    world.drop = (from, to, frame) => from !== erin && frame.t === "group-commit" && (frame.commit as { k?: string }).k === "add" && all.includes(to) && isHub(to, id);
    await erin.groups.joinByLink(link);
    await world.until(() => world.member(erin, id), 5 * 60_000);
    const erinKey = keyOf(erin, id);
    const hub = all.find(p => isHub(p, id) && !rosterHas(session(p, id).roster, erinKey))!;
    expect(hub, "a hub that does not know her").toBeDefined();
    world.drop = (from, to, frame) => to === hub && from !== erin && frame.t === "group-commit";

    // Her hub goes; the one left does not know her, and she asks in its lobby.
    for (const p of all) if (p !== hub) p.online = false;
    await world.until(() => rosterHas(session(hub, id).roster, erinKey), 10 * 60_000);
    await world.until(() => membersOf(hub, id).includes(erinKey) || isHub(erin, id), 5 * 60_000);
    await erin.groups.send(id, "erin, through the hub that was behind");
    await world.until(() => world.texts(hub, id).includes("erin, through the hub that was behind"), 2 * 60_000);
    await hub.groups.send(id, "and back");
    await world.until(() => world.texts(erin, id).includes("and back"), 2 * 60_000);
  });
});
