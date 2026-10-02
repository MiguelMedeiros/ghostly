import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostLink, createIdentity, type GroupCommit, type GroupEdgeFrame, type GroupSession } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { FAREWELL_OPEN_MS, type Groups, type GroupsHost } from "../src/engine/groups";
import { MeshHubs, removalEpoch } from "../src/engine/meshHubs";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { StoredLink } from "../src/shared/types";
// covers: groups.remove-member, groups.payments.group-request, groups.payments.notes, groups.protocol.reactions, groups.protocol.pins

/**
 * What a private group says goes to its members as the roster has them now, and to nobody else (WISP 9xx · Group Mesh
 * § Admission and departure). A real engine (`GhostlyNode`, with its group engine, payment desk, group payments,
 * reactions, pins and wake-ups) is the admin; each member is the engine's own edge to it, whose connection the test
 * stands in for: it says when the edge is open and what the member's app announces, and writes down every call that
 * would put something on the wire. The fan-outs of the engine run as in the app; only the socket is missing.
 */

Object.defineProperty(globalThis.navigator, "storage", { value: { estimate: async () => ({ quota: 50 * 1024 ** 3, usage: 10 * 1024 ** 3 }) }, configurable: true });

interface Sent { via: string; args: unknown[] }
interface EdgeEvents {
  onGroupFrame(frame: unknown): unknown;
  onGroupsSupport(supported: boolean): void;
  onDataLinkState(state: "open" | "closed"): void;
  onPeerNick(nick: string | null): void;
  onPaymentRequest(request: unknown): unknown;
  onPayment(payment: unknown): unknown;
}
interface Member { key: string; linkId: string; sent: Sent[]; events: EdgeEvents; wire: { open: boolean; groups: boolean }; comeUp(groups?: boolean): Promise<void> }
interface Inner {
  links: Map<string, { stored: StoredLink; link?: GhostLink }>;
  groups: Groups & { sessions: Map<string, GroupSession>; tick(now?: number): Promise<void> };
  settings: Record<string, unknown>;
  desk: { lightning: Record<string, { createInvoice(amount: number, id: string): Promise<{ invoice: string }> }>; close(id: string, reason: string, told: string): Promise<boolean> };
  groupPayments: { sync(): Promise<void> };
  setGroupWakeMuted(groupId: string, muted: boolean): Promise<void>;
}

const nodes: GhostlyNode[] = [];
beforeEach(async () => {
  const names = Object.values(STORES) as string[];
  await transact(names as never, (s: Record<string, { clear(): void }>) => { for (const name of names) s[name].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); });

const settle = async (ms = 40) => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, ms / 4)); };

/** Every method of the link that puts something on the wire is written down instead, while the stand-in connection is open. */
function standIn(link: GhostLink, wire: Member["wire"], sent: Sent[]): void {
  const define = (name: string, get: () => unknown) => Object.defineProperty(link, name, { get, configurable: true });
  define("isDataLinkOpen", () => wire.open);
  define("groupsSupport", () => wire.open && wire.groups);
  define("supportsPayments", () => wire.open);
  const set = (name: string, value: unknown) => Object.defineProperty(link, name, { value, configurable: true, writable: true });
  set("supportsGroupVersion", () => wire.open && wire.groups);
  set("allowsPayment", () => true);
  for (const name of Object.getOwnPropertyNames(GhostLink.prototype)) {
    if (!/^send[A-Z]/.test(name) || typeof Object.getOwnPropertyDescriptor(GhostLink.prototype, name)?.value !== "function") continue;
    set(name, (...args: unknown[]) => {
      if (name === "sendGroupFrame" && !(wire.open && wire.groups)) throw new Error("This contact is not connected, or needs an updated Ghostly for groups");
      if (wire.open) sent.push({ via: name, args: structuredClone(args) });
      return undefined;
    });
  }
}

async function adminOf(names: string[]) {
  await db.putSettings({ online: true, nick: "Admin", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() } as never, { transport, automaticWallets: false });
  nodes.push(node);
  await node.start();
  const inner = node as unknown as Inner;
  const { groupId } = await node.createGroup({ name: "Ghosts", profile: "mesh" });
  const session = inner.groups.sessions.get(groupId)!;
  const edgeOf = (key: string) => [...inner.links.values()].find(live => live.stored.group === groupId && live.stored.groupPeer === key && !live.stored.groupEntry);

  /** A member admitted, and the admin's edge to it stood in for; `up`: its app is there now. */
  const admit = async (up = true): Promise<Member> => {
    const key = createIdentity().pubKeyZ32;
    await session.admit(key);
    await vi.waitFor(() => expect(edgeOf(key)?.link).toBeDefined());
    const live = edgeOf(key)!, link = live.link!;
    const sent: Sent[] = [], wire = { open: false, groups: true };
    standIn(link, wire, sent);
    const events = (link as unknown as { options: { events: EdgeEvents } }).options.events;
    const member: Member = { key, linkId: live.stored.id, sent, events, wire,
      comeUp: async (groups = true) => { wire.open = true; wire.groups = groups; events.onDataLinkState("open"); if (groups) events.onGroupsSupport(true); await settle(); } };
    if (up) await member.comeUp();
    return member;
  };
  const members: Member[] = [];
  for (const name of names) members.push(await admit(name !== "away"));
  return { node, inner, groupId, session, members, admit, edgeOf };
}

const frames = (member: Member) => member.sent.filter(s => s.via === "sendGroupFrame").map(s => s.args[0] as { t: string; commit?: { e: number; m: [string][] } });
const kinds = (member: Member) => [...new Set(member.sent.map(s => s.via === "sendGroupFrame" ? (s.args[0] as { t: string }).t : s.via))].sort();

/** Everything a group says in a day: each of these goes over the edge of every member. */
async function busy(a: Awaited<ReturnType<typeof adminOf>>, other: Member) {
  const { node, inner, groupId } = a;
  const chat = `group:${groupId}`;
  const said = await node.sendGroupMessage({ groupId, text: "after the removal" });
  expect(said.error).toBeNull();
  const messageId = (said as { messageId: string }).messageId;
  expect((await node.editMessage({ linkId: chat, messageId, text: "after the removal, edited" })).error).toBeNull();
  expect((await node.react({ linkId: chat, messageId, emoji: "👍" })).error).toBeNull();
  expect((await node.pinMessage({ linkId: chat, messageId })).error).toBeNull();
  // A request to the whole group, then closed: the request and its result go to every member; the note about it too.
  for (const lightning of Object.values(inner.desk.lightning)) lightning.createInvoice = async () => ({ invoice: "lnbc1test" });
  const { paymentId } = await node.requestGroupPayment({ groupId, amount: 21, memo: "pizza", timestamp: Date.now(), rail: "lightning" });
  await inner.groupPayments.sync();
  expect(await inner.desk.close(paymentId, "closed here", "closed")).toBe(true);
  await inner.groupPayments.sync();
  // Muted, then not: members are told to forget how to wake this app, then how to.
  await inner.setGroupWakeMuted(groupId, true);
  await inner.setGroupWakeMuted(groupId, false);
  await node.renameGroup({ groupId, name: "Ghosts, renamed" });
  await node.updateSettings({ settings: { nick: "Admin, renamed" } });
  // Another member's reaction arrives.
  await other.events.onGroupFrame({ t: "group-react", g: groupId, id: messageId, e: "🎉", n: 1 });
  await settle();
  return { messageId };
}

describe("a private group's traffic goes to its current members only", () => {
  it("a member removed while away gets the commits up to its removal over the kept edge, and nothing else", async () => {
    const a = await adminOf(["bob", "away"]);
    const { node, inner, groupId, session, members: [bob, gone] } = a;
    inner.settings.wake = { endpoint: "https://push.test/abc", p256dh: "p", auth: "a" };
    await node.sendGroupMessage({ groupId, text: "before" });
    const removedAt = session.epoch + 1;
    await node.removeGroupMember({ groupId, key: gone.key });
    await settle();
    // The edge to the removed member is kept, to tell it; its app comes back and announces everything an app can.
    expect(a.edgeOf(gone.key)).toBeDefined();
    bob.sent.length = 0;
    await gone.comeUp();
    await busy(a, bob);
    // Someone else joins, and the keys rotate: two more commits.
    const carol = await a.admit();
    await node.rotateGroup({ groupId });
    await settle();
    // What the removed member's app says on that edge changes nothing here.
    const state = () => JSON.stringify([session.state.nicks, session.roster, session.epoch, inner.links.get(gone.linkId)!.stored.peerWake ?? null]);
    const before = state();
    gone.events.onPeerNick("Not Gone");
    await gone.events.onGroupFrame({ t: "group-typing", g: groupId, e: session.epoch, c: "x", n: "y" });
    await gone.events.onGroupFrame({ t: "group-react", g: groupId, id: `${bob.key}:1:0`, e: "😈", n: 9 });
    await gone.events.onGroupFrame({ t: "group-wake", g: groupId, w: { endpoint: "https://push.test/evil", p256dh: "p", auth: "a", token: "t" } });
    await gone.events.onGroupFrame({ t: "group-pay", g: groupId, id: "x", k: "request" });
    await gone.events.onGroupFrame({ t: "group-leave", g: groupId });
    await gone.events.onPaymentRequest({ id: "evil", timestamp: Date.now(), amount: { value: "1", asset: "sat" }, endpoints: [] });
    await gone.events.onGroupFrame({ t: "group-sync", g: groupId, e: session.epoch + 5, h: "00", have: {}, secrets: [] });
    await settle();
    expect(state()).toBe(before);
    expect(JSON.stringify(node.getState())).not.toContain("evil");

    // The members got all of it: the fan-outs ran.
    expect(kinds(bob)).toEqual(expect.arrayContaining(["group-msg", "group-edit", "group-react", "group-pin", "group-pay", "group-wake", "group-meta", "group-commit", "sendPaymentRequest", "sendPaymentResult", "sendPairedNick"]));
    expect(kinds(carol)).toEqual(expect.arrayContaining(["group-commit"]));
    // The removed member: the commits up to the one that removed it. Zero other frames, of any kind.
    expect(gone.sent.length).toBeGreaterThan(0);
    expect(kinds(gone)).toEqual(["group-commit"]);
    for (const frame of frames(gone)) {
      expect(frame.commit!.e).toBeLessThanOrEqual(removedAt);
      expect("secret" in frame).toBe(false);
    }
    expect(frames(gone).some(f => f.commit!.e === removedAt && !f.commit!.m.some(([key]) => key === gone.key))).toBe(true);
    // A moment later the edge is gone.
    await inner.groups.tick(Date.now() + 16_000);
    await vi.waitFor(() => expect(a.edgeOf(gone.key)).toBeUndefined());
  }, 30_000);

  it("an app that opens the kept edge and never announces groups gets nothing, and the edge closes by itself", async () => {
    const a = await adminOf(["bob", "away"]);
    const { node, inner, groupId, members: [bob, gone] } = a;
    inner.settings.wake = { endpoint: "https://push.test/abc", p256dh: "p", auth: "a" };
    // Its connection is open; it says it takes payments, and nothing about groups: it cannot be told, so nothing starts the 15 s.
    await gone.comeUp(false);
    await node.removeGroupMember({ groupId, key: gone.key });
    await settle();
    expect(a.edgeOf(gone.key)).toBeDefined();
    bob.sent.length = 0; gone.sent.length = 0;
    await busy(a, bob);
    expect(kinds(bob)).toEqual(expect.arrayContaining(["group-msg", "group-react", "group-pin", "sendPaymentRequest", "sendPaymentResult"]));
    expect(gone.sent).toEqual([]);
    await inner.groups.tick(Date.now() + FAREWELL_OPEN_MS - 5_000);
    await settle();
    expect(a.edgeOf(gone.key)).toBeDefined();
    await inner.groups.tick(Date.now() + FAREWELL_OPEN_MS + 1_000);
    await vi.waitFor(() => expect(a.edgeOf(gone.key)).toBeUndefined());
    expect((await db.getGroups()).find(g => g.id === groupId)!.farewells).toBeUndefined();
  }, 30_000);

  it("a member just removed, its edge still open for a moment, hears the commit and nothing after", async () => {
    const a = await adminOf(["bob", "carol"]);
    const { node, inner, groupId, session, members: [bob, carol] } = a;
    inner.settings.wake = { endpoint: "https://push.test/abc", p256dh: "p", auth: "a" };
    // Its edge outlives its place in the roster (as a hub keeps it a while, or until the edges are next set right).
    const closeEdge = vi.spyOn(node as unknown as { closeGroupLink(id: string): Promise<void> }, "closeGroupLink").mockResolvedValue();
    const removedAt = session.epoch + 1;
    await node.removeGroupMember({ groupId, key: carol.key });
    await settle();
    expect(a.edgeOf(carol.key)).toBeDefined();
    expect(kinds(carol)).toContain("group-commit");
    bob.sent.length = 0; carol.sent.length = 0;
    await busy(a, bob);
    await node.rotateGroup({ groupId });
    await settle();
    expect(kinds(bob)).toEqual(expect.arrayContaining(["group-msg", "group-react", "group-pin", "group-pay", "sendPaymentRequest", "sendPaymentResult"]));
    expect(carol.sent).toEqual([]);
    expect(removedAt).toBeLessThan(session.epoch);
    closeEdge.mockRestore();
  }, 30_000);
});

describe("a hub and an edge to someone out of the roster", () => {
  const [admin, hub, member, gone] = ["admin", "hub", "member", "gone"];
  // Epochs 0 to 2 have `gone`; the commit of epoch 3 takes it out; 4 is a change after.
  const roster = (...keys: string[]) => keys.map((key, i) => [key, i ? "member" : "admin"]);
  const chain = [roster(admin), roster(admin, hub, gone), roster(admin, hub, gone, member), roster(admin, hub, member), roster(admin, hub, member)]
    .map((m, e) => ({ e, m, by: admin })) as unknown as GroupCommit[];
  const session = { roster: chain[4].m, myKey: hub, state: { chain } } as unknown as GroupSession;

  function hubs() {
    const sent: { to: string; frame: { t: string; commit?: { e: number } } }[] = [];
    const edges = new Map([[admin, "e-admin"], [member, "e-member"], [gone, "e-gone"]]);
    const host = { edges: () => edges, linkReady: () => true, sendOnLink: (id: string, frame: object) => { sent.push({ to: id, frame: frame as { t: string } }); } } as unknown as GroupsHost;
    const mesh = new MeshHubs(host, { stored: () => undefined, save: () => {} });
    const inner = mesh as unknown as { get(groupId: string, now: number): { hub: boolean }; sayReach(groupId: string, session: GroupSession, live: unknown, now: number): void };
    const live = inner.get("g", 1_000);
    live.hub = true;
    return { mesh, inner, live, sent };
  }

  it("the epoch a key left at is the one after the last roster that had it", () => {
    expect(removalEpoch(chain, gone)).toBe(3);
    expect(removalEpoch(chain, member)).toBe(5);
    expect(removalEpoch(chain, "stranger")).toBe(-1);
  });

  it("passes on to it the commit that took it out, and no commit after, nor anything else", () => {
    const { mesh, sent } = hubs();
    const commit = (e: number) => ({ t: "group-commit", g: "g", commit: chain[e] }) as unknown as GroupEdgeFrame;
    const message = { t: "group-msg", g: "g", e: 4, s: admin, n: 0 } as unknown as GroupEdgeFrame;
    mesh.passOn("g", session, admin, [commit(3), commit(4), message]);
    expect(sent.filter(s => s.to === "e-gone").map(s => [s.frame.t, s.frame.commit?.e])).toEqual([["group-commit", 3]]);
    expect(sent.filter(s => s.to === "e-member").map(s => s.frame.t)).toEqual(["group-commit", "group-commit", "group-msg"]);
  });

  it("does not tell it whom the hub reaches", () => {
    const { inner, live, sent } = hubs();
    inner.sayReach("g", session, live, 100_000);
    expect(sent.map(s => s.to).sort()).toEqual(["e-admin", "e-member"]);
    expect(sent.every(s => !(s.frame as unknown as { k: string[] }).k.includes(gone))).toBe(true);
  });
});
