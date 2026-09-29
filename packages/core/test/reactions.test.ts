import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostLink, type GhostLinkOptions } from "../src/ghostlink";
import { createLink } from "../src/invite";
import { createIdentity } from "../src/identity";
import { REACTIONS_CAPABILITY, SessionCapabilities } from "../src/pairedCapabilities";
import {
  QUICK_REACTIONS, REACTED_FRAME, REACTION_FRAME, REACTION_LIMITS, ReactionWindow, nextReactionNumber, parseReactedFrame, parseReactionFrame,
  queueReaction, reactedFrame, reactionEmoji, reactionFrame, reactionIsNewer, readDhtReactions, readReaction, type WireReaction,
} from "../src/reactions";
import type { BoundChannel, NativeBinding, NativeEndpoint } from "../src/pairedTransports";
import type { FrameChannel } from "../src/frames";
// covers: chat.reactions.wire

afterEach(() => { vi.useRealTimers(); });

const ID = "AAAAAAAAAAAAAAAAAAAAAA";

describe("reaction emoji", () => {
  it("takes one emoji, in one form", () => {
    for (const emoji of QUICK_REACTIONS) expect(reactionEmoji(emoji)).toBe(emoji);
    // A text-default pictograph gets its emoji selector; a redundant one goes: the same chip from any app.
    expect(reactionEmoji("\u2764")).toBe("\u2764\uFE0F");
    expect(reactionEmoji("\u{1F44D}\uFE0F")).toBe("\u{1F44D}");
    for (const emoji of ["👍🏽", "👨‍👩‍👧‍👦", "🏳️‍🌈", "🇧🇷", "1️⃣", "🏴󠁧󠁢󠁳󠁣󠁴󠁿", "❤️‍🔥", "©️"]) expect(reactionEmoji(emoji)).toBe(emoji);
  });

  it("refuses what is not exactly one emoji", () => {
    for (const bad of ["", "a", "1", "#", "ok", "👍👍", "👍 ", " 👍", "❤️❤️", "🏻", "\u200D", "\uFE0F", "👍\u0000", "\u202E👍", "<b>", "👍a",
      "👨‍👩‍👧‍👦".repeat(2), "🇧", "x".repeat(40), 1, null, undefined, {}, ["👍"]])
      expect(reactionEmoji(bad), JSON.stringify(bad)).toBeNull();
  });

  it("caps its length in bytes", () => {
    // Longer than the cap once the joiners are counted: refused even as one grapheme.
    const long = ["👩🏽", "🤝", "👩🏻"].join("\u200D") + "\u200D🦰";
    expect(new TextEncoder().encode(long).length).toBeGreaterThan(REACTION_LIMITS.emojiBytes);
    expect(reactionEmoji(long)).toBeNull();
  });
});

describe("reaction frames", () => {
  it("encodes and decodes a reaction and its receipt", () => {
    const frame = reactionFrame({ id: ID, e: "👍", n: 5 });
    expect(frame).toBe(`{"t":"paired-reaction","id":"${ID}","e":"👍","n":5}`);
    expect(parseReactionFrame(JSON.parse(frame))).toEqual({ id: ID, e: "👍", n: 5 });
    expect(reactedFrame(5)).toBe('{"t":"paired-reacted","n":5}');
    expect(parseReactedFrame(JSON.parse(reactedFrame(5)))).toBe(5);
    // Taken back: an empty emoji.
    expect(parseReactionFrame({ t: REACTION_FRAME, id: ID, e: "", n: 6 })).toEqual({ id: ID, e: "", n: 6 });
    // The emoji is read in its one form.
    expect(parseReactionFrame({ t: REACTION_FRAME, id: ID, e: "\u2764", n: 7 })?.e).toBe("\u2764\uFE0F");
  });

  it("refuses a malformed reaction or receipt", () => {
    for (const bad of [
      { t: REACTION_FRAME, id: ID, e: "ok", n: 1 }, { t: REACTION_FRAME, id: ID, e: "👍", n: 0 }, { t: REACTION_FRAME, id: ID, e: "👍", n: -1 },
      { t: REACTION_FRAME, id: ID, e: "👍", n: 1.5 }, { t: REACTION_FRAME, id: ID, e: "👍", n: "1" }, { t: REACTION_FRAME, id: ID, e: "👍", n: 2 ** 60 },
      { t: REACTION_FRAME, id: "bad id!", e: "👍", n: 1 }, { t: REACTION_FRAME, id: "x".repeat(129), e: "👍", n: 1 }, { t: REACTION_FRAME, e: "👍", n: 1 },
      { t: REACTION_FRAME, id: ID, e: null, n: 1 }, { t: "paired-message", id: ID, e: "👍", n: 1 },
    ]) expect(parseReactionFrame(bad as Record<string, unknown>), JSON.stringify(bad)).toBeNull();
    for (const bad of [{ t: REACTED_FRAME }, { t: REACTED_FRAME, n: 0 }, { t: REACTED_FRAME, n: "3" }, { t: REACTION_FRAME, n: 3 }])
      expect(parseReactedFrame(bad as Record<string, unknown>)).toBeNull();
    expect(readReaction([ID, "👍", 1])).toBeNull();
  });

  it("names group messages and payments too", () => {
    const member = "y".repeat(52);
    expect(readReaction({ id: `${member}:0:3`, e: "🙏", n: 1 })).toEqual({ id: `${member}:0:3`, e: "🙏", n: 1 });
    expect(readReaction({ id: "pay_1234567890", e: "🙏", n: 1 })?.id).toBe("pay_1234567890");
  });

  it("reads a DHT envelope's list, skipping what does not hold", () => {
    expect(readDhtReactions([[ID, "👍", 1], [ID, "no", 2], "x", [ID, "", 3], [ID, "😂"]])).toEqual([{ id: ID, e: "👍", n: 1 }, { id: ID, e: "", n: 3 }]);
    expect(readDhtReactions(null)).toEqual([]);
    expect(readDhtReactions(Array.from({ length: 20 }, (_, i) => [ID, "👍", i + 1]))).toHaveLength(REACTION_LIMITS.dht);
  });
});

describe("ordering", () => {
  it("the highest number wins, whatever order frames arrive in", () => {
    expect(reactionIsNewer(undefined, 1)).toBe(true);
    expect(reactionIsNewer({ n: 5 }, 6)).toBe(true);
    expect(reactionIsNewer({ n: 5 }, 5)).toBe(false);
    expect(reactionIsNewer({ n: 5 }, 4)).toBe(false);
  });

  it("numbers only grow, even when the clock goes back", () => {
    expect(nextReactionNumber(0, 1_000)).toBe(1_000);
    expect(nextReactionNumber(1_000, 1_000)).toBe(1_001);
    expect(nextReactionNumber(5_000, 1_000)).toBe(5_001);
    expect(nextReactionNumber(undefined, 2_000.7)).toBe(2_000);
  });

  it("a pending reaction is replaced by a newer one for the same message, and the queue is capped", () => {
    let queue = queueReaction([], { id: ID, e: "👍", n: 1 });
    queue = queueReaction(queue, { id: "BBBBBBBBBBBBBBBBBBBBBB", e: "😂", n: 2 });
    queue = queueReaction(queue, { id: ID, e: "", n: 3 });
    expect(queue).toEqual([{ id: "BBBBBBBBBBBBBBBBBBBBBB", e: "😂", n: 2 }, { id: ID, e: "", n: 3 }]);
    for (let i = 0; i < 40; i++) queue = queueReaction(queue, { id: `m${String(i).padStart(21, "0")}`, e: "👍", n: 10 + i });
    expect(queue).toHaveLength(REACTION_LIMITS.pending);
    expect(queue[0].n).toBe(10 + 40 - REACTION_LIMITS.pending);
  });

  it("the rate window takes a limit per window", () => {
    let now = 0;
    const window = new ReactionWindow(3, 1_000, () => now);
    expect([window.take(), window.take(), window.take(), window.take()]).toEqual([true, true, true, false]);
    expect(window.wait()).toBe(1_000);
    now = 999; expect(window.take()).toBe(false);
    now = 1_000; expect(window.wait()).toBe(0); expect(window.take()).toBe(true);
    window.reset(); expect([window.take(), window.take()]).toEqual([true, true]);
  });

  it("is a session capability both sides must list", () => {
    const caps = new SessionCapabilities(() => [REACTIONS_CAPABILITY]);
    expect(caps.agreed(REACTIONS_CAPABILITY)).toBe(false);
    expect(caps.receive({ c: ["react/1"] })).toEqual([REACTIONS_CAPABILITY]);
    expect(caps.agreed(REACTIONS_CAPABILITY)).toBe(true);
  });
});

// Two GhostLinks over an in-memory stand-in for Iroh, each with a real PairedSession handshake
// (the harness of pairedCallsServices.test.ts).

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

interface Side { link: GhostLink; endpoint: NativeEndpoint; reactions: WireReaction[]; receipts: number[]; support: boolean[]; sent: string[] }

const links: GhostLink[] = [];
afterEach(async () => { await Promise.all(links.splice(0).map(link => link.stop(false))); });

function pair(options: { a?: Partial<GhostLinkOptions>; b?: Partial<GhostLinkOptions>; drop?: { a?: (data: string) => boolean; b?: (data: string) => boolean } } = {}) {
  const invitation = createLink();
  const [ia, ib] = [createIdentity(), createIdentity()];
  const binding: NativeBinding = { transport: "iroh/1", context: hex("c"), identities: [hex("a"), hex("b")] };
  const endpoints: Record<"a" | "b", NativeEndpoint> = {} as never;
  const make = (name: "a" | "b", params: typeof invitation.mine, me: typeof ia, peer: typeof ia, extra: Partial<GhostLinkOptions> = {}): Side => {
    const reactions: WireReaction[] = [], receipts: number[] = [], support: boolean[] = [], sent: string[] = [];
    const endpoint: NativeEndpoint = {
      transport: "iroh/1", descriptor: { name }, onConnection: null, onDescriptor: null,
      close: async () => {},
      connect: async (): Promise<BoundChannel> => {
        // Only "a" dials: what each side sends is logged on its own end.
        const [mine, theirs] = channelPair(options.drop, sent);
        const other = endpoints[name === "a" ? "b" : "a"];
        const theirsLogged = new Proxy(theirs, { get: (target, key) => key === "send"
          ? (data: string) => { sides[name === "a" ? "b" : "a"]?.sent.push(data); target.send(data); } : Reflect.get(target, key),
          set: (target, key, value) => Reflect.set(target, key, value) });
        queueMicrotask(() => other.onConnection?.({ channel: theirsLogged, binding }));
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
      reactionsSupport: true,
      ...extra,
      events: {
        onReaction: reaction => { reactions.push(reaction); return true; },
        onReactionReceipt: n => { receipts.push(n); },
        onReactionsSupport: on => { support.push(on); },
        ...extra.events,
      },
    });
    links.push(link);
    link.registerEndpoint(endpoint);
    return { link, endpoint, reactions, receipts, support, sent };
  };
  const sides: Partial<Record<"a" | "b", Side>> = {};
  sides.a = make("a", invitation.mine, ia, ib, options.a);
  sides.b = make("b", invitation.invite, ib, ia, options.b);
  return { a: sides.a, b: sides.b };
}

async function live(a: Side, b: Side): Promise<void> {
  await a.link.connect(10_000);
  await vi.waitFor(() => expect(a.link.isDataLinkOpen && b.link.isDataLinkOpen).toBe(true));
}

const reactionsSent = (side: Side) => side.sent.filter(data => data.includes(`"t":"${REACTION_FRAME}"`));

describe("reactions on a paired session (react/1)", () => {
  it("A reacts, B takes it and confirms; nothing goes before both say react/1", async () => {
    const published = vi.fn(async () => {});
    const { a, b } = pair({ a: { transport: { publish: published, resolve: async () => null, describe: () => ({ protocol: "memory", relays: [] }) } } });
    expect(a.link.sendReaction({ id: ID, e: "👍", n: 1 })).toMatch(/live/);
    await live(a, b);
    await vi.waitFor(() => expect(a.link.supportsReactions && b.link.supportsReactions).toBe(true));
    expect(a.support).toContain(true);
    expect(a.link.sendReaction({ id: ID, e: "❤️", n: 2 })).toBeNull();
    expect(a.link.sendReaction({ id: ID, e: "", n: 3 })).toBeNull();
    await vi.waitFor(() => expect(a.receipts).toEqual([2, 3]));
    expect(b.reactions).toEqual([{ id: ID, e: "❤️", n: 2 }, { id: ID, e: "", n: 3 }]);
    expect(JSON.stringify(published.mock.calls)).not.toContain("paired-reaction");
  });

  it("a reaction the receiver does not take now is not confirmed", async () => {
    const { a, b } = pair({ b: { events: { onReaction: () => false } } });
    await live(a, b);
    await vi.waitFor(() => expect(a.link.supportsReactions).toBe(true));
    expect(a.link.sendReaction({ id: ID, e: "👍", n: 1 })).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(a.receipts).toEqual([]);
  });

  it("caps what a contact may send per window: the rest go unconfirmed", async () => {
    const { a, b } = pair();
    await live(a, b);
    await vi.waitFor(() => expect(a.link.supportsReactions && b.link.supportsReactions).toBe(true));
    for (let n = 1; n <= REACTION_LIMITS.receive + 5; n++) expect(a.link.sendReaction({ id: ID, e: "👍", n })).toBeNull();
    await vi.waitFor(() => expect(a.receipts).toHaveLength(REACTION_LIMITS.receive));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(b.reactions).toHaveLength(REACTION_LIMITS.receive);
    expect(a.receipts.at(-1)).toBe(REACTION_LIMITS.receive);
  });

  it("an app that does not offer react/1 gets nothing, and what it sends is not taken", async () => {
    const { a, b } = pair({ b: { reactionsSupport: false } });
    await live(a, b);
    await vi.waitFor(() => expect(a.link.sessionOffers.peer).not.toBeNull());
    expect(a.link.supportsReactions).toBe(false);
    expect(a.link.sendReaction({ id: ID, e: "👍", n: 1 })).toMatch(/does not show reactions/);
    expect(reactionsSent(a)).toEqual([]);
  });

  it("an older app that never says its capabilities gets nothing", async () => {
    const { a, b } = pair({ drop: { b: data => data.includes('"t":"paired-capabilities"') } });
    await live(a, b);
    await vi.waitFor(() => expect(b.link.supportsReactions).toBe(true));
    expect(a.link.supportsReactions).toBe(false);
    expect(a.link.sendReaction({ id: ID, e: "👍", n: 1 })).not.toBeNull();
  });

  it("ignores a reaction from a connection that never authenticated as the pinned contact", async () => {
    const { a } = pair();
    const [mine, theirs] = channelPair();
    a.endpoint.onConnection?.({ channel: theirs, binding: { transport: "iroh/1", context: hex("d"), identities: [hex("a"), hex("d")] } });
    for (let n = 1; n <= 3; n++) mine.send(reactionFrame({ id: ID, e: "👍", n }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(a.reactions).toEqual([]);
  });
});
