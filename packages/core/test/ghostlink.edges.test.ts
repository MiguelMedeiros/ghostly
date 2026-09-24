import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostLink, LIVENESS_MISSED_PINGS, LIVENESS_PING_MS, type GhostLinkEvents, type GhostLinkOptions } from "../src/ghostlink";
import { createLink, type LinkParams } from "../src/invite";
import { createIdentity } from "../src/identity";
import { CHUNK_KIND, encodeChunk, type FrameChannel } from "../src/frames";
import { MAX_NICK_LENGTH, sanitizeNick } from "../src/text";
import { randomBytes, toBase64Url, utf8Decode, utf8Encode } from "../src/bytes";
import type { HostedHttpService, LocalFetch } from "../src/http";
import type { FileSink } from "../src/files";
import type { BoundChannel, NativeBinding, NativeEndpoint } from "../src/pairedTransports";
import { signPairedSignal } from "../src/pairedSignal";
import { createChannelPair } from "./helpers";

// covers: chat.paired.session, chat.paired.send, chat.paired.receipts, chat.paired.reconnect, chat.paired.nickname-sync, chat.legacy.send, core.liveness, core.capabilities, transport.switch, payments.chat.frames

type Side = Partial<Omit<GhostLinkOptions, "params" | "transport" | "events">> & { events?: GhostLinkEvents; profile?: boolean };
type Frame = string | Uint8Array | Record<string, unknown> | unknown[];
type Internal = { attach(channel: FrameChannel): void; channel: FrameChannel | null };

const live: GhostLink[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(live.splice(0).map(link => link.stop(false)));
});

const newId = () => toBase64Url(randomBytes(16));
const wire = (frame: Frame) => typeof frame === "string" || frame instanceof Uint8Array ? frame : JSON.stringify(frame);

function makeLink(params: LinkParams, side: Side): GhostLink {
  const { events, profile = true, ...rest } = side;
  const link = new GhostLink({
    params: profile ? { ...params, profile: "paired-chat/1" } : params,
    pairing: profile ? { credentials: { seedB64: createIdentity().seedB64 }, pinPeer: vi.fn(async () => {}), trustOnFirstUse: true } : undefined,
    transport: { publish: vi.fn(async () => {}), resolve: async () => null, describe: () => ({ protocol: "test", relays: [] }) },
    createPeerConnection: () => { throw new Error("no dial in this test"); },
    localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    ...rest, events,
  });
  // The paired handshake binds to the DTLS fingerprints of the WebRTC connection; these stand in for them.
  Object.defineProperty(link.dataLink, "fingerprints", { get: () => ["a".repeat(64), "b".repeat(64)] });
  live.push(link);
  return link;
}

/**
 * Two links on the two ends of one in-memory channel, as if the data link had opened. `toA` / `toB`
 * put raw frames on the wire exactly as the other side's app would, so what one side makes of
 * arbitrary peer input can be observed.
 */
function linkedPair(sides: [Side, Side] = [{}, {}], drop?: (data: string | Uint8Array) => boolean) {
  const invitation = createLink();
  const onMessageA = vi.fn(), onMessageB = vi.fn();
  const a = makeLink(invitation.mine, { ...sides[0], events: { onMessage: onMessageA, ...sides[0].events } });
  const b = makeLink(invitation.invite, { ...sides[1], events: { onMessage: onMessageB, ...sides[1].events } });
  const [ca, cb] = createChannelPair();
  if (drop) for (const channel of [ca, cb]) {
    const send = channel.send.bind(channel);
    channel.send = data => { if (!drop(data)) send(data); };
  }
  (a as unknown as Internal).attach(ca);
  (b as unknown as Internal).attach(cb);
  const toB = (frame: Frame) => ca.send(wire(frame));
  const toA = (frame: Frame) => cb.send(wire(frame));
  /** Frames are handled in order: once a later chat message arrives, everything sent before it was handled. */
  const settle = async (to: "a" | "b") => {
    const id = newId();
    const onMessage = to === "a" ? onMessageA : onMessageB;
    (to === "a" ? toA : toB)({ t: "paired-message", id, ts: 1, m: "barrier" });
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ id })));
    return id;
  };
  const ready = async () => {
    await vi.waitFor(() => { expect(a.isDataLinkOpen).toBe(true); expect(b.isDataLinkOpen).toBe(true); });
    await settle("a"); await settle("b");
  };
  return { a, b, ca, cb, toA, toB, settle, ready, onMessageA, onMessageB };
}

/** Two legacy (pre-pairing) links back to back on one in-memory channel. */
function legacyPair(sides: [Side, Side] = [{}, {}]) {
  const invitation = createLink();
  const a = makeLink(invitation.mine, { ...sides[0], profile: false });
  const b = makeLink(invitation.invite, { ...sides[1], profile: false });
  const [ca, cb] = createChannelPair();
  return {
    a, b, ca, cb,
    attach: () => { (a as unknown as Internal).attach(ca); (b as unknown as Internal).attach(cb); },
    toB: (frame: Frame) => ca.send(wire(frame)),
  };
}

/** What went out through a spied `send`, JSON frames parsed. */
const sentFrames = (send: { mock: { calls: unknown[][] } }): Record<string, unknown>[] =>
  send.mock.calls.map(([data]) => typeof data === "string" ? JSON.parse(data) as Record<string, unknown> : { binary: data });

const jpegAvatar = (() => {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, 0, 64, 0, 64, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  const bytes = [0xff, 0xd8, ...app0, ...sof, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9];
  return "data:image/jpeg;base64," + btoa(String.fromCharCode(...bytes));
})();

async function* bytesOf(data: Uint8Array) { yield data; }
function memorySink() {
  const chunks: Uint8Array[] = [];
  const sink: FileSink = { write: chunk => { chunks.push(chunk.slice()); }, close: vi.fn(), abort: vi.fn() };
  return { sink, text: () => utf8Decode(Uint8Array.from(chunks.flatMap(c => [...c]))) };
}
const webService = (id: string): HostedHttpService | undefined => id === "web" ? { id: "web", target: { origin: "http://localhost:3400", basePath: "" } } : undefined;
const okFetch = () => vi.fn<LocalFetch>(async () => ({ status: 200, headers: [["content-type", "text/plain"]], body: [utf8Encode("ok")] }));
const payEvents = () => ({ onPayment: vi.fn(), onPaymentRequest: vi.fn(), onPaymentResult: vi.fn(), onPaymentAsk: vi.fn() });

describe("paired chat messages from the peer", () => {
  it("delivers a message once and settles only the sender's own pending id on its receipt", async () => {
    const onMessageReceipt = vi.fn();
    const t = linkedPair([{ events: { onMessageReceipt } }, {}]);
    await t.ready();
    const id = newId();
    expect(await t.a.sendMessage("  hello  ", 42, id)).toBeNull();
    await vi.waitFor(() => expect(onMessageReceipt).toHaveBeenCalledWith(id));
    expect(t.onMessageB).toHaveBeenCalledWith({ id, text: "hello", timestamp: 42, via: "datalink" });
    // A repeated receipt, and one for a message never sent, change nothing.
    t.toA({ t: "paired-received", id });
    t.toA({ t: "paired-received", id: newId() });
    await t.settle("a");
    expect(onMessageReceipt).toHaveBeenCalledOnce();
  });

  it("acknowledges a resent id again, so a sender whose receipt was lost settles it without a second message", async () => {
    const onMessageReceipt = vi.fn();
    const t = linkedPair([{ events: { onMessageReceipt } }, {}]);
    await t.ready();
    const send = vi.spyOn(t.cb, "send");
    const id = newId();
    // The first copy arrived; its receipt is lost with the old session. The resend carries the same id.
    t.toB({ t: "paired-message", id, ts: 7, m: "once" });
    await t.settle("b");
    expect(await t.a.sendMessage("once", 7, id)).toBeNull();
    await vi.waitFor(() => expect(onMessageReceipt).toHaveBeenCalledWith(id));
    const receipts = sentFrames(send).filter(f => f.t === "paired-received" && f.id === id);
    expect(receipts).toHaveLength(2);
    // Both copies reach the engine under one id, which its storage keeps once (pairedStorage.test.ts).
    expect(t.onMessageB.mock.calls.filter(([m]) => m.id === id).map(([m]) => m.text)).toEqual(["once", "once"]);
  });

  it("drops messages with a malformed id, text or timestamp and sends no receipt for them", async () => {
    const t = linkedPair();
    await t.ready();
    const send = vi.spyOn(t.cb, "send");
    const good = { t: "paired-message", ts: 5, m: "x" };
    for (const bad of [
      { ...good, id: "short" },
      { ...good, id: newId() + "A" },
      { ...good, id: "a".repeat(21) + "=" },
      { ...good, id: 12345 },
      { ...good, id: newId(), m: 42 },
      // 8193 two-byte characters: under the limit counted in characters, over it counted in bytes.
      { ...good, id: newId(), m: "é".repeat(8193) },
      { ...good, id: newId(), ts: 0 },
      { ...good, id: newId(), ts: -5 },
      { ...good, id: newId(), ts: 1.5 },
      { ...good, id: newId(), ts: "5" },
      { ...good, id: newId(), ts: 2 ** 53 },
      { t: "paired-message", id: newId(), m: "no timestamp" },
    ]) t.toB(bad);
    const before = t.onMessageB.mock.calls.length;
    const exactly = newId();
    t.toB({ ...good, id: exactly, m: "é".repeat(8192) });
    const barrier = await t.settle("b");
    expect(t.onMessageB.mock.calls.slice(before).map(([m]) => m.id)).toEqual([exactly, barrier]);
    const receipts = sentFrames(send).filter(f => (f as { t?: string }).t === "paired-received").map(f => (f as { id: string }).id);
    expect(receipts).toEqual([exactly, barrier]);
  });

  it("ignores data that is not a JSON object, binary data and unknown frames, and stays open", async () => {
    const t = linkedPair();
    await t.ready();
    for (const junk of ["not json", "null", "5", '"text"', "[]", "{}", '{"t":42}', new Uint8Array([1, 2, 3]),
      { t: "paired-unknown" }, { t: "paired-unknown", id: newId() }]) t.toB(junk);
    await t.settle("b");
    expect(t.onMessageB).toHaveBeenCalledTimes(2);
    expect(t.b.isDataLinkOpen).toBe(true);
  });

  it("refuses to send an empty, oversized or badly identified message", async () => {
    const t = linkedPair();
    await t.ready();
    const send = vi.spyOn(t.ca, "send");
    expect(await t.a.sendMessage("   ")).toBeNull();
    expect(await t.a.sendMessage("é".repeat(8193))).toBe("Message exceeds 16 KiB");
    expect(await t.a.sendMessage("hi", 1, "not-an-id")).toBe("Invalid message ID");
    expect(send).not.toHaveBeenCalled();
    send.mockImplementation(() => { throw new Error("closed"); });
    expect(await t.a.sendMessage("hi")).toMatch(/closed before sending/);
  });

  it("remembers at most 128 unacknowledged messages: a receipt for an evicted one is ignored", async () => {
    const onMessageReceipt = vi.fn();
    const t = linkedPair([{ events: { onMessageReceipt } }, {}]);
    await t.ready();
    vi.spyOn(t.ca, "send").mockImplementation(() => {});
    const ids = Array.from({ length: 129 }, newId);
    for (const id of ids) expect(await t.a.sendMessage("m", 1, id)).toBeNull();
    for (const id of [ids[0], ids[1], ids[128]]) t.toA({ t: "paired-received", id });
    await t.settle("a");
    expect(onMessageReceipt.mock.calls.map(([id]) => id)).toEqual([ids[1], ids[128]]);
  });
});

describe("paired session teardown", () => {
  it("an oversized frame from the peer ends the session and leaves no way to send text", async () => {
    const onPairingState = vi.fn(), onDataLinkState = vi.fn();
    const t = linkedPair([{}, { events: { onPairingState, onDataLinkState } }]);
    await t.ready();
    t.toB("x".repeat(61 * 1024));
    await vi.waitFor(() => expect(t.b.isDataLinkOpen).toBe(false));
    expect(onPairingState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error", error: "Session receive limit exceeded" }));
    expect(t.b.textDelivery).toBe("unavailable");
    expect(t.b.canSendText).toBe(false);
    await vi.waitFor(() => expect(t.a.isDataLinkOpen).toBe(false));
    expect(await t.a.sendMessage("after")).toMatch(/connect before sending/);
  });

  it("a hang-up on one side closes the session on the other and clears what the peer said", async () => {
    const onGroupsSupport = vi.fn();
    const t = linkedPair([{ groupsSupport: true }, { groupsSupport: true, events: { onGroupsSupport } }]);
    await t.ready();
    t.toB({ t: "paired-nick", n: "Alice" });
    t.toB({ t: "paired-services", s: { v: 1, s: ["web"] } });
    await t.settle("b");
    expect(t.b.presence).toMatchObject({ online: true, nick: "Alice", services: [{ id: "web", type: "web" }] });
    expect(t.b.groupsSupport).toBe(true);
    t.a.disconnect();
    await vi.waitFor(() => expect(t.b.isDataLinkOpen).toBe(false));
    expect(t.b.presence).toMatchObject({ online: false });
    expect(t.b.presence.nick).not.toBe("Alice");
    expect(t.b.presence.services ?? []).toEqual([]);
    expect(onGroupsSupport).toHaveBeenLastCalledWith(false);
    expect(t.b.supportsPayments).toBe(false);
    expect(() => t.b.sendGroupFrame({ t: "group-x" })).toThrow();
  });

  it("a peer that answered pings and then goes silent is disconnected after the missed pings", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const t = linkedPair();
    await t.ready();
    // B answers the first ping, so A knows this peer understands them.
    await vi.advanceTimersByTimeAsync(LIVENESS_PING_MS);
    await t.settle("a");
    await vi.advanceTimersByTimeAsync(LIVENESS_PING_MS * 3);
    expect(t.a.isDataLinkOpen).toBe(true);
    t.cb.onMessage = null; // B hears nothing from now on
    await vi.advanceTimersByTimeAsync(LIVENESS_PING_MS * LIVENESS_MISSED_PINGS);
    expect(t.a.isDataLinkOpen).toBe(true);
    await vi.advanceTimersByTimeAsync(LIVENESS_PING_MS);
    expect(t.a.isDataLinkOpen).toBe(false);
  });

  it("a ping that cannot be sent drops the session at once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const t = linkedPair();
    await t.ready();
    vi.spyOn(t.ca, "send").mockImplementation(() => { throw new Error("gone"); });
    await vi.advanceTimersByTimeAsync(LIVENESS_PING_MS);
    expect(t.a.isDataLinkOpen).toBe(false);
  });

  it("answers the peer's ping with a pong", async () => {
    const t = linkedPair();
    await t.ready();
    const send = vi.spyOn(t.cb, "send");
    t.toB({ t: "paired-ping" });
    await t.settle("b");
    expect(sentFrames(send)).toContainEqual({ t: "paired-pong" });
  });

  it("confirming refuses a wrong code and a link with no session waiting", async () => {
    const t = linkedPair();
    await t.ready();
    await expect(t.a.confirmPair("0000 0000 0000 0000 0000 0000")).rejects.toThrow(/Compare the current code again/);
    const lone = makeLink(createLink().mine, {});
    await expect(lone.confirmPair("x")).rejects.toThrow("No peer is waiting for confirmation");
  });
});

describe("what a paired peer says about itself", () => {
  it("shows the peer's nickname only after sanitising it, and ignores a repeat", async () => {
    const onPresence = vi.fn();
    const t = linkedPair([{}, { events: { onPresence } }]);
    await t.ready();
    const raw = `  Mal\u202Elory\u200B${"x".repeat(100)}`;
    t.toB({ t: "paired-nick", n: raw });
    await t.settle("b");
    expect(t.b.presence.nick).toBe(sanitizeNick(raw));
    expect(t.b.presence.nick).not.toMatch(/[\u202E\u200B]/);
    expect([...t.b.presence.nick!].length).toBeLessThanOrEqual(MAX_NICK_LENGTH);
    const calls = onPresence.mock.calls.length;
    t.toB({ t: "paired-nick", n: raw });
    await t.settle("b");
    expect(onPresence).toHaveBeenCalledTimes(calls);
    // Something that is not text clears it.
    t.toB({ t: "paired-nick", n: { evil: true } });
    await t.settle("b");
    expect(t.b.presence.nick).toBeUndefined();
  });

  it("tells a nickname change to the connected peer", async () => {
    const t = linkedPair();
    await t.ready();
    t.a.setNick("Bob");
    await t.settle("b");
    expect(t.b.presence.nick).toBe("Bob");
    t.a.setNick(undefined);
    await t.settle("b");
    expect(t.b.presence.nick).toBeUndefined();
  });

  it("each side says its name and picture as soon as the session is ready, the invited side included", async () => {
    const peerA = { onPeerNick: vi.fn(), onPeerAvatar: vi.fn() }, peerB = { onPeerNick: vi.fn(), onPeerAvatar: vi.fn() };
    const t = linkedPair([{ nick: "Alice", avatar: jpegAvatar, events: peerA }, { nick: "Bob", events: peerB }]);
    await t.ready();
    expect(peerB.onPeerNick).toHaveBeenCalledWith("Alice");
    expect(peerB.onPeerAvatar).toHaveBeenCalledWith(jpegAvatar);
    // The inviter learns the invited side's too; a side with no picture says so.
    expect(peerA.onPeerNick).toHaveBeenCalledWith("Bob");
    expect(peerA.onPeerAvatar).toHaveBeenCalledWith(null);
  });

  it("a name removed is said as none, and a malformed one is not taken as a removal", async () => {
    const onPeerNick = vi.fn();
    const t = linkedPair([{ nick: "Alice" }, { events: { onPeerNick } }]);
    await t.ready();
    expect(onPeerNick).toHaveBeenLastCalledWith("Alice");
    t.a.setNick(undefined);
    await t.settle("b");
    expect(onPeerNick).toHaveBeenLastCalledWith(null);
    t.a.setNick("Alice again");
    await t.settle("b");
    expect(onPeerNick).toHaveBeenLastCalledWith("Alice again");
    onPeerNick.mockClear();
    t.toB({ t: "paired-nick", n: { evil: true } });
    t.toB({ t: "paired-nick" });
    await t.settle("b");
    expect(onPeerNick).not.toHaveBeenCalled();
  });

  it("what changed while the contact was away is said again on the next session", async () => {
    const peerB = { onPeerNick: vi.fn(), onPeerAvatar: vi.fn() };
    const t = linkedPair([{ nick: "Alice" }, { events: peerB }]);
    await t.ready();
    t.a.disconnect();
    await vi.waitFor(() => expect(t.b.isDataLinkOpen).toBe(false));
    // Changed while no session is open: nothing can be sent now.
    t.a.setNick("Alice (new)");
    t.a.setAvatar(jpegAvatar);
    expect(peerB.onPeerNick).not.toHaveBeenCalledWith("Alice (new)");
    const [ca, cb] = createChannelPair();
    (t.a as unknown as Internal).attach(ca);
    (t.b as unknown as Internal).attach(cb);
    await vi.waitFor(() => { expect(t.a.isDataLinkOpen).toBe(true); expect(t.b.isDataLinkOpen).toBe(true); });
    await vi.waitFor(() => expect(peerB.onPeerNick).toHaveBeenLastCalledWith("Alice (new)"));
    expect(peerB.onPeerAvatar).toHaveBeenLastCalledWith(jpegAvatar);
  });

  it("takes a small JPEG avatar or its removal and ignores anything else", async () => {
    const onPeerAvatar = vi.fn();
    const t = linkedPair([{}, { events: { onPeerAvatar } }]);
    await t.ready();
    onPeerAvatar.mockClear();
    for (const bad of ["https://tracker.example/pixel.jpg", "data:image/svg+xml;base64," + btoa("<svg onload=alert(1)>"), 42, { a: 1 }]) {
      t.toB({ t: "paired-avatar", a: bad });
    }
    await t.settle("b");
    expect(onPeerAvatar).not.toHaveBeenCalled();
    t.a.setAvatar(jpegAvatar);
    await t.settle("b");
    expect(onPeerAvatar).toHaveBeenLastCalledWith(jpegAvatar);
    t.a.setAvatar(undefined);
    await t.settle("b");
    expect(onPeerAvatar).toHaveBeenLastCalledWith(null);
  });

  it("takes the peer's shared web apps only when the list is well formed", async () => {
    const t = linkedPair([{ getPairedServices: () => [{ id: "web", type: "http", name: "Board" }] }, {}]);
    await t.ready();
    expect(t.b.presence.services).toEqual([{ id: "web", type: "http", name: "Board" }]);
    for (const bad of [null, "web", { v: 0, s: ["x"] }, { v: 1, s: "x" }]) t.toB({ t: "paired-services", s: bad });
    await t.settle("b");
    expect(t.b.presence.services).toEqual([{ id: "web", type: "http", name: "Board" }]);
  });

  it("refreshing services re-announces the paired list on the open session", async () => {
    let shared = [{ id: "a", type: "a" }];
    const t = linkedPair([{ getPairedServices: () => shared }, {}]);
    await t.ready();
    shared = [{ id: "b", type: "b" }];
    await t.a.refreshServices();
    await t.settle("b");
    expect(t.b.presence.services).toEqual([{ id: "b", type: "b" }]);
  });

  it("accepts a well-formed paired-hold and ignores malformed ones", async () => {
    const onHold = vi.fn();
    const t = linkedPair([{}, { holdSupport: true, events: { onHold } }]);
    await t.ready();
    expect(t.b.peerAllowsHold).toBe(false);
    onHold.mockClear();
    for (const bad of [{ on: "yes" }, { on: true, top: -1 }, { on: true, top: 1.5 }, { on: true, top: 2 ** 53 }, { on: true, top: "3" }]) {
      t.toB({ t: "paired-hold", ...bad });
    }
    await t.settle("b");
    expect(onHold).not.toHaveBeenCalled();
    t.a.setHoldSupport(true, 5);
    await t.settle("b");
    expect(onHold).toHaveBeenLastCalledWith({ peerAllows: true, peerTop: 5 });
    expect(t.b.peerAllowsHold).toBe(true);
    expect(t.b.supportsHold).toBe(true);
    t.toB({ t: "paired-hold", on: false });
    await t.settle("b");
    expect(onHold).toHaveBeenLastCalledWith({ peerAllows: false, peerTop: undefined });
    expect(t.b.supportsHold).toBe(false);
  });

  it("turns groups on only for a well-formed announcement that includes version 1", async () => {
    const onGroupsSupport = vi.fn();
    const t = linkedPair([{}, { groupsSupport: true, events: { onGroupsSupport } }]);
    await t.ready();
    for (const v of [1, "1", [0], [1.5], [-1], ["1"], [1, 1, 1, 1, 1, 1, 1, 1, 1], [2]]) t.toB({ t: "paired-groups", v });
    t.toB({ t: "group-invite", g: "early" });
    await t.settle("b");
    expect(t.b.groupsSupport).toBe(false);
    expect(onGroupsSupport).not.toHaveBeenCalled();
    t.toB({ t: "paired-groups", v: [2, 1] });
    await t.settle("b");
    expect(t.b.groupsSupport).toBe(true);
    expect(onGroupsSupport).toHaveBeenCalledWith(true);
  });

  it("answers a reconnect request and ignores an unexpected acknowledgement", async () => {
    const t = linkedPair();
    await t.ready();
    const send = vi.spyOn(t.cb, "send");
    t.toB({ t: "paired-reconnect" });
    t.toB({ t: "paired-reconnect-ack" });
    await t.settle("b");
    expect(sentFrames(send)).toContainEqual({ t: "paired-reconnect-ack" });
    expect(t.b.isDataLinkOpen).toBe(true);
  });

  it("keeps only known native transports from the peer's adapters and drops malformed lists", async () => {
    const onTransportDiscovery = vi.fn(async () => {});
    const t = linkedPair([{}, { events: { onTransportDiscovery } }]);
    await t.ready();
    onTransportDiscovery.mockClear();
    for (const descriptors of [undefined, "iroh", { "iroh/1": "x".repeat(5000) }]) t.toB({ t: "paired-adapters", descriptors });
    await t.settle("b");
    expect(onTransportDiscovery).not.toHaveBeenCalled();
    t.toB({ t: "paired-adapters", descriptors: { "iroh/1": { node: "n" }, "evil/9": { x: 1 }, "hyperdht/1": null } });
    await t.settle("b");
    expect(onTransportDiscovery).toHaveBeenCalledOnce();
    expect(onTransportDiscovery.mock.calls[0]).toEqual([{ "iroh/1": { node: "n" } }, ["webrtc/1"], true]);
  });

  it("ignores ICE signaling on the session while no transport change is pending", async () => {
    const t = linkedPair();
    await t.ready();
    const handleSignal = vi.spyOn(t.b.dataLink, "handleSignal");
    t.toB({ t: "paired-rtc", signal: "anything" });
    await t.settle("b");
    expect(handleSignal).not.toHaveBeenCalled();
  });
});

describe("paired payments", () => {
  const request = { id: "request-1", timestamp: 10, amount: { value: "21", asset: "sat" }, memo: "coffee", endpoints: [["cashu", '{"mints":[]}']] as [string, string][] };

  it("carries requests, asks, payments and results between two chats that allow them", async () => {
    const eb = payEvents();
    const t = linkedPair([{ events: payEvents() }, { events: eb }]);
    await t.ready();
    expect(t.a.supportsPayments).toBe(true);
    await t.a.sendPaymentRequest(request);
    await t.a.sendPaymentAsk({ id: "ask-00001", timestamp: 11, amount: { value: "1.5", asset: "usdt" }, method: "usdt" });
    await t.a.sendPayment({ id: "payment-1", timestamp: 12, requestId: "request-1", amount: { value: "21", asset: "sat" }, endpoint: ["cashu", "cashuAtoken"] });
    t.a.sendPaymentResult({ id: "payment-2", ok: false, error: "no" });
    await t.settle("b");
    expect(eb.onPaymentRequest).toHaveBeenCalledWith({ ...request, ask: undefined });
    expect(eb.onPaymentAsk).toHaveBeenCalledWith({ id: "ask-00001", timestamp: 11, amount: { value: "1.5", asset: "usdt" }, method: "usdt", memo: undefined });
    expect(eb.onPayment).toHaveBeenCalledWith({ id: "payment-1", timestamp: 12, requestId: "request-1", amount: { value: "21", asset: "sat" }, memo: undefined, endpoint: ["cashu", "cashuAtoken"] });
    expect(eb.onPaymentResult).toHaveBeenCalledWith({ id: "payment-2", ok: false, credited: undefined, error: "no" });
  });

  it("drops malformed payment frames", async () => {
    const eb = payEvents();
    const t = linkedPair([{ events: payEvents() }, { events: eb }]);
    await t.ready();
    for (const bad of [
      { t: "pay-req", id: "short", ts: 1, v: "1", u: "sat", e: [["cashu", "x"]] },
      { t: "pay-req", id: "request-1", ts: 1, v: "1e5", u: "sat", e: [["cashu", "x"]] },
      { t: "pay-req", id: "request-1", ts: 1, v: "1", u: "SAT", e: [["cashu", "x"]] },
      { t: "pay-req", id: "request-1", ts: 1, v: "1", u: "sat", e: [] },
      { t: "pay", id: "payment-1", ts: 1, v: "1", u: "sat", e: ["Cashu!", "x"] },
      { t: "pay-ask", id: "ask-00001", ts: 1, v: "1", u: "sat", m: "cashu" },
      { t: "pay-res", id: "payment-1", ok: "yes" },
    ]) t.toB(bad);
    await t.settle("b");
    for (const event of Object.values(eb)) expect(event).not.toHaveBeenCalled();
  });

  it("narrows payments to the peer's latest list, ignoring unknown methods and malformed lists", async () => {
    const t = linkedPair([{ events: payEvents() }, { events: payEvents() }]);
    await t.ready();
    expect(t.b.allowsPayment("lightning")).toBe(true);
    for (const m of ["cashu", [1], Array.from({ length: 17 }, () => "cashu")]) t.toB({ t: "paired-payments", m });
    await t.settle("b");
    expect(t.b.allowsPayment("lightning")).toBe(true);
    t.toB({ t: "paired-payments", m: ["cashu", "bitcoin", "future-coin"] });
    await t.settle("b");
    expect(t.b.allowsPayment("cashu")).toBe(true);
    expect(t.b.allowsPayment("lightning")).toBe(false);
    expect(t.b.peerAllowsPayment("lightning")).toBe(false);
    expect(t.b.supportsBitcoinPayments).toBe(true);
    t.toB({ t: "paired-payments", m: ["cashu", "lightning"] });
    await t.settle("b");
    expect(t.b.supportsBitcoinPayments).toBe(false);
    // The contact turning a method off locally is told on the open session.
    t.a.setPaymentMethods({ cashu: false });
    await t.settle("b");
    expect(t.b.allowsPayment("cashu")).toBe(false);
    expect(t.b.supportsPayments).toBe(true);
  });

  it("an older contact that did not offer payments in its handshake is sent no payment frames", async () => {
    const onPaymentRequest = vi.fn();
    // An older app never says its payment list on the session, so only the handshake offer counts.
    const t = linkedPair([{ events: payEvents() }, { events: { onPaymentRequest } }], data => typeof data === "string" && data.includes('"paired-payments"'));
    await t.ready();
    expect(t.a.supportsPayments).toBe(false);
    await expect(t.a.sendPaymentRequest(request)).rejects.toThrow(/does not support payments/);
    const send = vi.spyOn(t.ca, "send");
    t.a.sendPaymentResult({ id: "payment-1", ok: true });
    expect(send).not.toHaveBeenCalled();
    expect(onPaymentRequest).not.toHaveBeenCalled();
  });

  it("a contact that turned all payments off is told apart from one that allows them", async () => {
    const onPaymentRequest = vi.fn();
    const off = { cashu: false, lightning: false, arkade: false, usdt: false, bark: false, bitcoin: false };
    const t = linkedPair([{ events: payEvents() }, { paymentMethods: off, events: { ...payEvents(), onPaymentRequest } }]);
    await t.ready();
    expect(t.a.supportsPayments).toBe(false);
    expect(t.a.peerAllowsPayment("cashu")).toBe(false);
    t.toB({ t: "pay-req", id: "request-1", ts: 1, v: "1", u: "sat", e: [["cashu", "x"]] });
    await t.settle("b");
    expect(onPaymentRequest).not.toHaveBeenCalled();
  });

  it("refuses every payment when this chat turned them all off", async () => {
    const off = { cashu: false, lightning: false, arkade: false, usdt: false, bark: false, bitcoin: false };
    const t = linkedPair([{ paymentMethods: off, events: payEvents() }, { events: payEvents() }]);
    await t.ready();
    await expect(t.a.sendPaymentRequest(request)).rejects.toThrow("Payments are turned off in this chat.");
    expect(t.a.allowsPayment("cashu")).toBe(false);
  });
});

describe("paired proofs", () => {
  it("delivers identity and peer proof frames when both sides offer them, with matching scopes", async () => {
    const onIdentityProof = vi.fn(async () => {}), onPeerProof = vi.fn(async () => {});
    const t = linkedPair([{ events: { onIdentityProof: vi.fn(async () => {}), onPeerProof: vi.fn(async () => {}) } }, { events: { onIdentityProof, onPeerProof } }]);
    await t.ready();
    expect(t.a.identitySupport).toBe(true);
    expect(t.a.peerProofSupport).toBe(true);
    expect(t.a.peerProofAdapters.length).toBeGreaterThan(0);
    t.a.sendIdentityProof({ t: "idp-offer", x: 1 });
    t.a.sendPeerProof({ t: "proof-offer", x: 2 });
    await t.settle("b");
    expect(onIdentityProof).toHaveBeenCalledWith({ t: "idp-offer", x: 1 });
    expect(onPeerProof).toHaveBeenCalledWith({ t: "proof-offer", x: 2 });

    const [ia, ib] = [t.a.identityScope(), t.b.identityScope()];
    expect(ia.context).toBe(ib.context);
    expect(ia.session).toBe(ib.session);
    expect(ia.subject).toBe(ib.audience);
    expect(ib.subject).toBe(ia.audience);
    const [pa, pb] = await Promise.all([t.a.peerProofScope(), t.b.peerProofScope()]);
    expect(pa).toEqual({ subject: ia.subject, audience: ia.audience, context: ia.context, session: ia.session });
    expect(pb.subject).toBe(pa.audience);
    expect(t.a.proofSession).toBe(ia.session);
  });

  it("refuses proofs that are too large", async () => {
    const t = linkedPair([{ events: { onIdentityProof: vi.fn(async () => {}), onPeerProof: vi.fn(async () => {}) } },
      { events: { onIdentityProof: vi.fn(async () => {}), onPeerProof: vi.fn(async () => {}) } }]);
    await t.ready();
    expect(() => t.a.sendIdentityProof({ t: "idp-x", pad: "x".repeat(32 * 1024) })).toThrow("Identity proof too large");
    expect(() => t.a.sendPeerProof({ t: "proof-x", pad: "x".repeat(8192) })).toThrow("Proof too large");
  });

  it("keeps proof frames away from an app that did not offer proofs, and refuses to send them", async () => {
    const onIdentityProof = vi.fn(async () => {}), onPeerProof = vi.fn(async () => {});
    const t = linkedPair([{ events: { onIdentityProof, onPeerProof } }, {}]);
    await t.ready();
    expect(t.a.identitySupport).toBe(false);
    expect(t.a.peerProofSupport).toBe(false);
    expect(t.a.peerProofAdapters).toEqual([]);
    expect(t.a.proofSession).toBeUndefined();
    expect(() => t.a.sendIdentityProof({ t: "idp-x" })).toThrow(/unavailable/);
    expect(() => t.a.sendPeerProof({ t: "proof-x" })).toThrow(/unavailable/);
    expect(() => t.a.identityScope()).toThrow("Connect to this contact first");
    await expect(t.a.peerProofScope()).rejects.toThrow(/supporting optional proofs/);
    t.toA({ t: "idp-offer" });
    t.toA({ t: "proof-offer" });
    await t.settle("a");
    expect(onIdentityProof).not.toHaveBeenCalled();
    expect(onPeerProof).not.toHaveBeenCalled();
  });
});

describe("paired files and web apps", () => {
  const file = { id: "abcdefgh12345678", name: "note.txt", mime: "text/plain", size: 5, timestamp: 1 };

  it("sends a file to a contact that offers files", async () => {
    const { sink, text } = memorySink();
    const onFileComplete = vi.fn();
    const onFileIncoming = vi.fn(() => sink);
    const t = linkedPair([{ events: { onFileIncoming: () => null, onFileComplete } }, { events: { onFileIncoming } }]);
    await t.ready();
    expect(t.a.supportsFiles).toBe(true);
    await t.a.sendFile(file, bytesOf(utf8Encode("hello")));
    expect(onFileIncoming).toHaveBeenCalledWith(expect.objectContaining({ id: file.id, name: "note.txt", size: 5 }));
    expect(text()).toBe("hello");
    expect(onFileComplete).toHaveBeenCalledWith(file.id, "out");
  });

  it("refuses files with a contact that does not offer them and ignores file frames from it", async () => {
    const onFileIncoming = vi.fn(() => null);
    const t = linkedPair([{ events: { onFileIncoming } }, {}]);
    await t.ready();
    expect(t.a.supportsFiles).toBe(false);
    await expect(t.a.sendFile(file, bytesOf(utf8Encode("hello")))).rejects.toThrow(/does not support files/);
    t.toA({ t: "pf-offer", id: file.id, n: "x", s: 1, m: "text/plain", ts: 1 });
    await t.settle("a");
    expect(onFileIncoming).not.toHaveBeenCalled();
  });

  it("reaches a web app the contact shares over the session", async () => {
    const localFetch = okFetch();
    const t = linkedPair([{}, { getHostedHttpService: webService, localFetch }]);
    await t.ready();
    const response = await t.a.request("web", { method: "GET", path: "/hello" });
    expect(response.status).toBe(200);
    expect(utf8Decode(await response.bytes())).toBe("ok");
    expect(localFetch).toHaveBeenCalledWith(expect.objectContaining({ url: "http://localhost:3400/hello", method: "GET" }));
  });
});

describe("paired connecting", () => {
  it("connect reports a WebRTC attempt that could not start and rejects its waiter", async () => {
    const onPairingState = vi.fn();
    const link = makeLink(createLink().mine, { events: { onPairingState } });
    await expect(link.connect()).rejects.toThrow("Could not connect to the peer");
    expect(onPairingState).toHaveBeenCalledWith({ status: "connecting" });
  });

  it("connect gives up after its timeout, and a hang-up cancels a pending attempt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const link = makeLink(createLink().mine, {});
    vi.spyOn(link.dataLink, "connect").mockReturnValue(new Promise(() => {}));
    const timedOut = link.connect(1_000).catch((error: Error & { code?: string }) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await timedOut).toMatchObject({ code: "timeout" });
    const cancelled = link.connect(1_000).catch((error: Error) => error);
    link.disconnect();
    expect(await cancelled).toMatchObject({ message: "Connection attempt cancelled" });
  });

  it("without WebRTC or a native transport there is nothing to dial", async () => {
    const onPairingState = vi.fn();
    const link = makeLink(createLink().mine, { rtcAvailable: false, events: { onPairingState } });
    await expect(link.connect()).rejects.toThrow(/No common available transport/);
    expect(onPairingState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "error" }));
  });

  it("an open session connects at once, and refuses an unavailable transport preference", async () => {
    const t = linkedPair();
    await t.ready();
    await expect(t.a.connect()).resolves.toBeUndefined();
    await expect(t.a.setTransportPreference("iroh/1", true)).rejects.toThrow("Transport unavailable in this runtime");
    await expect(t.a.setDeliveryMode("dht")).rejects.toThrow(/DHT delivery is unavailable/);
  });

  it("a native endpoint is refused by a legacy chat and by a stopped one", async () => {
    const legacy = makeLink(createLink().mine, { profile: false });
    const close = vi.fn(async () => {});
    legacy.registerEndpoint({ transport: "iroh/1", descriptor: {}, onConnection: null, onDescriptor: null, connect: vi.fn(), close });
    expect(close).toHaveBeenCalledOnce();
    expect(legacy.availableTransports).toEqual(["webrtc/1"]);
    await expect(legacy.setTransportPreference("webrtc/1", true)).rejects.toThrow(/unavailable/);
    const stopped = makeLink(createLink().mine, {});
    await stopped.stop(false);
    stopped.registerEndpoint({ transport: "iroh/1", descriptor: {}, onConnection: null, onDescriptor: null, connect: vi.fn(), close });
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("an endpoint that becomes unavailable is forgotten, and a free one can be released", async () => {
    const onTransportsChanged = vi.fn();
    const link = makeLink(createLink().mine, { events: { onTransportsChanged } });
    const close = vi.fn(async () => {});
    const endpoint = { transport: "iroh/1" as const, descriptor: {}, onConnection: null, onDescriptor: null, onUnavailable: null as null | (() => void), connect: vi.fn(), close };
    link.registerEndpoint(endpoint);
    expect(link.availableTransports).toEqual(["webrtc/1", "iroh/1"]);
    endpoint.onUnavailable!();
    expect(link.availableTransports).toEqual(["webrtc/1"]);
    expect(onTransportsChanged).toHaveBeenCalledOnce();
    link.registerEndpoint(endpoint);
    expect(link.canReleaseEndpoint("iroh/1")).toBe(true);
    await link.releaseEndpoint("iroh/1");
    expect(close).toHaveBeenCalledOnce();
    expect(link.availableTransports).toEqual(["webrtc/1"]);
  });
});

describe("legacy data link frames", () => {
  it("greets with version, services and nick, and flushes messages still waiting in Pkarr", async () => {
    const onPresence = vi.fn(), onMessage = vi.fn();
    const t = legacyPair([{ nick: "Ann", getServices: () => [{ id: "web", type: "http" }] }, { events: { onPresence, onMessage } }]);
    const send = vi.spyOn(t.ca, "send");
    await t.a.session.sendMessage("queued", 7);
    t.attach();
    expect(sentFrames(send)[0]).toEqual({ t: "hello", v: 1, svc: { v: 1, s: [{ i: "web", t: "http" }] }, nick: "Ann" });
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledWith({ text: "queued", timestamp: 7, via: "datalink" }));
    expect(t.b.presence).toMatchObject({ online: true, services: [{ id: "web", type: "http" }] });
    expect(t.b.isDataLinkOpen).toBe(true);
  });

  it("carries chat and call signals, falling back to Pkarr for a message too long for the link", async () => {
    const onMessage = vi.fn(), onCallSignal = vi.fn();
    const t = legacyPair([{}, { events: { onMessage, onCallSignal } }]);
    t.attach();
    const pkarr = vi.spyOn(t.a.session, "sendMessage").mockResolvedValue(null);
    const call = vi.spyOn(t.a.session, "setCallSignal").mockResolvedValue();
    expect(await t.a.sendMessage("hi", 3)).toBeNull();
    await t.a.setCallSignal("ring");
    await vi.waitFor(() => expect(onCallSignal).toHaveBeenCalledWith("ring"));
    expect(onMessage).toHaveBeenCalledWith({ text: "hi", timestamp: 3, via: "datalink" });
    expect(call).toHaveBeenCalledWith("ring");
    expect(pkarr).not.toHaveBeenCalled();
    const long = "x".repeat(16 * 1024 / 4 + 1);
    await t.a.sendMessage(long, 4);
    expect(pkarr).toHaveBeenCalledWith(long, 4);
    vi.spyOn(t.ca, "send").mockImplementation(() => { throw new Error("closing"); });
    await t.a.sendMessage("fallback", 5);
    expect(pkarr).toHaveBeenLastCalledWith("fallback", 5);
    await t.a.setCallSignal("ring again");
    expect(call).toHaveBeenLastCalledWith("ring again");
  });

  it("ignores malformed control frames and chunks, and answers a ping with the same timestamp", async () => {
    const onMessage = vi.fn(), onCallSignal = vi.fn(), onPaymentRequest = vi.fn();
    const t = legacyPair([{}, { events: { onMessage, onCallSignal, onPaymentRequest } }]);
    t.attach();
    const send = vi.spyOn(t.cb, "send");
    for (const bad of [
      "garbage", "null", '{"t":"unknown"}',
      { t: "m", ts: "1", m: "x" }, { t: "m", ts: 1, m: "x".repeat(16 * 1024 + 1) },
      { t: "call", s: 5 }, { t: "pay-req", id: "x", ts: 1, v: "1", u: "sat", e: [] },
      { t: "rst", id: 1, d: "z" }, { t: "ping", ts: "now" },
      { t: "svc", svc: { v: 0, s: [] } },
      new Uint8Array([1, 2]), new Uint8Array([9, 0, 0, 0, 1, 0, 1]), new Uint8Array(16 * 1024 + 1),
    ]) t.toB(bad);
    // Resets and stray chunks for streams nobody opened are harmless.
    for (const d of ["q", "s", "f"]) t.toB({ t: "rst", id: 77, d, e: "gone" });
    for (const kind of Object.values(CHUNK_KIND)) t.toB(encodeChunk({ kind, id: 77, end: true, payload: new Uint8Array([1]) }));
    t.toB({ t: "pong", ts: 1 });
    t.toB({ t: "ping", ts: 99 });
    await vi.waitFor(() => expect(sentFrames(send)).toContainEqual({ t: "pong", ts: 99 }));
    expect(onMessage).not.toHaveBeenCalled();
    expect(onCallSignal).not.toHaveBeenCalled();
    expect(onPaymentRequest).not.toHaveBeenCalled();
    expect(t.b.isDataLinkOpen).toBe(true);
  });

  it("offers only Cashu and Lightning and carries payments, but never an ask", async () => {
    const eb = payEvents();
    const t = legacyPair([{}, { events: eb }]);
    t.attach();
    expect(t.a.allowsPayment("cashu")).toBe(true);
    expect(t.a.allowsPayment("lightning")).toBe(true);
    expect(t.a.allowsPayment("arkade")).toBe(false);
    expect(t.a.peerAllowsPayment("cashu")).toBe(false);
    expect(t.a.peerAllowsHold).toBe(false);
    await expect(t.a.sendPaymentAsk({ id: "ask-00001", timestamp: 1, amount: { value: "1", asset: "sat" }, method: "bark" })).rejects.toThrow(/paired chat/);
    await t.a.sendPaymentRequest({ id: "request-1", timestamp: 1, amount: { value: "2", asset: "sat" }, endpoints: [["cashu", "{}"]] });
    await t.a.sendPayment({ id: "payment-1", timestamp: 2, amount: { value: "2", asset: "sat" }, endpoint: ["cashu", "token"] });
    t.a.sendPaymentResult({ id: "payment-0", ok: true, credited: "1" });
    await vi.waitFor(() => expect(eb.onPaymentResult).toHaveBeenCalledWith({ id: "payment-0", ok: true, credited: "1", error: undefined }));
    expect(eb.onPaymentRequest).toHaveBeenCalledWith(expect.objectContaining({ id: "request-1", amount: { value: "2", asset: "sat" } }));
    expect(eb.onPayment).toHaveBeenCalledWith(expect.objectContaining({ id: "payment-1", endpoint: ["cashu", "token"] }));
  });

  it("serves HTTP requests and files over the link", async () => {
    const localFetch = okFetch();
    const { sink, text } = memorySink();
    const onFileComplete = vi.fn();
    const t = legacyPair([{ events: { onFileComplete } }, { getHostedHttpService: webService, localFetch, events: { onFileIncoming: () => sink } }]);
    t.attach();
    const response = await t.a.request("web", { method: "GET", path: "/x" });
    expect(response.status).toBe(200);
    expect(utf8Decode(await response.bytes())).toBe("ok");
    await expect(t.a.sendFile({ id: "bad id!", name: "a.txt", mime: "text/plain", size: 5, timestamp: 1 }, bytesOf(utf8Encode("abcde"))))
      .rejects.toThrow("The peer refused the file");
    await t.a.sendFile({ id: "abcdefgh12345678", name: "a.txt", mime: "text/plain", size: 5, timestamp: 1 }, bytesOf(utf8Encode("abcde")));
    await vi.waitFor(() => expect(onFileComplete).toHaveBeenCalledWith("abcdefgh12345678", "out"));
    expect(text()).toBe("abcde");
  });

  it("re-announces services on the link and in Pkarr, and a hang-up closes everything", async () => {
    let services = [{ id: "a", type: "a" }];
    const t = legacyPair([{ getServices: () => services }, {}]);
    t.attach();
    const advertise = vi.spyOn(t.a.session, "refreshAdvertisement").mockResolvedValue();
    services = [{ id: "b", type: "b" }];
    await t.a.refreshServices();
    expect(advertise).toHaveBeenCalled();
    await vi.waitFor(() => expect(t.b.presence.services).toEqual([{ id: "b", type: "b" }]));
    t.a.disconnect();
    expect(t.a.isDataLinkOpen).toBe(false);
    await expect(t.a.sendPayment({ id: "payment-1", timestamp: 2, amount: { value: "2", asset: "sat" }, endpoint: ["cashu", "t"] })).rejects.toThrow();
  });
});

describe("native transports", () => {
  const binding: NativeBinding = { transport: "iroh/1", context: "c".repeat(64), identities: ["a".repeat(64), "b".repeat(64)] };
  const endpoint = (connect: NativeEndpoint["connect"] = vi.fn()) =>
    ({ transport: "iroh/1" as const, descriptor: { node: "n" }, onConnection: null, onDescriptor: null, connect, close: vi.fn(async () => {}) }) as unknown as NativeEndpoint & { onConnection: (c: BoundChannel) => void };
  const irohFirst: Side = { native: { preferred: "iroh/1", fallback: true } };

  function nativePair(dialer?: NativeEndpoint["connect"]) {
    const invitation = createLink();
    const onDataLinkState = vi.fn();
    const a = makeLink(invitation.mine, { ...irohFirst, events: { onDataLinkState } });
    const b = makeLink(invitation.invite, irohFirst);
    const ea = endpoint(dialer), eb = endpoint();
    a.registerEndpoint(ea); b.registerEndpoint(eb);
    return { a, b, ea, eb, onDataLinkState };
  }
  const open = async (...links: GhostLink[]) => vi.waitFor(() => { for (const link of links) expect(link.isDataLinkOpen).toBe(true); });

  it("an incoming native connection opens a paired session, and a second one while open is closed", async () => {
    const t = nativePair();
    const [ca, cb] = createChannelPair();
    t.ea.onConnection({ channel: ca, binding });
    t.eb.onConnection({ channel: cb, binding });
    await open(t.a, t.b);
    expect(t.onDataLinkState).toHaveBeenLastCalledWith("open");
    const [extra] = createChannelPair();
    const close = vi.spyOn(extra, "close");
    t.ea.onConnection({ channel: extra, binding });
    expect(close).toHaveBeenCalled();
    expect(t.a.isDataLinkOpen).toBe(true);
    // A native session going away is reported as the link going idle.
    t.a.disconnect();
    expect(t.onDataLinkState).toHaveBeenLastCalledWith("idle");
  });

  it("after the peer asks to reconnect, its next native connection replaces the open session", async () => {
    const t = nativePair();
    const [ca, cb] = createChannelPair();
    t.ea.onConnection({ channel: ca, binding });
    t.eb.onConnection({ channel: cb, binding });
    await open(t.a, t.b);
    const acks = vi.spyOn(ca, "send");
    cb.send(JSON.stringify({ t: "paired-reconnect" }));
    await vi.waitFor(() => expect(sentFrames(acks)).toContainEqual({ t: "paired-reconnect-ack" }));
    const [xa, xb] = createChannelPair();
    t.ea.onConnection({ channel: xa, binding });
    expect((ca as FrameChannel & { closed: boolean }).closed).toBe(true);
    t.eb.onConnection({ channel: xb, binding });
    await open(t.a, t.b);
    expect((t.a as unknown as Internal).channel).toBe(xa);
  });

  it("an incoming connection on a transport this side does not offer is closed", async () => {
    const link = makeLink(createLink().mine, { native: { preferred: "webrtc/1", fallback: false } });
    const e = endpoint();
    link.registerEndpoint(e);
    const [channel] = createChannelPair();
    const close = vi.spyOn(channel, "close");
    e.onConnection({ channel, binding });
    expect(close).toHaveBeenCalled();
    expect(link.isDataLinkOpen).toBe(false);
  });

  it("dials the contact's remembered native transport and resolves once the session is open", async () => {
    const invitation = createLink();
    const [ca, cb] = createChannelPair();
    const a = makeLink(invitation.mine, { native: { preferred: "iroh/1", fallback: true, peerDescriptors: { "iroh/1": { node: "b" } }, peerTransports: ["iroh/1"] } });
    const b = makeLink(invitation.invite, irohFirst);
    const dial = vi.fn(async () => ({ channel: ca, binding }));
    a.registerEndpoint(endpoint(dial));
    const eb = endpoint();
    b.registerEndpoint(eb);
    const connecting = a.connect();
    await vi.waitFor(() => expect(dial).toHaveBeenCalledWith({ node: "b" }));
    eb.onConnection({ channel: cb, binding });
    await expect(connecting).resolves.toBeUndefined();
    expect(a.canReleaseEndpoint("iroh/1")).toBe(false);
  });

  it("reports a native dial that fails, and one with no known address for the contact", async () => {
    const failing = makeLink(createLink().mine, { native: { preferred: "iroh/1", fallback: false, peerDescriptors: { "iroh/1": {} }, peerTransports: ["iroh/1"] } });
    failing.registerEndpoint(endpoint(vi.fn(async () => { throw new Error("iroh: no route"); })));
    await expect(failing.connect()).rejects.toThrow("iroh: no route");
    const unknown = makeLink(createLink().mine, { native: { preferred: "iroh/1", fallback: false, peerTransports: ["iroh/1"] } });
    unknown.registerEndpoint(endpoint());
    await expect(unknown.connect()).rejects.toThrow(/Peer native address unavailable/);
  });
});

describe("changing transport on an open session", () => {
  const binding: NativeBinding = { transport: "iroh/1", context: "d".repeat(64), identities: ["a".repeat(64), "b".repeat(64)] };

  /** Two links open over WebRTC that can also reach each other over iroh, through an in-memory "network". */
  function switchable(dialFails = false) {
    const invitation = createLink();
    const onPairingStateA = vi.fn(), onPairingStateB = vi.fn();
    const links = [
      makeLink(invitation.mine, { native: { preferred: "webrtc/1", fallback: true }, events: { onMessage: vi.fn(), onPairingState: onPairingStateA } }),
      makeLink(invitation.invite, { native: { preferred: "webrtc/1", fallback: true }, events: { onMessage: vi.fn(), onPairingState: onPairingStateB } }),
    ];
    const endpoints = links.map(() => ({ transport: "iroh/1" as const, descriptor: { node: "n" }, onConnection: null, onDescriptor: null,
      close: vi.fn(async () => {}) })) as unknown as (NativeEndpoint & { onConnection: (c: BoundChannel) => void })[];
    const dials = [vi.fn(), vi.fn()];
    endpoints.forEach((endpoint, i) => {
      endpoint.connect = async () => {
        dials[i]();
        if (dialFails) throw new Error("iroh: no route");
        const [mine, theirs] = createChannelPair();
        queueMicrotask(() => endpoints[1 - i].onConnection({ channel: theirs, binding }));
        return { channel: mine, binding };
      };
      links[i].registerEndpoint(endpoint);
    });
    const [ca, cb] = createChannelPair();
    (links[0] as unknown as Internal).attach(ca);
    (links[1] as unknown as Internal).attach(cb);
    return { a: links[0], b: links[1], ca, cb, dials, onPairingStateA, onPairingStateB };
  }
  const transportOf = (state: ReturnType<typeof vi.fn>) => state.mock.lastCall?.[0]?.transport;

  it("moves an open session onto iroh once the new connection authenticates, and closes the old one", async () => {
    const t = switchable();
    await vi.waitFor(() => { expect(t.a.isDataLinkOpen).toBe(true); expect(t.b.isDataLinkOpen).toBe(true); });
    await t.a.setTransportPreference("iroh/1", false);
    await vi.waitFor(() => { expect(transportOf(t.onPairingStateA)).toBe("iroh/1"); expect(transportOf(t.onPairingStateB)).toBe("iroh/1"); });
    await vi.waitFor(() => expect(t.a.isDataLinkOpen && t.b.isDataLinkOpen).toBe(true));
    expect((t.ca as FrameChannel & { closed: boolean }).closed).toBe(true);
    expect(t.dials[0].mock.calls.length + t.dials[1].mock.calls.length).toBe(1);
    expect(await t.a.sendMessage("over iroh")).toBeNull();
  });

  it("keeps the WebRTC session when the iroh connection cannot be made and both allow fallback", async () => {
    const t = switchable(true);
    await vi.waitFor(() => { expect(t.a.isDataLinkOpen).toBe(true); expect(t.b.isDataLinkOpen).toBe(true); });
    await t.a.setTransportPreference("iroh/1", true);
    await vi.waitFor(() => expect(t.dials[0].mock.calls.length + t.dials[1].mock.calls.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(t.a.isDataLinkOpen && t.b.isDataLinkOpen).toBe(true));
    expect(transportOf(t.onPairingStateA)).toBe("webrtc/1");
    expect((t.ca as FrameChannel & { closed: boolean }).closed).toBe(false);
    expect(await t.a.sendMessage("still on webrtc")).toBeNull();
  });

  it("while moving back to WebRTC, takes ICE signaling on the session only when the contact's key signed it", async () => {
    const invitation = createLink();
    const seeds = [createIdentity().seedB64, createIdentity().seedB64];
    const nativeBinding: NativeBinding = { transport: "iroh/1", context: "e".repeat(64), identities: ["a".repeat(64), "b".repeat(64)] };
    const received = [vi.fn(), vi.fn()];
    const links = [invitation.mine, invitation.invite].map((params, i) => {
      const link = makeLink(params, { native: { preferred: "iroh/1", fallback: true }, events: { onMessage: received[i] } });
      (link as unknown as { options: GhostLinkOptions }).options.pairing!.credentials.seedB64 = seeds[i];
      return link;
    });
    const endpoints = links.map(() => ({ transport: "iroh/1" as const, descriptor: { node: "n" }, onConnection: null, onDescriptor: null,
      connect: vi.fn(), close: vi.fn(async () => {}) })) as unknown as (NativeEndpoint & { onConnection: (c: BoundChannel) => void })[];
    endpoints.forEach((endpoint, i) => links[i].registerEndpoint(endpoint));
    const [ca, cb] = createChannelPair();
    endpoints[0].onConnection({ channel: ca, binding: nativeBinding });
    endpoints[1].onConnection({ channel: cb, binding: nativeBinding });
    await vi.waitFor(() => { expect(links[0].isDataLinkOpen).toBe(true); expect(links[1].isDataLinkOpen).toBe(true); });
    const rtc = links.map(link => vi.spyOn(link.dataLink, "connect").mockReturnValue(new Promise(() => {})));
    const handled = links.map(link => vi.spyOn(link.dataLink, "handleSignal").mockResolvedValue());
    await links[0].setTransportPreference("webrtc/1", true);
    await vi.waitFor(() => expect(rtc[0].mock.calls.length + rtc[1].mock.calls.length).toBe(1));
    const dialer = rtc[0].mock.calls.length ? 0 : 1, other = 1 - dialer;
    // The dialling side receives the answer from the other one.
    const channelTo = dialer === 0 ? cb : ca;
    const signal = JSON.stringify({ t: "a", ts: Date.now(), u: "ufrag", p: "password", f: "a".repeat(64), s: "active", c: [] });
    const from = links[other].myPubKeyZ32, to = links[dialer].myPubKeyZ32;
    const forged = signPairedSignal(signal, createIdentity().seedB64, from, to);
    channelTo.send(JSON.stringify({ t: "paired-rtc", signal: forged }));
    channelTo.send(JSON.stringify({ t: "paired-rtc", signal: 42 }));
    channelTo.send(JSON.stringify({ t: "paired-rtc", signal }));
    const genuine = signPairedSignal(signal, seeds[other], from, to);
    channelTo.send(JSON.stringify({ t: "paired-rtc", signal: genuine }));
    const barrier = newId();
    channelTo.send(JSON.stringify({ t: "paired-message", id: barrier, ts: 1, m: "barrier" }));
    await vi.waitFor(() => expect(received[dialer]).toHaveBeenCalledWith(expect.objectContaining({ id: barrier })));
    expect(handled[dialer]).toHaveBeenCalledOnce();
    expect(handled[dialer].mock.calls[0][0]).toContain('"u":"ufrag"');
  });

  it("reports a failed change, and blocks the old transport, when this side no longer allows it", async () => {
    const t = switchable(true);
    await vi.waitFor(() => { expect(t.a.isDataLinkOpen).toBe(true); expect(t.b.isDataLinkOpen).toBe(true); });
    await t.a.setTransportPreference("iroh/1", false);
    await vi.waitFor(() => expect([...t.onPairingStateA.mock.calls, ...t.onPairingStateB.mock.calls]
      .some(([state]) => /iroh: no route/.test(state.transitionError ?? ""))).toBe(true));
    await vi.waitFor(() => expect(t.onPairingStateA.mock.lastCall?.[0]).toMatchObject({ status: "error" }));
    expect(t.a.isDataLinkOpen).toBe(false);
    expect(await t.a.sendMessage("blocked")).toMatch(/connect before sending/);
  });
});

describe("dialling on its own", () => {
  const online = { online: true, lastPacketAt: 1, services: [] };

  it("only the side with the lower key dials when the contact is seen, and failed attempts wait longer each time, up to a cap", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const invitation = createLink();
    const links = [makeLink(invitation.mine, { autoConnect: true }), makeLink(invitation.invite, { autoConnect: true })];
    const dials = links.map(link => {
      vi.spyOn(link.session, "peerPresence", "get").mockReturnValue(online);
      vi.spyOn(link.session, "pollNow").mockImplementation(() => {});
      vi.spyOn(link.session, "refreshAdvertisement").mockResolvedValue();
      return vi.spyOn(link.dataLink, "connect").mockResolvedValue();
    });
    for (const link of links) link.wake();
    await vi.waitFor(() => expect(dials[0].mock.calls.length + dials[1].mock.calls.length).toBe(1));
    const lower = links[0].myPubKeyZ32 < links[1].myPubKeyZ32 ? 0 : 1;
    expect(dials[lower]).toHaveBeenCalledOnce();
    const again = () => (links[lower] as unknown as { maybeAutoConnect(p: typeof online): void }).maybeAutoConnect(online);
    const count = async () => { await Promise.resolve(); return dials[lower].mock.calls.length; };
    // Waits after each attempt that did not open a session: 40 s, 80 s, 160 s, then at most 3 minutes.
    let at = 1_000_000, expected = 1;
    for (const wait of [40_000, 80_000, 160_000, 180_000, 180_000]) {
      vi.setSystemTime(at + wait - 1);
      again();
      expect(await count(), `still waiting ${wait} ms`).toBe(expected);
      at += wait;
      vi.setSystemTime(at);
      again();
      expect(await count()).toBe(++expected);
    }
    // Someone opening the chat starts the wait over.
    links[lower].wake();
    expect(await count()).toBe(expected + 1);
  });

  it("a link without auto-connect never dials on its own", async () => {
    const link = makeLink(createLink().mine, {});
    vi.spyOn(link.session, "peerPresence", "get").mockReturnValue(online);
    vi.spyOn(link.session, "pollNow").mockImplementation(() => {});
    vi.spyOn(link.session, "refreshAdvertisement").mockResolvedValue();
    const dial = vi.spyOn(link.dataLink, "connect").mockResolvedValue();
    link.wake();
    await Promise.resolve();
    expect(dial).not.toHaveBeenCalled();
  });
});

describe("DHT-only delivery", () => {
  function dhtLink(peerKey?: string) {
    const credentials = { seedB64: createIdentity().seedB64, peerKey };
    const verifyPeer = vi.fn(async () => {});
    const onPairingState = vi.fn();
    const link = new GhostLink({ params: { ...createLink().mine, profile: "paired-chat/1" },
      pairing: { credentials, pinPeer: vi.fn(async () => {}), verifyPeer },
      dht: { state: { sequence: 0, peerSequence: 0 }, save: vi.fn(async () => {}) },
      transport: { publish: vi.fn(async () => {}), resolve: async () => null, describe: () => ({ protocol: "test", relays: [] }) },
      createPeerConnection: () => { throw new Error("no dial in this test"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
      events: { onPairingState } });
    live.push(link);
    return { link, credentials, verifyPeer, onPairingState };
  }

  it("switching to DHT-only closes live delivery and validates text for the DHT, and switching back restarts discovery", async () => {
    const { link, onPairingState } = dhtLink();
    const stop = vi.spyOn(link.session, "stop"), start = vi.spyOn(link.session, "start").mockImplementation(() => {});
    expect(link.textDelivery).toBe("unavailable");
    expect(link.validateText("hi", 1, newId())).toBe("No authenticated text delivery method is available.");
    await link.setDeliveryMode("dht");
    expect(stop).toHaveBeenCalledWith(false);
    expect(link.textDelivery).toBe("dht");
    expect(link.dhtDelivery).toBeDefined();
    expect(onPairingState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "connecting" }));
    expect(link.validateText("hi", 1, "bad id")).toBe("Invalid message.");
    expect(link.validateText("x".repeat(64 * 1024), 1, newId())).toMatch(/DHT text is limited/);
    await expect(link.connect()).rejects.toThrow(/DHT-only delivery does not open a live connection/);
    await link.setDeliveryMode("stream");
    expect(start).toHaveBeenCalled();
    expect(link.textDelivery).toBe("unavailable");
  });

  it("confirming a DHT contact needs the current comparison code", async () => {
    const { link, credentials, verifyPeer, onPairingState } = dhtLink(createIdentity().pubKeyZ32);
    await link.setDeliveryMode("dht");
    const code = onPairingState.mock.lastCall?.[0].code as string;
    expect(code).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){5}$/);
    expect(onPairingState).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ready", verified: false }));
    await expect(link.confirmPair("0000 0000 0000 0000 0000 0000")).rejects.toThrow("Compare the current code again.");
    expect(verifyPeer).not.toHaveBeenCalled();
    await link.confirmPair(code);
    expect(onPairingState).toHaveBeenLastCalledWith(expect.objectContaining({ verified: true }));
    expect(verifyPeer).toHaveBeenCalledWith(credentials.peerKey);
    expect((credentials as { verifiedPeerKey?: string }).verifiedPeerKey).toBe(credentials.peerKey);
  });

  it("a fresh link packet from a DHT-only contact is it leaving DHT-only: its mailbox is read at once, once per packet", async () => {
    const { link } = dhtLink(createIdentity().pubKeyZ32);
    const inner = link as unknown as { dht: { refresh(): void; state: { peerMode?: string } }; peerMayHaveLeftDht(p: object): void };
    const refresh = vi.spyOn(inner.dht, "refresh").mockImplementation(() => {});
    const packet = (age: number) => ({ online: true, lastPacketAt: Date.now() - age, services: [] });
    inner.peerMayHaveLeftDht(packet(0));
    expect(refresh, "the contact is not known to be DHT-only").not.toHaveBeenCalled();
    inner.dht.state.peerMode = "dht";
    inner.peerMayHaveLeftDht(packet(5 * 60_000));
    expect(refresh, "an old packet, from before it went DHT-only").not.toHaveBeenCalled();
    inner.peerMayHaveLeftDht({ ...packet(0), online: false, services: null });
    expect(refresh, "a packet that advertises nothing (a DHT-only app publishes one when it wakes)").not.toHaveBeenCalled();
    const fresh = packet(1_000);
    inner.peerMayHaveLeftDht(fresh);
    inner.peerMayHaveLeftDht(fresh);
    expect(refresh).toHaveBeenCalledOnce();
    await link.setDeliveryMode("dht");
    inner.peerMayHaveLeftDht(packet(0));
    expect(refresh, "this side is DHT-only itself").toHaveBeenCalledOnce();
  });
});
