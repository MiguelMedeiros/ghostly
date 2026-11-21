import { afterEach, describe, expect, it } from "vitest";
import { GROUP_PROFILE, commitUntaggedHash, confirmationTag, epochKeys, identityFromSeedB64, newEpochSecret, randomBytes, signCommit, toBase64Url, type GroupCommit, type GroupState } from "@ghostly/core";
import { GroupPayments, paymentsMembership, type GroupPaymentsHost } from "../src/engine/groupPayments";
import type { GroupPayFrame, PaymentView } from "../src/shared/types";
import { CommunityWorld, sameRun, seededRandom, type Peer } from "./communityWorld";
// covers: groups.payments.group-request, groups.payments.notes

/**
 * A request to a group belongs to the membership it was made in (WISP 902 § Payments). A member who leaves (or
 * deletes the group, or switches to another group under its id) and later is in a group under the same id again,
 * with a new member key, never says that old request there: not in the same run (what was kept of the notes goes
 * with the history), and not after a restart (a record of its own made before this membership began is not said).
 * Before, the open request came back after a restart under the new key, to members who joined since or to the other
 * group's members, while the members who stayed kept the old one.
 *
 * Engine groups on the CommunityWorld, each peer with GroupPayments wired as node.ts wires it: the membership from the
 * group's view (`paymentsMembership`), notes over the edges, the group's history as its notes' store, and the
 * history's end (`historyGone`) forgetting the notes.
 */

interface Pay { engine: GroupPayments; payments: PaymentView[]; said: { to: string; frame: GroupPayFrame }[] }

const MEMO = "old trip fuel";

function setup(seed: number) {
  const world = new CommunityWorld(undefined, null, seededRandom(seed));
  const restore = sameRun(world, seed);
  const pays = new Map<Peer, Pay>();
  const inFlight: Promise<unknown>[] = [];
  const engineFor = (peer: Peer, pay: Pay) => {
    const host: GroupPaymentsHost = {
      payments: () => pay.payments,
      edgeOf: linkId => { const e = peer.links.get(linkId); return e?.kind === "edge" ? { groupId: e.g, member: e.peer } : undefined; },
      edges: g => peer.host.edges(g),
      membership: g => paymentsMembership(world.view(peer, g)),
      send: (linkId, frame) => {
        const e = peer.links.get(linkId);
        if (!e || !peer.host.linkReady(linkId)) throw new Error("link down");
        const there = [...world.peers.values()].find(p => [...p.links.values()].some(o => o.kind === "edge" && o.g === e.g && o.me === e.peer && o.peer === e.me));
        if (!there) throw new Error("nobody there");
        pay.said.push({ to: there.name, frame: structuredClone(frame) as GroupPayFrame });
        inFlight.push(pays.get(there)!.engine.receive(e.g, e.me, structuredClone(frame)));
      },
      messages: async g => peer.messages.filter(m => m.linkId === `group:${g}`),
      putMessage: async message => {
        const at = peer.messages.findIndex(m => m.linkId === message.linkId && m.id === message.id);
        if (at >= 0) peer.messages[at] = message; else peer.messages.push(message);
      },
    };
    return new GroupPayments(host);
  };
  // As node.ts: an edge that comes up hears my notes again (`groups.edgeReady`, then `groupPayments.edgeReady`).
  const hook = (peer: Peer) => {
    const groups = peer.groups, ready = groups.edgeReady.bind(groups);
    groups.edgeReady = (g, key, linkId) => { ready(g, key, linkId); inFlight.push(pays.get(peer)!.engine.edgeReady(g, linkId)); };
  };
  const add = (name: string) => {
    const pay = { payments: [], said: [] } as unknown as Pay;
    // As node.ts's `groupHistoryGone`: every way a group ends here forgets what its notes kept.
    const peer = world.add(name, () => ({ historyGone: g => { pay.engine.forget(g); } }));
    pay.engine = engineFor(peer, pay);
    pays.set(peer, pay);
    hook(peer);
    return peer;
  };
  /** The app starts again: a new engine for its groups and its group payments, on what it stored. */
  const restart = async (peer: Peer) => {
    await world.restart(peer);
    const pay = pays.get(peer)!;
    pay.engine = engineFor(peer, pay);
    hook(peer);
    await pay.engine.sync();
  };
  const drain = async () => { for (let i = 0; i < 20 && inFlight.length; i++) await Promise.allSettled(inFlight.splice(0)); };
  const run = async (ms: number) => { for (let t = 0; t < ms; t += 5_000) { await world.run(5_000); await drain(); } };
  const lines = (peer: Peer, g: string) => peer.messages.filter(m => m.linkId === `group:${g}` && m.groupPay).map(m => m.groupPay!);
  const request = (peer: Peer, g: string, id: string, memo: string): PaymentView =>
    ({ id, linkId: `group:${g}`, group: g, kind: "request", direction: "out", amount: 2100, unit: "sat", memo, state: "pending", createdAt: world.now, mints: ["https://testnut.cashu.space"] });
  return { world, restore, pays, add, restart, drain, run, lines, request };
}

async function joined(s: ReturnType<typeof setup>, peer: Peer, link: string, g: string) {
  await peer.groups.joinByLink(link);
  await s.world.until(() => s.world.member(peer, g), 5 * 60_000);
}

describe("a request to a group stays in the membership it was made in", { timeout: 240_000 }, () => {
  let restore: (() => void) | null = null;
  afterEach(() => { restore?.(); restore = null; });

  for (const seed of [11, 22, 33]) {
    it(`seed ${seed}: left and joined again by the link, the old open request is not said again, in this run or after a restart`, async () => {
      const s = setup(seed);
      restore = s.restore;
      const { world, pays, add, run, lines } = s;
      const admin = add("admin"), bob = add("bob"), carol = add("carol"), dave = add("dave");
      const g = await admin.groups.create("Trip", "mesh");
      const link = await admin.groups.enableLink(g);
      for (const p of [bob, carol]) await joined(s, p, link, g);
      await world.until(() => [admin, bob, carol].every(p => world.view(p, g)!.members.length === 3), 2 * 60_000);
      await run(30_000);
      const oldBob = world.view(bob, g)!.myKey!;

      // Bob asks the group; every member shows it.
      pays.get(bob)!.payments.push(s.request(bob, g, "req-bob-0001", MEMO));
      await pays.get(bob)!.engine.sync();
      await run(10_000);
      for (const p of [admin, carol]) expect(lines(p, g), p.name).toEqual([expect.objectContaining({ id: "req-bob-0001", to: oldBob, state: "open", memo: MEMO })]);
      expect(lines(bob, g)).toEqual([expect.objectContaining({ id: "req-bob-0001", to: oldBob, state: "open" })]);

      // Bob leaves: his history goes, its payment rows with it.
      await bob.groups.leave(g);
      await run(30_000);
      expect(bob.messages.filter(m => m.linkId === `group:${g}`), "the left group's rows are gone").toEqual([]);
      expect(world.view(admin, g)!.members.map(m => m.key)).not.toContain(oldBob);

      // Dave joins; Bob joins again by the link, under a new key.
      await joined(s, dave, link, g);
      pays.get(bob)!.said.length = 0;
      await joined(s, bob, link, g);
      const newBob = world.view(bob, g)!.myKey!;
      expect(newBob).not.toBe(oldBob);
      await world.until(() => [admin, bob, carol, dave].every(p => world.view(p, g)!.members.length === 4), 3 * 60_000);
      await run(60_000);
      await pays.get(bob)!.engine.sync();
      await run(10_000);
      const told = () => pays.get(bob)!.said.filter(x => x.frame.id === "req-bob-0001").map(x => `${x.to}:${x.frame.st}`);
      expect.soft(told(), "same run: the old request is said to nobody").toEqual([]);
      pays.get(bob)!.said.length = 0;

      // Bob's app starts again: still nobody hears it, and no history shows it under his new key.
      await s.restart(bob);
      await run(90_000);
      await pays.get(bob)!.engine.sync();
      await run(10_000);
      expect.soft(told(), "after a restart: the old request is said to nobody").toEqual([]);
      expect.soft(lines(dave, g), "the newcomer never sees it").toEqual([]);
      expect.soft(lines(bob, g), "nor does Bob's own history").toEqual([]);
      // The members who stayed keep the line as it was, under the key Bob had then.
      for (const p of [admin, carol]) expect(lines(p, g), p.name).toEqual([expect.objectContaining({ id: "req-bob-0001", to: oldBob, state: "open" })]);

      // Control: a request Bob makes in this membership is said as any is, to everyone in it.
      pays.get(bob)!.payments.push(s.request(bob, g, "req-bob-0002", "new trip fuel"));
      await pays.get(bob)!.engine.sync();
      await run(10_000);
      for (const p of [admin, carol, dave, bob]) expect(lines(p, g).filter(n => n.id === "req-bob-0002"), p.name).toEqual([expect.objectContaining({ to: newBob, state: "open", memo: "new trip fuel" })]);
    });
  }

  it("switched to another group under the same id: the held group's request is not told to the other group's members", async () => {
    const s = setup(44);
    restore = s.restore;
    const { world, pays, add, run, lines } = s;
    const admin = add("admin"), bob = add("bob"), carol = add("carol"), other = add("other"), olga = add("olga");
    const g = await admin.groups.create("Flat", "mesh");
    const link = await admin.groups.enableLink(g);
    for (const p of [bob, carol]) await joined(s, p, link, g);
    await world.until(() => [admin, bob, carol].every(p => world.view(p, g)!.members.length === 3), 2 * 60_000);
    await run(30_000);
    pays.get(bob)!.payments.push(s.request(bob, g, "req-bob-0003", "held group's rent"));
    await pays.get(bob)!.engine.sync();
    await run(10_000);
    expect(lines(carol, g)).toEqual([expect.objectContaining({ id: "req-bob-0003", state: "open" })]);

    // Someone else holds a group of their own under that id, with Olga in it.
    await other.store.putGroup({ id: g, createdAt: world.now, state: genesisUnder(g, "Flat", world.now), contacts: {} });
    await s.restart(other);
    const copy = await other.groups.enableLink(g);
    await joined(s, olga, copy, g);
    // Bob opens that group's link: shown beside the one he holds; he switches to it.
    expect(await bob.groups.joinByLink(copy)).toBe(g);
    expect(world.view(bob, g)?.others).toEqual([expect.objectContaining({ link: copy })]);
    pays.get(bob)!.said.length = 0;
    await bob.groups.switchGroup(g, copy);
    await world.until(() => world.member(bob, g) && world.view(bob, g)!.members.some(m => m.key === world.view(other, g)!.myKey), 5 * 60_000);
    await world.until(() => [other, olga].every(p => world.view(p, g)!.members.length === 3), 3 * 60_000);
    await run(60_000);
    await pays.get(bob)!.engine.sync();
    await run(10_000);
    const told = () => pays.get(bob)!.said.filter(x => x.frame.id === "req-bob-0003").map(x => x.to);
    expect.soft(told(), "same run: the held group's request goes to nobody").toEqual([]);
    pays.get(bob)!.said.length = 0;
    await s.restart(bob);
    await run(90_000);
    await pays.get(bob)!.engine.sync();
    await run(10_000);
    expect.soft(told(), "after a restart: the held group's request goes to nobody").toEqual([]);
    for (const p of [other, olga, bob]) expect.soft(lines(p, g), p.name).toEqual([]);
    expect(lines(carol, g), "the held group's member keeps it").toEqual([expect.objectContaining({ id: "req-bob-0003" })]);
  });
});

/** A group of someone's own under an id they chose: a genesis signed under it, as GroupSession.create signs one under a random id. */
function genesisUnder(id: string, name: string, now: number): GroupState {
  const identity = identityFromSeedB64(toBase64Url(randomBytes(32)));
  const secret = newEpochSecret();
  const draft: Omit<GroupCommit, "sig" | "c"> = { v: 1, g: id, e: 0, p: "", k: "create", m: [[identity.pubKeyZ32, "admin"]], by: identity.pubKeyZ32, ts: now };
  const commit = signCommit({ ...draft, c: confirmationTag(epochKeys(secret, id, 0).confirm, commitUntaggedHash(draft)) }, identity.seed);
  return { id, name, profile: GROUP_PROFILE, seedB64: identity.seedB64, createdAt: now, chain: [commit],
    secrets: { 0: toBase64Url(secret) }, status: "active", seq: 0, seqEpoch: 0, sent: [], seen: {}, nicks: {} } as GroupState;
}
