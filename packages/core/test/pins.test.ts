import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostLink, type GhostLinkOptions } from "../src/ghostlink";
import { createLink } from "../src/invite";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { GroupSession } from "../src/groupSession";
import { PIN_CAPABILITY, SessionCapabilities } from "../src/pairedCapabilities";
import {
  GROUP_PIN_FRAME, PIN_FRAME, PIN_LIMITS, PINNED_FRAME, mayPin, nextPinNumber, parsePinFrame, parsePinnedFrame, pinFrame, pinIsNewer, pinnedFrame, readPin,
  type WirePin,
} from "../src/pins";
import type { BoundChannel, NativeBinding, NativeEndpoint } from "../src/pairedTransports";
import type { FrameChannel } from "../src/frames";
// covers: chat.pins.wire, groups.protocol.pins

const ID = "AAAAAAAAAAAAAAAAAAAAAA";

describe("pin frames", () => {
  it("encodes and decodes a pin, an unpin and a receipt", () => {
    const frame = pinFrame({ id: ID, n: 5 });
    expect(frame).toBe(`{"t":"paired-pin","id":"${ID}","n":5}`);
    expect(parsePinFrame(JSON.parse(frame))).toEqual({ id: ID, n: 5 });
    expect(parsePinFrame({ t: PIN_FRAME, id: "", n: 6 })).toEqual({ id: "", n: 6 });
    expect(pinnedFrame(5)).toBe('{"t":"paired-pinned","n":5}');
    expect(parsePinnedFrame(JSON.parse(pinnedFrame(5)))).toBe(5);
  });

  it("refuses a malformed pin or receipt", () => {
    for (const bad of [
      { t: PIN_FRAME, id: ID, n: 0 }, { t: PIN_FRAME, id: ID, n: 1.5 }, { t: PIN_FRAME, id: ID, n: "1" }, { t: PIN_FRAME, id: "bad id!", n: 1 },
      { t: PIN_FRAME, id: "x".repeat(129), n: 1 }, { t: PIN_FRAME, n: 1 }, { t: PIN_FRAME, id: null, n: 1 }, { t: "paired-reaction", id: ID, n: 1 },
    ]) expect(parsePinFrame(bad as Record<string, unknown>), JSON.stringify(bad)).toBeNull();
    for (const bad of [{ t: PINNED_FRAME }, { t: PINNED_FRAME, n: -1 }, { t: "paired-reacted", n: 1 }]) expect(parsePinnedFrame(bad)).toBeNull();
    expect(readPin([ID, 1])).toBeNull();
  });
});

describe("the last pin wins", () => {
  it("by number, whatever order the pins arrive in, and the same on every side", () => {
    const pins: WirePin[] = [{ id: "a", n: 10 }, { id: "", n: 30 }, { id: "b", n: 20 }];
    const settle = (order: WirePin[]) => order.reduce<WirePin | undefined>((shown, pin) => pinIsNewer(shown, pin) ? pin : shown, undefined);
    expect(settle(pins)).toEqual({ id: "", n: 30 });
    expect(settle([...pins].reverse())).toEqual({ id: "", n: 30 });
    // Two sides at the same millisecond: the id settles it, the same way on both.
    expect(settle([{ id: "a", n: 5 }, { id: "b", n: 5 }])).toEqual(settle([{ id: "b", n: 5 }, { id: "a", n: 5 }]));
    // A late copy of the pin shown changes nothing.
    expect(pinIsNewer({ id: "a", n: 5 }, { id: "a", n: 5 })).toBe(false);
  });

  it("a new pin goes past the one shown, even when the clock is behind it", () => {
    expect(nextPinNumber(0, 1_000)).toBe(1_000);
    expect(nextPinNumber(5_000, 1_000)).toBe(5_001);
    expect(pinIsNewer({ id: "a", n: 5_000 }, { id: "b", n: nextPinNumber(5_000, 1_000) })).toBe(true);
  });
});

describe("who may pin in a group", () => {
  it("any member of a private group; only the admin of a community", () => {
    expect(mayPin("mesh", "bob", "alice")).toBe(true);
    expect(mayPin("mesh", "alice", "alice")).toBe(true);
    expect(mayPin("community", "alice", "alice")).toBe(true);
    expect(mayPin("community", "bob", "alice")).toBe(false);
    expect(mayPin("community", "bob", undefined)).toBe(false);
  });
});

describe("a private group's signed pin", () => {
  async function duo() {
    const sessions = new Map<string, GroupSession>();
    const hooks = { save: async () => {}, send: (to: string, frame: unknown) => { void sessions.get(to)?.handle(alice.myKey, JSON.parse(JSON.stringify(frame))); }, message: () => {}, changed: () => {} };
    const alice = new GroupSession(GroupSession.create("Crew"), hooks);
    sessions.set(alice.myKey, alice);
    const seed = createIdentity().seedB64, invite = alice.inviteFrame();
    const welcome = await alice.admit(identityFromSeedB64(seed).pubKeyZ32);
    const joined = GroupSession.join({ name: invite.name, admin: invite.admin }, welcome.slice(0, -1), welcome[welcome.length - 1], seed);
    if ("error" in joined) throw new Error(joined.error);
    const bob = new GroupSession(joined.state, { ...hooks, send: () => {} });
    sessions.set(bob.myKey, bob);
    return { alice, bob };
  }

  it("names its pinner, and any member can pass it on as it is", async () => {
    const { alice, bob } = await duo();
    const frame = alice.pinFrame({ id: "x:0:1", n: 7 });
    expect(frame.t).toBe(GROUP_PIN_FRAME);
    expect(bob.signedPin(JSON.parse(JSON.stringify(frame)))).toEqual({ member: alice.myKey, pin: { id: "x:0:1", n: 7 }, frame });
    // An unpin is signed too.
    expect(bob.signedPin(alice.pinFrame({ id: "", n: 8 }))?.pin).toEqual({ id: "", n: 8 });
  });

  it("refuses one altered on the way, forged, or of another group", async () => {
    const { alice, bob } = await duo();
    const frame = alice.pinFrame({ id: "x:0:1", n: 7 });
    expect(bob.signedPin({ ...frame, id: "x:0:2" })).toBeNull();
    expect(bob.signedPin({ ...frame, n: 8 })).toBeNull();
    expect(bob.signedPin({ ...frame, k: bob.myKey })).toBeNull();
    expect(bob.signedPin({ ...frame, g: "other" })).toBeNull();
    expect(bob.signedPin({ ...frame, k: createIdentity().pubKeyZ32 })).toBeNull();
  });

  it("an older member's session drops it: nothing taken, nothing passed on", async () => {
    const { alice, bob } = await duo();
    expect(await bob.handle(alice.myKey, alice.pinFrame({ id: "x:0:1", n: 7 }))).toEqual([]);
  });
});

// Two GhostLinks over an in-memory stand-in for Iroh, each with a real PairedSession handshake (as reactions.test.ts).

const hex = (c: string) => c.repeat(64);

function channelPair(drop: { a?: (data: string) => boolean; b?: (data: string) => boolean } = {}, sent?: string[]): [FrameChannel, FrameChannel] {
  type End = FrameChannel & { peer?: End; closed: boolean; receive(data: string): void };
  const make = (filter?: (data: string) => boolean, log?: string[]): End => {
    let reader: FrameChannel["onMessage"] = null;
    const waiting: string[] = [];
    return {
      closed: false, bufferedAmount: 0, onClose: null, drained: () => Promise.resolve(),
      get onMessage() { return reader; },
      set onMessage(value) { reader = value; if (value) for (const data of waiting.splice(0)) value(data); },
      receive(data) { if (this.closed) return; if (reader) reader(data); else waiting.push(data); },
      send(data) {
        if (this.closed) throw new Error("Channel closed");
        if (typeof data !== "string") throw new Error("Text only");
        log?.push(data);
        if (filter?.(data)) return;
        queueMicrotask(() => this.peer?.receive(data));
      },
      close() { if (this.closed) return; this.closed = true; this.onClose?.(); this.peer?.close(); },
    };
  };
  const a = make(drop.a, sent), b = make(drop.b);
  a.peer = b; b.peer = a;
  return [a, b];
}

interface Side { link: GhostLink; pins: WirePin[]; receipts: number[]; support: boolean[]; sent: string[] }

const links: GhostLink[] = [];
afterEach(async () => { await Promise.all(links.splice(0).map(link => link.stop(false))); });

function pair(options: { a?: Partial<GhostLinkOptions>; b?: Partial<GhostLinkOptions>; drop?: { a?: (data: string) => boolean; b?: (data: string) => boolean } } = {}) {
  const invitation = createLink();
  const [ia, ib] = [createIdentity(), createIdentity()];
  const binding: NativeBinding = { transport: "iroh/1", context: hex("c"), identities: [hex("a"), hex("b")] };
  const endpoints: Record<"a" | "b", NativeEndpoint> = {} as never;
  const make = (name: "a" | "b", params: typeof invitation.mine, me: typeof ia, peer: typeof ia, extra: Partial<GhostLinkOptions> = {}): Side => {
    const pins: WirePin[] = [], receipts: number[] = [], support: boolean[] = [], sent: string[] = [];
    const endpoint: NativeEndpoint = {
      transport: "iroh/1", descriptor: { name }, onConnection: null, onDescriptor: null,
      close: async () => {},
      connect: async (): Promise<BoundChannel> => {
        const [mine, theirs] = channelPair(options.drop, sent);
        queueMicrotask(() => endpoints[name === "a" ? "b" : "a"].onConnection?.({ channel: theirs, binding }));
        return { channel: mine, binding };
      },
    };
    endpoints[name] = endpoint;
    const link = new GhostLink({
      params: { ...params, profile: "paired-chat/1" },
      rtcAvailable: false,
      native: { preferred: "iroh/1", fallback: false, peerDescriptors: { "iroh/1": { name: name === "a" ? "b" : "a" } }, peerTransports: ["iroh/1"] },
      pairing: { credentials: { seedB64: me.seedB64, peerKey: peer.pubKeyZ32, requireSignedSignals: true }, pinPeer: async () => {}, trustOnFirstUse: true },
      transport: { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "memory", relays: [] }) },
      createPeerConnection: () => { throw new Error("The chat runs on Iroh here: no WebRTC"); },
      localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
      pinSupport: true,
      ...extra,
      events: {
        onPin: pin => { pins.push(pin); return true; },
        onPinReceipt: n => { receipts.push(n); },
        onPinSupport: on => { support.push(on); },
        ...extra.events,
      },
    });
    links.push(link);
    link.registerEndpoint(endpoint);
    return { link, pins, receipts, support, sent };
  };
  return { a: make("a", invitation.mine, ia, ib, options.a), b: make("b", invitation.invite, ib, ia, options.b) };
}

async function live(a: Side, b: Side): Promise<void> {
  await a.link.connect(10_000);
  await vi.waitFor(() => expect(a.link.isDataLinkOpen && b.link.isDataLinkOpen).toBe(true));
}

describe("pins on a paired session (pin/1)", () => {
  it("is a session capability both sides must list", () => {
    const caps = new SessionCapabilities(() => [PIN_CAPABILITY]);
    expect(caps.receive({ c: ["typing/1"] })).toEqual([]);
    expect(caps.receive({ c: ["pin/1"] })).toEqual([PIN_CAPABILITY]);
    expect(caps.agreed(PIN_CAPABILITY)).toBe(true);
  });

  it("A pins, B takes it and confirms; nothing goes before both say pin/1", async () => {
    const { a, b } = pair();
    expect(a.link.sendPin({ id: ID, n: 1 })).toMatch(/live/);
    await live(a, b);
    await vi.waitFor(() => expect(a.link.supportsPins && b.link.supportsPins).toBe(true));
    expect(a.support).toContain(true);
    expect(a.link.sendPin({ id: ID, n: 2 })).toBeNull();
    expect(a.link.sendPin({ id: "", n: 3 })).toBeNull();
    await vi.waitFor(() => expect(a.receipts).toEqual([2, 3]));
    expect(b.pins).toEqual([{ id: ID, n: 2 }, { id: "", n: 3 }]);
  });

  it("an app that does not offer pin/1 (an older one) gets nothing, and what it sends is not taken", async () => {
    const { a, b } = pair({ b: { pinSupport: false } });
    await live(a, b);
    await vi.waitFor(() => expect(a.link.sessionOffers.peer).not.toBeNull());
    expect(a.link.supportsPins).toBe(false);
    expect(a.link.sendPin({ id: ID, n: 1 })).toMatch(/does not show pins/);
    expect(a.sent.filter(data => data.includes(`"t":"${PIN_FRAME}"`))).toEqual([]);
  });

  it("an older app that never says its capabilities gets nothing", async () => {
    const { a, b } = pair({ drop: { b: data => data.includes('"t":"paired-capabilities"') } });
    await live(a, b);
    await vi.waitFor(() => expect(b.link.supportsPins).toBe(true));
    expect(a.link.supportsPins).toBe(false);
    expect(a.link.sendPin({ id: ID, n: 1 })).not.toBeNull();
  });

  it("caps what a contact may send per window: the rest go unconfirmed", async () => {
    const { a, b } = pair();
    await live(a, b);
    await vi.waitFor(() => expect(a.link.supportsPins && b.link.supportsPins).toBe(true));
    for (let n = 1; n <= PIN_LIMITS.receive + 5; n++) expect(a.link.sendPin({ id: ID, n })).toBeNull();
    await vi.waitFor(() => expect(a.receipts).toHaveLength(PIN_LIMITS.receive));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(b.pins).toHaveLength(PIN_LIMITS.receive);
  });
});
