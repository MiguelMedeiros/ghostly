import { describe, expect, it } from "vitest";
import { GroupSession, createIdentity, identityFromSeedB64 } from "@ghostly/core";
import type { GroupsHost } from "../src/engine/groups";
import { MeshHubs, STAND_INS, STAND_IN_MAX, UNREACHED_SAID, standInDuty } from "../src/engine/meshHubs";
import type { StoredGroup } from "../src/shared/types";

/**
 * Whom a private group's member keeps edges with on hubs, after `group-reach` frames (WISP 902 · Group Mesh § Hubs).
 * A real `MeshHubs` over the admin's real session of 20 members; the host stands in for the edges: the admin's hub `H`,
 * in the beacon it read, has its edge up.
 */

const NOW = 1_000_000;

async function adminOf20() {
  const state = GroupSession.create("Ghosts", NOW);
  const session = new GroupSession(state, { save: async () => {}, send: () => false, message: () => {}, edit: () => {}, changed: () => {} } as never);
  const keys: string[] = [];
  for (let i = 0; i < 19; i++) {
    const key = identityFromSeedB64(createIdentity().seedB64).pubKeyZ32;
    await session.admit(key);
    keys.push(key);
  }
  expect(session.roster.length).toBe(20);
  const [hub, mallory, ...members] = keys;
  const edges = new Map<string, string>([[hub, "e-hub"]]);
  const sent: { to: string; frame: { t: string; k: string[]; l?: string[] } }[] = [];
  const host = { edges: () => edges, linkReady: () => true, sendOnLink: (id: string, frame: never) => { sent.push({ to: id, frame }); } } as unknown as GroupsHost;
  const group: StoredGroup = { id: session.groupId, createdAt: NOW, state: session.state } as unknown as StoredGroup;
  let saves = 0;
  const mesh = new MeshHubs(host, { stored: () => group, save: () => { saves++; } });
  // The admin read this epoch's beacon: `H` is its only hub, and its edge is up.
  const live = (mesh as unknown as { get(groupId: string, now: number): { beacon: unknown[]; firstRead: boolean; epochRead: boolean; myHubs: string[]; hub: boolean } }).get(session.groupId, NOW);
  Object.assign(live, { beacon: [{ key: hub, ts: NOW, load: 18, since: NOW - 60_000 }], firstRead: true, epochRead: true, myHubs: [hub] });
  const wanted = (now = NOW) => [...mesh.wanted(session.groupId, session, group, now) ?? new Set(session.others)].sort();
  const reach = (from: string, k: string[], l?: string[], now = NOW) => mesh.reached(session.groupId, session, from, { t: "group-reach", g: session.groupId, k, ...(l && { l }) }, now);
  return { session, group, mesh, live, hub, mallory, members, edges, sent, wanted, reach, saves: () => saves };
}

describe("a private group's `group-reach` is taken from its hubs, and only about their own edges", () => {
  it("a member that is no hub in the beacon moves no edge of the admin's, and is no hub for it", async () => {
    const { session, group, mesh, hub, mallory, members, wanted, reach, saves } = await adminOf20();
    expect(wanted()).toEqual([hub]);
    // Mallory says she reaches everyone and that every other member's app takes no hubs.
    reach(mallory, session.others, session.others.filter(key => key !== mallory));
    expect(wanted()).toEqual([hub]);
    expect(group.legacy ?? []).toEqual([]);
    expect(saves()).toBe(0);
    expect(mesh.hubs(session.groupId, session, NOW)).toEqual([hub]);
    // Said again a while later, it is still nobody's word.
    reach(mallory, session.others, members, NOW + 30_000);
    expect(wanted(NOW + 30_000)).toEqual([hub]);
  });

  it("a hub of the beacon names only members on its own edges, and none whose own edge said it takes hubs", async () => {
    const { session, group, hub, members: [legacy, honest, far, ...rest], wanted, reach, mesh, edges } = await adminOf20();
    // `honest`'s edge came up here once, its app announcing hubs.
    edges.set(honest, "e-honest");
    mesh.edgeReady(session.groupId, session, group, honest, true, NOW);
    edges.delete(honest);
    reach(hub, [legacy, honest, ...rest], [legacy, honest, far]);
    expect(wanted()).toEqual([hub, legacy].sort());
    // Not saved: the hub's word holds while it counts as one.
    expect(group.legacy ?? []).toEqual([]);
  });

  it("a hub says of its edges' apps only those on edges it holds", async () => {
    const { session, group, mesh, live, members: [up, away], edges, sent } = await adminOf20();
    live.hub = true;
    edges.set(up, "e-up");
    group.legacy = [up, away];
    (mesh as unknown as { sayReach(groupId: string, session: GroupSession, live: unknown, now: number): void }).sayReach(session.groupId, session, live, NOW);
    expect(sent.length).toBeGreaterThan(0);
    for (const { frame } of sent) expect(frame.l).toEqual([up]);
  });

  it("before any reading of the beacon, a member that says it is a hub is one only until the reading", async () => {
    const { session, mesh, live, hub, mallory, members, wanted, reach } = await adminOf20();
    Object.assign(live, { epochRead: false });
    reach(mallory, session.others, members);
    expect(mesh.hubs(session.groupId, session, NOW)).toContain(mallory);
    // Her word on other members' apps is not taken meanwhile.
    expect(wanted()).toEqual([hub]);
    // The reading does not list her: no hub.
    (mesh as unknown as { noteHubs(live: unknown, session: GroupSession, now: number): void }).noteHubs(Object.assign(live, { epochRead: true }), session, NOW + 1);
    expect(mesh.hubs(session.groupId, session, NOW + 1)).toEqual([hub]);
    reach(mallory, session.others, members, NOW + 5_000);
    expect(mesh.hubs(session.groupId, session, NOW + 5_000)).toEqual([hub]);
  });
});

describe("stand-ins for the members no hub reaches (`u`, WISP 902 · Group Mesh § Hubs, Stand-ins)", () => {
  const keys = (n: number) => Array.from({ length: n }, () => identityFromSeedB64(createIdentity().seedB64).pubKeyZ32);

  it("each lost member gets its stand-ins by rank, and no member stands in for more than four", () => {
    const [lost, standing] = [keys(6), keys(4)];
    const duty = standInDuty(lost, standing);
    for (const mine of duty.values()) expect(mine.length).toBeLessThanOrEqual(STAND_IN_MAX);
    // Room for all: 6 lost by 2 stand-ins, 4 members by 4 (the last lost one still finds two members with room).
    for (const key of lost) expect([...duty.values()].filter(mine => mine.includes(key))).toHaveLength(STAND_INS);
    // More lost than the members' room: what is left goes unanswered, nobody takes more.
    const more = keys(10), crowded = standInDuty(more, standing);
    for (const mine of crowded.values()) expect(mine.length).toBe(STAND_IN_MAX);
    // Every member works out the same, whatever order it holds them in.
    expect(standInDuty([...more].reverse(), [...standing].reverse())).toEqual(crowded);
  });

  it("a member ranked for six lost members keeps an edge for four of them only", async () => {
    const { session, group, hub, mallory, members, wanted, mesh } = await adminOf20();
    // Six members nobody reaches; besides the admin, only `other` can stand in (the rest are apps without hubs).
    const lost = members.slice(0, 6), other = members[6], old = [mallory, ...members.slice(7)];
    group.legacy = old;
    mesh.reached(session.groupId, session, hub, { t: "group-reach", g: session.groupId, k: [session.myKey, other, ...old], u: lost }, NOW);
    const standing = wanted().filter(key => lost.includes(key));
    expect(standing).toHaveLength(STAND_IN_MAX);
    expect(standing).toEqual([...standInDuty(lost, [session.myKey, other]).get(session.myKey)!].sort());
    // Nothing else moved: its hub and the apps without hubs, as before.
    expect(wanted().filter(key => !lost.includes(key))).toEqual([hub, ...old].sort());
  });

  it("`u` is taken from a hub of the beacon only, about members it does not reach, and not when longer than a hub says", async () => {
    const { session, hub, mallory, members, wanted, mesh } = await adminOf20();
    const say = (from: string, k: string[], u: string[], now: number) => mesh.reached(session.groupId, session, from, { t: "group-reach", g: session.groupId, k, u }, now);
    const lost = members.slice(0, 3);
    // Mallory is no hub in the beacon: her word moves no edge.
    say(mallory, [session.myKey], members, NOW);
    expect(wanted()).toEqual([hub]);
    // The hub says it reaches them itself: nobody is lost.
    say(hub, [session.myKey, ...members], members, NOW);
    expect(wanted()).toEqual([hub]);
    // Longer than a hub ever says: not taken.
    say(hub, [session.myKey], [...lost, ...Array.from({ length: UNREACHED_SAID }, () => lost[0])], NOW + 10_000);
    expect(wanted(NOW + 10_000)).toEqual([hub]);
    // Said right, the admin stands in for those it is ranked for.
    say(hub, [session.myKey], lost, NOW + 20_000);
    const standing = session.roster.map(([key]) => key).filter(key => key !== hub && !lost.includes(key));
    const mine = standInDuty(lost, standing).get(session.myKey) ?? [];
    expect(wanted(NOW + 20_000)).toEqual([hub, ...mine].sort());
  });
});
