import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostLink, type GhostLinkOptions } from "../src/ghostlink";
import { createLink } from "../src/invite";
import { createIdentity } from "../src/identity";
import { parseLocalTarget, utf8Decode, type LocalFetch } from "../src";
import type { BoundChannel, NativeBinding, NativeEndpoint } from "../src/pairedTransports";
import type { FrameChannel } from "../src/frames";
// covers: calls.paired.negotiate, calls.signal, services.paired.negotiate, services.http

/**
 * Calls and shared apps on a paired session, end to end in one process: two GhostLinks connected over an
 * in-memory stand-in for Iroh (a native transport, so no WebRTC carries the chat at all), each with a real
 * PairedSession handshake. Call media is not here: it is a WebRTC connection of its own, and what the chat
 * carries is only its signaling.
 */

const hex = (c: string) => c.repeat(64);

/** Text channels back to back. `drop` loses frames a side sends, as an older app would never send them. */
function channelPair(drop: { a?: (data: string) => boolean; b?: (data: string) => boolean } = {}): [FrameChannel, FrameChannel] {
  type End = FrameChannel & { peer?: End; closed: boolean; receive(data: string): void };
  const make = (filter?: (data: string) => boolean): End => {
    // What arrives before the side reads is kept for it, as a real channel keeps it.
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
        if (filter?.(data)) return;
        queueMicrotask(() => this.peer?.receive(data));
      },
      close() { if (this.closed) return; this.closed = true; this.onClose?.(); this.peer?.close(); },
    };
  };
  const a = make(drop.a), b = make(drop.b);
  a.peer = b; b.peer = a;
  return [a, b];
}

interface Side {
  link: GhostLink;
  endpoint: NativeEndpoint;
  calls: string[];
  presenceServices: () => string[];
}

const links: GhostLink[] = [];
afterEach(async () => { await Promise.all(links.splice(0).map(link => link.stop(false))); });

function pair(options: {
  a?: Partial<GhostLinkOptions>; b?: Partial<GhostLinkOptions>;
  drop?: { a?: (data: string) => boolean; b?: (data: string) => boolean };
} = {}) {
  const invitation = createLink();
  const [ia, ib] = [createIdentity(), createIdentity()];
  const binding: NativeBinding = { transport: "iroh/1", context: hex("c"), identities: [hex("a"), hex("b")] };
  const endpoints: Record<"a" | "b", NativeEndpoint> = {} as never;

  const make = (name: "a" | "b", params: typeof invitation.mine, me: typeof ia, peer: typeof ia, extra: Partial<GhostLinkOptions> = {}): Side => {
    const calls: string[] = [];
    let lastServices: string[] = [];
    const endpoint: NativeEndpoint = {
      transport: "iroh/1", descriptor: { name }, onConnection: null, onDescriptor: null,
      close: async () => {},
      // Dialling the other side: it is told of its end, this side gets its own.
      connect: async (): Promise<BoundChannel> => {
        const [mine, theirs] = channelPair(name === "a" ? options.drop : { a: options.drop?.b, b: options.drop?.a });
        const other = endpoints[name === "a" ? "b" : "a"];
        queueMicrotask(() => other.onConnection?.({ channel: theirs, binding }));
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
      callsSupport: true, servicesSupport: true,
      ...extra,
      events: {
        onCallSignal: signal => calls.push(signal),
        onPresence: presence => { lastServices = (presence.services ?? []).map(s => s.id); },
        ...extra.events,
      },
    });
    links.push(link);
    link.registerEndpoint(endpoint);
    return { link, endpoint, calls, presenceServices: () => lastServices };
  };
  const a = make("a", invitation.mine, ia, ib, options.a);
  const b = make("b", invitation.invite, ib, ia, options.b);
  return { a, b };
}

async function live(a: Side, b: Side): Promise<void> {
  await a.link.connect(10_000);
  await vi.waitFor(() => expect(a.link.isDataLinkOpen && b.link.isDataLinkOpen).toBe(true));
}

const offer = () => JSON.stringify({ t: "o", ts: Date.now(), u: "abcd", p: "p".repeat(22), f: "a".repeat(64), s: "actpass", m: ["a", "v"], c: ["1 1 udp 2122260223 192.168.1.2 50000 typ host"], v: 1, k: "c" });
const answer = () => JSON.stringify({ t: "a", ts: Date.now(), u: "efgh", p: "q".repeat(22), f: "b".repeat(64), s: "active", m: ["a", "v"], c: [], v: 0 });
const hangUp = () => JSON.stringify({ t: "h", ts: Date.now() });

describe("calls on a paired session (calls/1)", () => {
  it("carries offer, answer and hang-up both ways over the live session, and publishes nothing", async () => {
    const published = vi.fn(async () => {});
    const { a, b } = pair({ a: { transport: { publish: published, resolve: async () => null, describe: () => ({ protocol: "memory", relays: [] }) } } });
    expect(a.link.callsUnavailable).toBe("Calls need a live connection");
    await live(a, b);
    await vi.waitFor(() => expect(a.link.supportsCalls && b.link.supportsCalls).toBe(true));
    expect(a.link.callsUnavailable).toBeNull();
    expect(a.link.sessionOffers).toEqual({ mine: ["calls/1", "services/1"], peer: ["calls/1", "services/1"] });

    const o = offer();
    await a.link.setCallSignal(o);
    await vi.waitFor(() => expect(b.calls).toEqual([o]));
    const r = answer();
    await b.link.setCallSignal(r);
    await vi.waitFor(() => expect(a.calls).toEqual([r]));
    const h = hangUp();
    await a.link.setCallSignal(h);
    await a.link.setCallSignal(null);
    await vi.waitFor(() => expect(b.calls).toEqual([o, h]));
    // Signaling is the session's: nothing about the call reached the DHT.
    expect(JSON.stringify(published.mock.calls)).not.toContain("actpass");
  });

  it("drops a malformed or stale signal before it reaches the call", async () => {
    let side!: FrameChannel;
    const { a, b } = pair();
    const connect = a.endpoint.connect;
    a.endpoint.connect = async descriptor => { const bound = await connect(descriptor); side = bound.channel; return bound; };
    await live(a, b);
    await vi.waitFor(() => expect(b.link.supportsCalls).toBe(true));
    side.send(JSON.stringify({ t: "paired-call", s: JSON.stringify({ t: "o", ts: Date.now(), u: "x\r\na=evil", p: "p".repeat(22), f: "a".repeat(64), s: "actpass" }) }));
    side.send(JSON.stringify({ t: "paired-call", s: JSON.stringify({ t: "h", ts: Date.now() - 10 * 60_000 }) }));
    const good = hangUp();
    side.send(JSON.stringify({ t: "paired-call", s: good }));
    await vi.waitFor(() => expect(b.calls).toEqual([good]));
  });

  it("is off when either side does not offer it, and says why", async () => {
    const { a, b } = pair({ b: { callsSupport: false } });
    await live(a, b);
    await vi.waitFor(() => expect(a.link.sessionOffers.peer).toEqual(["services/1"]));
    expect(a.link.supportsCalls).toBe(false);
    expect(a.link.callsUnavailable).toBe("Your contact's app cannot take calls");
    expect(b.link.callsUnavailable).toBe("Calls are not available in this app");
    await expect(a.link.setCallSignal(offer())).rejects.toThrow("Your contact's app cannot take calls");
    expect(b.calls).toEqual([]);
  });

  it("an older contact that never says what it offers has no calls and no shared apps", async () => {
    const older = (data: string) => data.includes('"t":"paired-capabilities"');
    const { a, b } = pair({ drop: { b: older } });
    await live(a, b);
    // Something else from the contact arrives, so its announcement would have too.
    await a.link.setCallSignal(null);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(a.link.supportsCalls).toBe(false);
    expect(a.link.supportsServices).toBe(false);
    expect(a.link.callsUnavailable).toBe("Your contact needs an updated Ghostly for calls");
  });

  it("sends what the session could not carry on the next one, while it is fresh", async () => {
    const { a, b } = pair();
    const o = offer();
    // The session is not up yet: the signal waits.
    await expect(a.link.setCallSignal(o)).rejects.toThrow("Calls need a live connection");
    await live(a, b);
    await vi.waitFor(() => expect(b.calls).toEqual([o]));
  });

  it("goes when the session goes: calls need live", async () => {
    const { a, b } = pair();
    await live(a, b);
    await vi.waitFor(() => expect(a.link.supportsCalls).toBe(true));
    a.link.disconnect();
    await vi.waitFor(() => expect(b.link.isDataLinkOpen).toBe(false));
    expect(a.link.supportsCalls).toBe(false);
    expect(a.link.callsUnavailable).toBe("Calls need a live connection");
    expect(a.link.sessionOffers.peer).toBeNull();
    await expect(a.link.setCallSignal(hangUp())).rejects.toThrow("Calls need a live connection");
  });
});

describe("shared apps on a paired session (services/1)", () => {
  const atlas = { id: "atlas", type: "http" as const, name: "Atlas" };
  const hosting = (localFetch: LocalFetch): Partial<GhostLinkOptions> => ({
    localFetch,
    getPairedServices: () => [atlas],
    getHostedHttpService: id => id === "atlas" ? { id, target: parseLocalTarget("localhost:3400") } : undefined,
  });

  it("lists a granted app once both offer services/1, and serves it over the session", async () => {
    const seen: string[] = [];
    const { a, b } = pair({ b: hosting(async request => {
      seen.push(`${request.method} ${request.url}`);
      return { status: 200, headers: [["content-type", "text/plain"]], body: [new TextEncoder().encode("served by B")] };
    }) });
    await live(a, b);
    await vi.waitFor(() => expect(a.presenceServices()).toEqual(["atlas"]));
    expect(a.link.supportsServices).toBe(true);
    const response = await a.link.request("atlas", { method: "GET", path: "/hello?x=1" });
    expect(response.status).toBe(200);
    expect(utf8Decode(await response.bytes())).toBe("served by B");
    expect(seen).toEqual(["GET http://localhost:3400/hello?x=1"]);
    // Not granted, not served: the host decides, not the list.
    expect((await a.link.request("private", { method: "GET", path: "/" })).status).toBe(404);
  });

  it("travels over none of it when the contact does not offer services/1 (the web app)", async () => {
    const localFetch = vi.fn<LocalFetch>(async () => ({ status: 200, headers: [], body: [] }));
    const { a, b } = pair({ a: { servicesSupport: false }, b: hosting(localFetch) });
    await live(a, b);
    await vi.waitFor(() => expect(b.link.sessionOffers.peer).toEqual(["calls/1"]));
    expect(a.presenceServices()).toEqual([]);
    expect(b.link.supportsServices).toBe(false);
    await expect(a.link.request("atlas", { method: "GET", path: "/" })).rejects.toThrow(/cannot share web apps/);
    expect(localFetch).not.toHaveBeenCalled();
  });

  it("needs live: a request with no session fails without reaching the host", async () => {
    const localFetch = vi.fn<LocalFetch>(async () => ({ status: 200, headers: [], body: [] }));
    const { a, b } = pair({ b: hosting(localFetch) });
    await live(a, b);
    await vi.waitFor(() => expect(a.presenceServices()).toEqual(["atlas"]));
    b.link.disconnect();
    await vi.waitFor(() => expect(a.link.isDataLinkOpen).toBe(false));
    expect(a.presenceServices()).toEqual([]);
    expect(a.link.supportsServices).toBe(false);
    expect(localFetch).not.toHaveBeenCalled();
  });
});
