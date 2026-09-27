import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostLink, type GhostLinkOptions } from "../src/ghostlink";
import { createLink } from "../src/invite";
import { createIdentity } from "../src/identity";
import { SessionCapabilities, TYPING_CAPABILITY } from "../src/pairedCapabilities";
import {
  TYPING_FRAME, TYPING_RATE_LIMIT, TYPING_RATE_WINDOW_MS, TYPING_REFRESH_MS, TYPING_TIMEOUT_MS,
  TypingReceiver, TypingSender, parseTypingFrame, typingFrame,
} from "../src/pairedTyping";
import type { BoundChannel, NativeBinding, NativeEndpoint } from "../src/pairedTransports";
import type { FrameChannel } from "../src/frames";
// covers: chat.typing

afterEach(() => { vi.useRealTimers(); });

describe("paired-typing frames", () => {
  it("encodes and decodes start and stop, and refuses anything else", () => {
    expect(JSON.stringify(typingFrame("start"))).toBe('{"t":"paired-typing","s":"start"}');
    expect(parseTypingFrame(JSON.parse(JSON.stringify(typingFrame("stop"))))).toBe("stop");
    expect(parseTypingFrame({ t: TYPING_FRAME, s: "start" })).toBe("start");
    for (const bad of [{ t: TYPING_FRAME }, { t: TYPING_FRAME, s: true }, { t: TYPING_FRAME, s: "START" }, { t: "paired-nick", s: "start" }])
      expect(parseTypingFrame(bad as Record<string, unknown>)).toBeNull();
  });

  it("is a session capability both sides must list", () => {
    let offered = [TYPING_CAPABILITY] as const;
    const caps = new SessionCapabilities(() => offered);
    expect(caps.agreed(TYPING_CAPABILITY)).toBe(false);
    expect(caps.receive({ c: ["calls/1"] })).toEqual([]);
    expect(caps.agreed(TYPING_CAPABILITY)).toBe(false);
    expect(caps.receive({ c: ["typing/1"] })).toEqual([TYPING_CAPABILITY]);
    expect(caps.agreed(TYPING_CAPABILITY)).toBe(true);
    offered = [] as never;
    expect(caps.agreed(TYPING_CAPABILITY)).toBe(false);
  });
});

describe("TypingSender", () => {
  it("says start at most once per refresh while typing goes on", () => {
    let now = 1_000;
    const sender = new TypingSender(() => now);
    expect(sender.typing()).toEqual(typingFrame("start"));
    now += 500; expect(sender.typing()).toBeNull();
    now += TYPING_REFRESH_MS - 501; expect(sender.typing()).toBeNull();
    now += 1; expect(sender.typing()).toEqual(typingFrame("start"));
  });

  it("owes a stop only after a start, and once", () => {
    const sender = new TypingSender(() => 5_000);
    expect(sender.stopped()).toBeNull();
    sender.typing();
    expect(sender.active).toBe(true);
    expect(sender.stopped()).toEqual(typingFrame("stop"));
    expect(sender.stopped()).toBeNull();
    // After a stop, the next keystroke says start again at once.
    expect(sender.typing()).toEqual(typingFrame("start"));
    sender.reset();
    expect(sender.stopped()).toBeNull();
  });
});

describe("TypingReceiver", () => {
  it("shows typing until stop, and says only changes", () => {
    const changes: boolean[] = [];
    const receiver = new TypingReceiver(typing => changes.push(typing));
    receiver.receive(typingFrame("start"));
    receiver.receive(typingFrame("start"));
    expect(receiver.peerTyping).toBe(true);
    receiver.receive(typingFrame("stop"));
    receiver.receive(typingFrame("stop"));
    expect(changes).toEqual([true, false]);
  });

  it("times out when no start refreshes it, so a dropped link never leaves it on", () => {
    vi.useFakeTimers();
    const changes: boolean[] = [];
    const receiver = new TypingReceiver(typing => changes.push(typing));
    receiver.receive(typingFrame("start"));
    vi.advanceTimersByTime(TYPING_TIMEOUT_MS - 1_000);
    receiver.receive(typingFrame("start"));
    vi.advanceTimersByTime(TYPING_TIMEOUT_MS - 1);
    expect(receiver.peerTyping).toBe(true);
    vi.advanceTimersByTime(1);
    expect(receiver.peerTyping).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it("clears on a message from the contact, and the timer does not fire after", () => {
    vi.useFakeTimers();
    const changes: boolean[] = [];
    const receiver = new TypingReceiver(typing => changes.push(typing));
    receiver.receive(typingFrame("start"));
    receiver.clear();
    vi.advanceTimersByTime(TYPING_TIMEOUT_MS * 2);
    expect(changes).toEqual([true, false]);
  });

  it("drops frames past the rate limit until the window moves on", () => {
    let now = 0;
    const changes: boolean[] = [];
    const receiver = new TypingReceiver(typing => changes.push(typing), () => now);
    for (let i = 0; i < TYPING_RATE_LIMIT; i++) expect(receiver.receive(typingFrame(i % 2 ? "stop" : "start"))).toBe(true);
    const flips = changes.length;
    expect(receiver.receive(typingFrame("start"))).toBe(false);
    expect(receiver.receive(typingFrame("stop"))).toBe(false);
    expect(changes.length).toBe(flips);
    now += TYPING_RATE_WINDOW_MS;
    expect(receiver.receive(typingFrame("start"))).toBe(true);
    receiver.clear();
  });

  it("ignores a malformed frame", () => {
    const changes: boolean[] = [];
    const receiver = new TypingReceiver(typing => changes.push(typing));
    expect(receiver.receive({ t: TYPING_FRAME, s: "yes" })).toBe(false);
    expect(changes).toEqual([]);
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

interface Side { link: GhostLink; endpoint: NativeEndpoint; typing: boolean[]; messages: string[]; sent: string[] }

const links: GhostLink[] = [];
afterEach(async () => { await Promise.all(links.splice(0).map(link => link.stop(false))); });

function pair(options: { a?: Partial<GhostLinkOptions>; b?: Partial<GhostLinkOptions>; drop?: { a?: (data: string) => boolean; b?: (data: string) => boolean } } = {}) {
  const invitation = createLink();
  const [ia, ib] = [createIdentity(), createIdentity()];
  const binding: NativeBinding = { transport: "iroh/1", context: hex("c"), identities: [hex("a"), hex("b")] };
  const endpoints: Record<"a" | "b", NativeEndpoint> = {} as never;
  const make = (name: "a" | "b", params: typeof invitation.mine, me: typeof ia, peer: typeof ia, extra: Partial<GhostLinkOptions> = {}): Side => {
    const typing: boolean[] = [], messages: string[] = [], sent: string[] = [];
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
      typingSupport: true,
      ...extra,
      events: {
        onPeerTyping: on => typing.push(on),
        onMessage: message => { messages.push(message.text); },
        ...extra.events,
      },
    });
    links.push(link);
    link.registerEndpoint(endpoint);
    return { link, endpoint, typing, messages, sent };
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

const typingSent = (side: Side) => side.sent.filter(data => data.includes(`"t":"${TYPING_FRAME}"`));

describe("typing on a paired session (typing/1)", () => {
  it("A types, B sees it; A sends, it ends; the contact's message clears it too", async () => {
    const published = vi.fn(async () => {});
    const { a, b } = pair({ a: { transport: { publish: published, resolve: async () => null, describe: () => ({ protocol: "memory", relays: [] }) } } });
    // Not live: nothing is said, not even on the DHT.
    a.link.setTyping(true);
    await live(a, b);
    await vi.waitFor(() => expect(a.link.supportsTyping && b.link.supportsTyping).toBe(true));
    expect(a.link.sessionOffers.peer).toContain("typing/1");

    a.link.setTyping(true);
    await vi.waitFor(() => expect(b.link.peerTyping).toBe(true));
    // Throttled: the next keystrokes say nothing new.
    a.link.setTyping(true); a.link.setTyping(true);
    a.link.setTyping(false);
    await vi.waitFor(() => expect(b.link.peerTyping).toBe(false));
    expect(b.typing).toEqual([true, false]);
    expect(typingSent(a)).toEqual(['{"t":"paired-typing","s":"start"}', '{"t":"paired-typing","s":"stop"}']);

    // B sees typing; A's message arrives and ends it (no stop needed).
    a.link.setTyping(true);
    await vi.waitFor(() => expect(b.link.peerTyping).toBe(true));
    expect(await a.link.sendMessage("hello", Date.now())).toBeNull();
    await vi.waitFor(() => expect(b.messages).toEqual(["hello"]));
    expect(b.link.peerTyping).toBe(false);
    expect(JSON.stringify(published.mock.calls)).not.toContain("paired-typing");
  });

  it("ends when the session does", async () => {
    const { a, b } = pair();
    await live(a, b);
    await vi.waitFor(() => expect(b.link.supportsTyping).toBe(true));
    a.link.setTyping(true);
    await vi.waitFor(() => expect(b.link.peerTyping).toBe(true));
    await a.link.stop(false);
    await vi.waitFor(() => expect(b.link.peerTyping).toBe(false));
  });

  it("an app that does not offer typing/1 gets nothing, and what it sends is not shown", async () => {
    const { a, b } = pair({ b: { typingSupport: false } });
    await live(a, b);
    await vi.waitFor(() => expect(a.link.sessionOffers.peer).not.toBeNull());
    expect(a.link.supportsTyping).toBe(false);
    a.link.setTyping(true);
    b.link.setTyping(true);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(typingSent(a)).toEqual([]);
    expect(typingSent(b)).toEqual([]);
    expect(b.link.peerTyping).toBe(false);
    expect(a.link.peerTyping).toBe(false);
  });

  it("an older app that never says its capabilities gets nothing", async () => {
    const { a, b } = pair({ drop: { b: data => data.includes('"t":"paired-capabilities"') } });
    await live(a, b);
    await vi.waitFor(() => expect(b.link.supportsTyping).toBe(true));
    expect(a.link.supportsTyping).toBe(false);
    a.link.setTyping(true);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(typingSent(a)).toEqual([]);
  });

  it("ignores typing from a connection that never authenticated as the pinned contact", async () => {
    const { a } = pair();
    const [mine, theirs] = channelPair();
    a.endpoint.onConnection?.({ channel: theirs, binding: { transport: "iroh/1", context: hex("d"), identities: [hex("a"), hex("d")] } });
    for (let i = 0; i < 3; i++) mine.send(JSON.stringify(typingFrame("start")));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(a.typing).toEqual([]);
    expect(a.link.peerTyping).toBe(false);
  });

  it("is not offered on a legacy (unpaired) link", () => {
    const invitation = createLink();
    const link = new GhostLink({
      params: invitation.mine, rtcAvailable: false, typingSupport: true,
      transport: { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "memory", relays: [] }) },
      localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    } as GhostLinkOptions);
    link.setTyping(true);
    expect(link.supportsTyping).toBe(false);
  });
});
