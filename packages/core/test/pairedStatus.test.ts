import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostLink, type GhostLinkOptions } from "../src/ghostlink";
import { createLink } from "../src/invite";
import { createIdentity } from "../src/identity";
import { KNOWN_SESSION_CAPABILITIES, STATUS_CAPABILITY } from "../src/pairedCapabilities";
import {
  STATUS_FRAME, STATUS_RATE_LIMIT, STATUS_RATE_WINDOW_MS, STATUS_SEND_INTERVAL_MS, STATUS_TEXT_MAX,
  StatusReceiver, StatusSender, liveStatus, parseStatusFrame, personStatus, statusFrame, type StatusState,
} from "../src/pairedStatus";
import type { BoundChannel, NativeBinding, NativeEndpoint } from "../src/pairedTransports";
import type { FrameChannel } from "../src/frames";
// covers: chat.status.wire

afterEach(() => { vi.useRealTimers(); });

describe("paired-status frames", () => {
  it("writes the whole state with short keys, and reads it back", () => {
    expect(JSON.stringify(statusFrame({}))).toBe('{"t":"paired-status"}');
    expect(JSON.stringify(statusFrame({ presence: "active" }))).toBe('{"t":"paired-status","p":"active"}');
    const state: StatusState = { presence: "idle", status: { availability: "busy", emoji: "🍕", text: "At lunch", until: 1762603600000 } };
    const wire = JSON.stringify(statusFrame(state));
    expect(wire).toBe('{"t":"paired-status","p":"idle","s":{"a":"busy","e":"🍕","m":"At lunch","u":1762603600000}}');
    expect(parseStatusFrame(JSON.parse(wire))).toEqual(state);
  });

  it("is a session capability this app knows", () => {
    expect(STATUS_CAPABILITY).toBe("status/1");
    expect(KNOWN_SESSION_CAPABILITIES).toContain(STATUS_CAPABILITY);
  });

  it("refuses a malformed frame, so the reader keeps what it had", () => {
    for (const bad of [{ t: STATUS_FRAME, p: 1 }, { t: STATUS_FRAME, s: "busy" }, { t: STATUS_FRAME, s: [] }, { t: STATUS_FRAME, s: { a: true } }, { t: "paired-typing", p: "active" }])
      expect(parseStatusFrame(bad as Record<string, unknown>)).toBeNull();
  });

  it("reads an availability or presence it does not know as available and active", () => {
    expect(parseStatusFrame({ t: STATUS_FRAME, p: "lurking", s: { a: "focus", e: "🎧" } })).toEqual({ presence: "active", status: { availability: "available", emoji: "🎧" } });
  });

  it("leaves out a field that does not hold, not the frame", () => {
    expect(parseStatusFrame({ t: STATUS_FRAME, p: "active", s: { a: "dnd", e: "not an emoji", m: "see https://example.com", u: -5 } }))
      .toEqual({ presence: "active", status: { availability: "dnd" } });
    expect(parseStatusFrame({ t: STATUS_FRAME, s: { e: "🙂🙂", u: 1.5 } })).toEqual({});
  });

  it("keeps a text to one line of 60 characters, without invisible characters", () => {
    expect(personStatus({ text: "a\n\n  b" })).toEqual({ text: "a b" });
    expect(personStatus({ text: "x".repeat(200) })?.text).toHaveLength(STATUS_TEXT_MAX);
    expect(personStatus({ text: "Out‮ today" })).toEqual({ text: "Out today" });
    expect(personStatus({ text: "<b>hi</b>" })).toBeUndefined();
  });

  it("a status past its end is no status", () => {
    expect(liveStatus({ text: "Lunch", until: 1_000 }, 999)).toEqual({ text: "Lunch", until: 1_000 });
    expect(liveStatus({ text: "Lunch", until: 1_000 }, 1_000)).toBeUndefined();
    expect(liveStatus({ text: "Forever" }, 9e15)).toEqual({ text: "Forever" });
  });
});

describe("StatusSender", () => {
  it("owes the whole state on each session, and again only when it changes", () => {
    let now = 100_000;
    const sender = new StatusSender(() => now);
    expect(sender.take()).toEqual({ frame: { t: STATUS_FRAME } });
    expect(sender.take()).toBeNull();
    now += STATUS_SEND_INTERVAL_MS;
    sender.set({});
    expect(sender.take()).toBeNull();
    sender.set({ presence: "active" });
    expect(sender.take()).toEqual({ frame: { t: STATUS_FRAME, p: "active" } });
    now += STATUS_SEND_INTERVAL_MS;
    sender.reset();
    expect(sender.take()).toEqual({ frame: { t: STATUS_FRAME, p: "active" } });
  });

  it("says at most one frame per interval, the latest state when it ends", () => {
    let now = 100_000;
    const sender = new StatusSender(() => now);
    sender.set({ presence: "active" });
    expect(sender.take()).toEqual({ frame: { t: STATUS_FRAME, p: "active" } });
    now += 1_000;
    sender.set({ presence: "idle" });
    expect(sender.take()).toEqual({ wait: STATUS_SEND_INTERVAL_MS - 1_000 });
    sender.set({ presence: "active", status: { availability: "busy" } });
    now += STATUS_SEND_INTERVAL_MS;
    expect(sender.take()).toEqual({ frame: { t: STATUS_FRAME, p: "active", s: { a: "busy" } } });
    // The interval holds across sessions too, as the reader's window does.
    sender.reset();
    expect(sender.take()).toEqual({ wait: STATUS_SEND_INTERVAL_MS });
  });

  it("is not held by a clock set back", () => {
    let now = 100_000;
    const sender = new StatusSender(() => now);
    sender.take();
    now -= 60_000;
    sender.set({ presence: "idle" });
    expect(sender.take()).toEqual({ frame: { t: STATUS_FRAME, p: "idle" } });
  });
});

describe("StatusReceiver", () => {
  it("says changes only; presence ends with the session, the status stands until its end", () => {
    let now = 1_000;
    const seen: StatusState[] = [];
    const receiver = new StatusReceiver(state => seen.push(state), () => now);
    receiver.receive({ t: STATUS_FRAME, p: "active", s: { a: "busy", m: "Call", u: 5_000 } });
    receiver.receive({ t: STATUS_FRAME, p: "active", s: { a: "busy", m: "Call", u: 5_000 } });
    expect(seen).toEqual([{ presence: "active", status: { availability: "busy", text: "Call", until: 5_000 } }]);
    receiver.endSession();
    expect(receiver.peer).toEqual({ status: { availability: "busy", text: "Call", until: 5_000 } });
    expect(seen).toHaveLength(2);
    receiver.endSession();
    expect(seen).toHaveLength(2);
    now = 5_000;
    expect(receiver.peer).toEqual({});
  });

  it("a frame with neither field clears both", () => {
    const receiver = new StatusReceiver(() => {});
    receiver.receive({ t: STATUS_FRAME, p: "idle", s: { e: "🌴" } });
    receiver.receive({ t: STATUS_FRAME });
    expect(receiver.peer).toEqual({});
  });

  it("keeps what it had on a malformed frame", () => {
    const receiver = new StatusReceiver(() => {});
    receiver.receive({ t: STATUS_FRAME, p: "active" });
    expect(receiver.receive({ t: STATUS_FRAME, s: "busy" })).toBe(false);
    expect(receiver.peer).toEqual({ presence: "active" });
  });

  it("drops frames past the rate limit until the window moves on", () => {
    let now = 1_000;
    const receiver = new StatusReceiver(() => {}, () => now);
    for (let i = 0; i < STATUS_RATE_LIMIT; i++) expect(receiver.receive({ t: STATUS_FRAME, p: i % 2 ? "idle" : "active" })).toBe(true);
    expect(receiver.receive({ t: STATUS_FRAME, s: { a: "dnd" } })).toBe(false);
    expect(receiver.peer.status).toBeUndefined();
    now += STATUS_RATE_WINDOW_MS;
    expect(receiver.receive({ t: STATUS_FRAME, s: { a: "dnd" } })).toBe(true);
    expect(receiver.peer).toEqual({ status: { availability: "dnd" } });
  });
});

// Two GhostLinks over an in-memory stand-in for Iroh, each with a real PairedSession handshake
// (the harness of pairedTyping.test.ts).

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

interface Side { link: GhostLink; endpoint: NativeEndpoint; seen: StatusState[]; sent: string[] }

const links: GhostLink[] = [];
afterEach(async () => { await Promise.all(links.splice(0).map(link => link.stop(false))); });

function pair(options: { a?: Partial<GhostLinkOptions>; b?: Partial<GhostLinkOptions>; drop?: { a?: (data: string) => boolean; b?: (data: string) => boolean } } = {}) {
  const invitation = createLink();
  const [ia, ib] = [createIdentity(), createIdentity()];
  const binding: NativeBinding = { transport: "iroh/1", context: hex("c"), identities: [hex("a"), hex("b")] };
  const endpoints: Record<"a" | "b", NativeEndpoint> = {} as never;
  const sides: Partial<Record<"a" | "b", Side>> = {};
  const make = (name: "a" | "b", params: typeof invitation.mine, me: typeof ia, peer: typeof ia, extra: Partial<GhostLinkOptions> = {}): Side => {
    const seen: StatusState[] = [], sent: string[] = [];
    const endpoint: NativeEndpoint = {
      transport: "iroh/1", descriptor: { id: name.repeat(64), relay: null, addresses: ["127.0.0.1:1"] }, onConnection: null, onDescriptor: null,
      close: async () => {},
      connect: async (): Promise<BoundChannel> => {
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
      native: { preferred: "iroh/1", fallback: false, peerDescriptors: { "iroh/1": { id: (name === "a" ? "b" : "a").repeat(64), relay: null, addresses: ["127.0.0.1:1"] } }, peerTransports: ["iroh/1"] },
      pairing: { credentials: { seedB64: me.seedB64, peerKey: peer.pubKeyZ32, requireSignedSignals: true }, pinPeer: async () => {}, trustOnFirstUse: true },
      transport: { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "memory", relays: [] }) },
      createPeerConnection: () => { throw new Error("The chat runs on Iroh here: no WebRTC"); },
      localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
      statusSupport: true,
      ...extra,
      events: { onPeerStatus: state => seen.push(state), ...extra.events },
    });
    links.push(link);
    link.registerEndpoint(endpoint);
    return { link, endpoint, seen, sent };
  };
  sides.a = make("a", invitation.mine, ia, ib, options.a);
  sides.b = make("b", invitation.invite, ib, ia, options.b);
  return { a: sides.a, b: sides.b };
}

async function live(a: Side, b: Side): Promise<void> {
  await a.link.connect(10_000);
  await vi.waitFor(() => expect(a.link.isDataLinkOpen && b.link.isDataLinkOpen).toBe(true));
}

const statusSent = (side: Side) => side.sent.filter(data => data.includes(`"t":"${STATUS_FRAME}"`));

describe("presence and status on a paired session (status/1)", () => {
  it("a state set before the session goes once both offer status/1, and B sees it; it never goes on the DHT", async () => {
    const published = vi.fn(async () => {});
    const { a, b } = pair({ a: { transport: { publish: published, resolve: async () => null, describe: () => ({ protocol: "memory", relays: [] }) } } });
    a.link.setStatus({ presence: "active", status: { availability: "busy", emoji: "🍕", text: "At lunch" } });
    await live(a, b);
    await vi.waitFor(() => expect(b.link.peerStatus).toEqual({ presence: "active", status: { availability: "busy", emoji: "🍕", text: "At lunch" } }));
    expect(a.link.sessionOffers.peer).toContain("status/1");
    expect(statusSent(a)).toEqual(['{"t":"paired-status","p":"active","s":{"a":"busy","e":"🍕","m":"At lunch"}}']);
    // B set nothing: it says so, once.
    await vi.waitFor(() => expect(statusSent(b)).toEqual(['{"t":"paired-status"}']));
    expect(a.link.peerStatus).toEqual({});
    expect(JSON.stringify(published.mock.calls)).not.toContain("paired-status");
  });

  it("a change inside the interval goes when it ends, the latest state only", async () => {
    const { a, b } = pair();
    await live(a, b);
    await vi.waitFor(() => expect(statusSent(a)).toHaveLength(1));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    a.link.setStatus({ presence: "idle" });
    a.link.setStatus({ presence: "active", status: { availability: "dnd" } });
    expect(statusSent(a)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(STATUS_SEND_INTERVAL_MS);
    vi.useRealTimers();
    await vi.waitFor(() => expect(b.link.peerStatus).toEqual({ presence: "active", status: { availability: "dnd" } }));
    expect(statusSent(a)).toEqual(['{"t":"paired-status"}', '{"t":"paired-status","p":"active","s":{"a":"dnd"}}']);
  });

  it("when the session ends, presence ends with it and the status stands", async () => {
    const { a, b } = pair();
    a.link.setStatus({ presence: "active", status: { emoji: "🌴", text: "On holiday" } });
    await live(a, b);
    await vi.waitFor(() => expect(b.link.peerStatus.presence).toBe("active"));
    await a.link.stop(false);
    await vi.waitFor(() => expect(b.link.peerStatus).toEqual({ status: { emoji: "🌴", text: "On holiday" } }));
    expect(b.seen.at(-1)).toEqual({ status: { emoji: "🌴", text: "On holiday" } });
  });

  it("an app that does not offer status/1 gets nothing, and what it sends is not shown", async () => {
    const { a, b } = pair({ b: { statusSupport: false } });
    a.link.setStatus({ presence: "active" });
    await live(a, b);
    await vi.waitFor(() => expect(a.link.sessionOffers.peer).not.toBeNull());
    expect(a.link.supportsStatus).toBe(false);
    b.link.setStatus({ presence: "active" });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(statusSent(a)).toEqual([]);
    expect(statusSent(b)).toEqual([]);
    expect(a.link.peerStatus).toEqual({});
  });

  it("an older app that never says its capabilities gets nothing", async () => {
    const { a, b } = pair({ drop: { b: data => data.includes('"t":"paired-capabilities"') } });
    a.link.setStatus({ presence: "active" });
    await live(a, b);
    await vi.waitFor(() => expect(b.link.supportsStatus).toBe(true));
    expect(a.link.supportsStatus).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(statusSent(a)).toEqual([]);
  });

  it("ignores status from a connection that never authenticated as the pinned contact", async () => {
    const { a } = pair();
    const [mine, theirs] = channelPair();
    a.endpoint.onConnection?.({ channel: theirs, binding: { transport: "iroh/1", context: hex("d"), identities: [hex("a"), hex("d")] } });
    mine.send(JSON.stringify(statusFrame({ presence: "active", status: { availability: "dnd" } })));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(a.seen).toEqual([]);
    expect(a.link.peerStatus).toEqual({});
  });

  it("is not offered on a legacy (unpaired) link", () => {
    const invitation = createLink();
    const link = new GhostLink({
      params: invitation.mine, rtcAvailable: false, statusSupport: true,
      transport: { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "memory", relays: [] }) },
      localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    } as unknown as GhostLinkOptions);
    link.setStatus({ presence: "active" });
    expect(link.supportsStatus).toBe(false);
  });
});
