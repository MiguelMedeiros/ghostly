import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostLink, type GhostLinkEvents } from "../src/ghostlink";
import { createLink } from "../src/invite";
import { createIdentity } from "../src/identity";
import type { FrameChannel } from "../src/frames";
import type { PairingState } from "../src/pairedSession";
import { GROUP_LIMITS, GroupSession, type GroupEdgeFrame, type GroupIncomingMessage, type GroupSessionHooks } from "../src/groupSession";
import { Mesh, admit, clone } from "./support/groupMesh";
import { createChannelPair } from "./helpers";
// covers: groups.catch-up, core.liveness

/*
 * A member back in a busy group asks another for what it missed, and the answer can be well over a hundred frames: the
 * commits, its own kept messages, those of the members it asks for (whose edges are down), their edits. Sent at once on
 * one session, an app that holds 64 frames waiting (every app before 2026-10-07) ended that session mid catch-up:
 * "Session receive limit exceeded" on a phone, 113 frames from one member (bh13). The answer now goes a slice at a time
 * (`GROUP_LIMITS.catchUpSlice`), each once the member's app handled the last: it answers a ping in the order frames
 * come, so the pong says so (`GhostLink.handled`). No new frame: apps since 0.5 answer pings.
 */

type Internal = { attach(channel: FrameChannel): void };
const live: GhostLink[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(live.splice(0).map(link => link.stop(false)));
});

function makeLink(params: ReturnType<typeof createLink>["mine"], events: GhostLinkEvents): GhostLink {
  const link = new GhostLink({
    params: { ...params, profile: "paired-chat/1" },
    pairing: { credentials: { seedB64: createIdentity().seedB64 }, pinPeer: vi.fn(async () => {}), trustOnFirstUse: true },
    transport: { publish: vi.fn(async () => {}), resolve: async () => null, describe: () => ({ protocol: "test", relays: [] }) },
    createPeerConnection: () => { throw new Error("no dial in this test"); },
    localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    groupsSupport: true, events,
  });
  Object.defineProperty(link.dataLink, "fingerprints", { get: () => ["a".repeat(64), "b".repeat(64)] });
  live.push(link);
  return link;
}

/** Two group-capable links on one in-memory channel; `delayMs`: each frame's way across, as a network's. */
function edge(receiverEvents: GhostLinkEvents, delayMs = 0) {
  const invitation = createLink();
  const states: PairingState[] = [];
  const a = makeLink(invitation.mine, {});
  const b = makeLink(invitation.invite, { onPairingState: s => states.push(s), ...receiverEvents });
  const [ca, cb] = createChannelPair();
  if (delayMs) for (const channel of [ca, cb]) {
    const peer = channel === ca ? cb : ca, send = channel.send.bind(channel);
    channel.send = data => { if ((channel as { closed?: boolean }).closed) throw new Error("Data link is not open"); setTimeout(() => peer.onMessage?.(data), delayMs); void send; };
  }
  (a as unknown as Internal).attach(ca);
  (b as unknown as Internal).attach(cb);
  return { a, b, ca, cb, states };
}

/**
 * Alice and Bob in a group of six. Bob's app is closed while the four others write `each` messages apiece; then they
 * close theirs too, and Bob, back, asks Alice for theirs: an answer of over a hundred frames from one member.
 */
async function busyGroup(each: number) {
  const mesh = new Mesh();
  const alice = mesh.add(GroupSession.create("Sala"), "Alice");
  const bob = await admit(mesh, alice, "Bob");
  const authors: GroupSession[] = [];
  for (const name of ["C", "D", "E", "F"]) authors.push(await admit(mesh, alice, name));
  for (const s of [alice, ...authors]) mesh.setEdge(bob.myKey, s.myKey, false);
  for (let i = 0; i < each; i++) for (const author of authors) await author.sendText(`${author.myKey.slice(0, 4)} ${i}`, 1_000 + i);
  await alice.sendText("from Alice", 1_000 + each);
  await mesh.settle();
  for (const author of authors) mesh.setEdge(alice.myKey, author.myKey, false);
  return { alice, bob, authors, sync: clone(bob.syncFrame(authors.map(s => s.myKey))) };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Alice's answer to Bob's sync, over a real paired session to Bob's app, which handles each group frame in
 * `perFrameMs` (a phone decrypting, checking and storing). `paced`: Alice's app says when Bob's handled a slice.
 */
async function catchUp(each: number, options: { paced: boolean; perFrameMs: number; delayMs?: number }) {
  const { alice, bob, authors, sync } = await busyGroup(each);
  const got: GroupIncomingMessage[] = [];
  let receiver!: GroupSession;
  let sentGroup = 0, handledGroup = 0, mostWaiting = 0;
  const link = edge({
    onGroupFrame: async frame => {
      await sleep(options.perFrameMs);
      await receiver.handle(alice.myKey, frame);
      handledGroup++;
    },
  }, options.delayMs);
  receiver = new GroupSession(clone(bob.state), { save: async () => {}, send: () => {}, message: m => { got.push(m); }, changed: () => {} });
  await vi.waitFor(() => { expect(link.a.groupsSupport).toBe(true); expect(link.b.groupsSupport).toBe(true); });
  // What Bob's app holds received and not handled yet: what ends its session past 64 (before 2026-10-07).
  const send = link.ca.send.bind(link.ca);
  link.ca.send = data => {
    if (typeof data === "string" && data.startsWith('{"t":"group-')) mostWaiting = Math.max(mostWaiting, ++sentGroup - handledGroup);
    send(data);
  };
  const hooks: GroupSessionHooks = {
    save: async () => {}, message: () => {}, changed: () => {},
    send: (_to, frame: GroupEdgeFrame) => { try { link.a.sendGroupFrame(frame); return true; } catch { return false; } },
    ...(options.paced ? { handled: () => link.a.handled() } : {}),
  };
  const sender = new GroupSession(clone(alice.state), hooks);
  const started = Date.now();
  await sender.handle(bob.myKey, sync);
  const expected = authors.length * each + 1;
  await vi.waitFor(() => expect(got.length + (link.b.isDataLinkOpen ? 0 : Infinity)).toBeGreaterThanOrEqual(expected), { timeout: 60_000, interval: 5 });
  return { link, got, expected, sentGroup, mostWaiting, ms: Date.now() - started };
}

describe("a member's catch-up answer goes a slice at a time", { timeout: 120_000 }, () => {
  it("a phone that holds 64 frames waiting keeps its session through an answer of over a hundred (2026-10-07)", async () => {
    const run = await catchUp(30, { paced: true, perFrameMs: 3 });
    expect(run.sentGroup).toBeGreaterThan(113);
    expect(run.link.b.isDataLinkOpen).toBe(true);
    expect(run.link.states).not.toContainEqual(expect.objectContaining({ status: "error" }));
    expect(run.got).toHaveLength(run.expected);
    // Never more waiting on Bob's side than two slices: far from the 64 an app before 2026-10-07 ends its session at.
    expect(run.mostWaiting).toBeLessThanOrEqual(2 * GROUP_LIMITS.catchUpSlice);
  });

  it("each slice goes once the member's app handled the last; a newer answer takes the place of the rest", async () => {
    const { alice, bob, sync } = await busyGroup(30);
    // The answer as it went before: all at once.
    const whole: GroupEdgeFrame[] = [];
    await new GroupSession(clone(alice.state), { save: async () => {}, message: () => {}, changed: () => {}, send: (_to, frame) => { whole.push(frame); } })
      .handle(bob.myKey, sync);
    const slice = GROUP_LIMITS.catchUpSlice;
    const sent: GroupEdgeFrame[] = [];
    const waits: (() => void)[] = [];
    const sender = new GroupSession(clone(alice.state), {
      save: async () => {}, message: () => {}, changed: () => {},
      send: (_to, frame) => { sent.push(frame); },
      handled: () => new Promise<boolean>(resolve => waits.push(() => resolve(true))),
    });
    await sender.handle(bob.myKey, sync);
    // Two slices go with the answer; the next waits for Bob's app to have handled the first.
    expect(sent).toEqual(whole.slice(0, 2 * slice));
    expect(waits).toHaveLength(2);
    await sleep(20);
    expect(sent).toHaveLength(2 * slice);
    waits.shift()!();
    await vi.waitFor(() => expect(sent).toHaveLength(3 * slice));
    expect(sent).toEqual(whole.slice(0, 3 * slice));
    // Bob's sync again (its edge opened again): the new answer takes the place of what is left of the first.
    await sender.handle(bob.myKey, sync);
    expect(sent).toHaveLength(3 * slice);
    while (sent.length < 3 * slice + whole.length) {
      await vi.waitFor(() => expect(waits.length).toBeGreaterThan(0));
      waits.shift()!();
      await sleep(0);
    }
    expect(sent).toEqual([...whole.slice(0, 3 * slice), ...whole]);
    // Nothing is asked after the last slice: the one before it is the only question left.
    await sleep(20);
    expect(waits.length).toBeLessThanOrEqual(1);
  });

  it("an app that cannot say waits a pause between slices; an edge that takes no frame ends the answer", async () => {
    const { alice, bob, sync } = await busyGroup(30);
    vi.useFakeTimers();
    const sent: GroupEdgeFrame[] = [];
    let open = true;
    const sender = new GroupSession(clone(alice.state), {
      save: async () => {}, message: () => {}, changed: () => {},
      send: (_to, frame) => { if (!open) return false; sent.push(frame); return true; },
      handled: async () => false,
    });
    await sender.handle(bob.myKey, sync);
    expect(sent).toHaveLength(2 * GROUP_LIMITS.catchUpSlice);
    await vi.advanceTimersByTimeAsync(GROUP_LIMITS.catchUpPauseMs - 1);
    expect(sent).toHaveLength(2 * GROUP_LIMITS.catchUpSlice);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(3 * GROUP_LIMITS.catchUpSlice);
    open = false;
    await vi.advanceTimersByTimeAsync(10 * GROUP_LIMITS.catchUpPauseMs);
    expect(sent).toHaveLength(3 * GROUP_LIMITS.catchUpSlice);
  });

  it("a host that cannot tell (no `handled`) sends the answer at once, as before", async () => {
    const { alice, bob, sync } = await busyGroup(30);
    const sent: GroupEdgeFrame[] = [];
    const sender = new GroupSession(clone(alice.state), { save: async () => {}, message: () => {}, changed: () => {}, send: (_to, frame) => { sent.push(frame); } });
    await sender.handle(bob.myKey, sync);
    expect(sent.length).toBeGreaterThan(113);
  });
});

describe("GhostLink.handled: the contact's app handled what was sent before", () => {
  it("resolves once the contact's app handled every frame sent before, however slowly; false with no session", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const frames: unknown[] = [];
    const t = edge({ onGroupFrame: async frame => { await gate; frames.push(frame); } });
    await vi.waitFor(() => { expect(t.a.groupsSupport).toBe(true); expect(t.b.groupsSupport).toBe(true); });
    for (let i = 0; i < 10; i++) t.a.sendGroupFrame({ t: "group-msg", g: "g", n: i });
    let done: boolean | undefined;
    void t.a.handled().then(exact => { done = exact; });
    await sleep(50);
    expect(done).toBeUndefined();
    release();
    await vi.waitFor(() => expect(done).toBe(true));
    expect(frames).toHaveLength(10);
    await t.b.stop(false);
    await vi.waitFor(() => expect(t.a.isDataLinkOpen).toBe(false));
    expect(await t.a.handled()).toBe(false);
  });
});
