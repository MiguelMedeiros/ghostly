import { afterEach, describe, expect, it, vi } from "vitest";
import { GhostLink, type GhostLinkOptions } from "../src/ghostlink";
import { createLink } from "../src/invite";
import { createIdentity } from "../src/identity";
import { parseLocalTarget, utf8Decode, type LocalFetch } from "../src";
import type { BoundChannel, NativeBinding, NativeEndpoint } from "../src/pairedTransports";
import type { FrameChannel } from "../src/frames";
import { PairedCalls } from "../src/pairedCalls";
import { CALL_SIGNAL_MAX_AGE_MS, heardCallSignal, parseCallSignal } from "../src/callSignal";
// covers: calls.paired.negotiate, calls.signal, services.paired.negotiate, services.http, transport.native-pool

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
  /** The contact's signals as they came, without when this side heard them (`heard` has that). */
  calls: string[];
  heard: number[];
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
    const calls: string[] = [], heard: number[] = [];
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
        onCallSignal: signal => { calls.push(heardCallSignal(signal)); heard.push(parseCallSignal(signal)!.at!); },
        onPresence: presence => { lastServices = (presence.services ?? []).map(s => s.id); },
        ...extra.events,
      },
    });
    links.push(link);
    link.registerEndpoint(endpoint);
    return { link, endpoint, calls, heard, presenceServices: () => lastServices };
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

  it.each([
    ["two minutes ahead", 2 * 60_000 + 500], ["an hour ahead", 60 * 60_000], ["two minutes behind", -2 * 60_000 - 500], ["an hour behind", -60 * 60_000],
  ])("a call from a contact whose clock is %s rings: a signal on a live session is heard now, whatever its own time", async (_, skew) => {
    // Reported 2026-10-01 (a contact whose clock runs two minutes fast): its signals read as "from the future" here.
    let side!: FrameChannel;
    const { a, b } = pair();
    const connect = a.endpoint.connect;
    a.endpoint.connect = async descriptor => { const bound = await connect(descriptor); side = bound.channel; return bound; };
    await live(a, b);
    await vi.waitFor(() => expect(b.link.supportsCalls).toBe(true));
    const theirs = JSON.stringify({ ...JSON.parse(offer()), ts: Date.now() + skew });
    const before = Date.now();
    side.send(JSON.stringify({ t: "paired-call", s: theirs }));
    await vi.waitFor(() => expect(b.calls).toEqual([theirs]));
    // It keeps the time its sender gave it (that orders the sender's signals), and says when it was heard here.
    expect(b.heard[0]).toBeGreaterThanOrEqual(before);
    expect(b.heard[0]).toBeLessThanOrEqual(Date.now());
    // When it was heard is this device's word: one the contact puts there is not taken.
    const forged = JSON.stringify({ ...JSON.parse(hangUp()), ts: Date.now() + skew + 1, at: 1 });
    side.send(JSON.stringify({ t: "paired-call", s: forged }));
    await vi.waitFor(() => expect(b.calls).toHaveLength(2));
    expect(b.heard[1]).toBeGreaterThanOrEqual(before);
  });

  it("drops a malformed signal before it reaches the call", async () => {
    let side!: FrameChannel;
    const { a, b } = pair();
    const connect = a.endpoint.connect;
    a.endpoint.connect = async descriptor => { const bound = await connect(descriptor); side = bound.channel; return bound; };
    await live(a, b);
    await vi.waitFor(() => expect(b.link.supportsCalls).toBe(true));
    side.send(JSON.stringify({ t: "paired-call", s: JSON.stringify({ t: "o", ts: Date.now(), u: "x\r\na=evil", p: "p".repeat(22), f: "a".repeat(64), s: "actpass" }) }));
    side.send(JSON.stringify({ t: "paired-call", s: JSON.stringify({ t: "x", ts: Date.now() }) }));
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

  it("a side that cannot call says why in its own words (the Linux Desktop without its GStreamer plugins)", async () => {
    const missing = "Calls need GStreamer plugins: install gstreamer1.0-plugins-good";
    const { a, b } = pair({ b: { callsSupport: false, callsMissing: missing } });
    expect(b.link.callsUnavailable).toBe(missing);
    await live(a, b);
    await vi.waitFor(() => expect(a.link.sessionOffers.peer).toEqual(["services/1"]));
    // Live or not, the reason is this app's; its contact is told it cannot take calls.
    expect(b.link.callsUnavailable).toBe(missing);
    expect(a.link.callsUnavailable).toBe("Your contact's app cannot take calls");
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

describe("a live session giving its native listener to a chat in use", () => {
  /** Unused this long counts as idle here: the engine asks for two minutes (`NATIVE_HOLD_MS`). */
  const IDLE = 400;
  const quiet = () => new Promise(resolve => setTimeout(resolve, IDLE + 50));

  it("an idle session gives it up with a goodbye; one just opened, used lately or with a call on keeps it", async () => {
    const sentByA: string[] = [];
    const received: string[] = [];
    const { a, b } = pair({ drop: { a: data => { sentByA.push(data); return false; } }, a: { events: { onMessage: m => { received.push(m.text); } } } });
    await live(a, b);
    await vi.waitFor(() => expect(a.link.supportsCalls && b.link.supportsCalls).toBe(true));
    // Just opened: unused for none of the hold. And never a transport the session is not on.
    expect(a.link.canYieldEndpoint("iroh/1", IDLE)).toBe(false);
    await quiet();
    expect(a.link.canYieldEndpoint("iroh/1", IDLE)).toBe(true);
    expect(a.link.canYieldEndpoint("hyperdht/1", IDLE)).toBe(false);
    // A text from the contact is use; so is the receipt that answers this side's.
    expect(await b.link.sendMessage("still here")).toBeNull();
    await vi.waitFor(() => expect(received).toEqual(["still here"]));
    expect(a.link.canYieldEndpoint("iroh/1", IDLE)).toBe(false);
    await vi.waitFor(() => expect(b.link.canYieldEndpoint("iroh/1", IDLE)).toBe(false));
    // A call on, however long, keeps the session: its media runs elsewhere, so the session itself goes quiet.
    await a.link.setCallSignal(offer());
    await vi.waitFor(() => expect(b.calls).toHaveLength(1));
    await b.link.setCallSignal(answer());
    await vi.waitFor(() => expect(a.calls).toHaveLength(1));
    await quiet();
    expect(a.link.canYieldEndpoint("iroh/1", IDLE)).toBe(false);
    expect(b.link.canYieldEndpoint("iroh/1", IDLE)).toBe(false);
    // Hung up (by either side): idle again once quiet.
    await b.link.setCallSignal(hangUp());
    await vi.waitFor(() => expect(a.calls).toHaveLength(2));
    await quiet();
    expect(a.link.canYieldEndpoint("iroh/1", IDLE)).toBe(true);
    expect(b.link.canYieldEndpoint("iroh/1", IDLE)).toBe(true);

    // Given up: the contact hears a goodbye, and this side no longer listens on Iroh.
    const close = vi.spyOn(a.endpoint, "close");
    expect(await a.link.yieldEndpoint("iroh/1", IDLE)).toBe(true);
    expect(sentByA.some(data => data.includes('"t":"paired-bye"'))).toBe(true);
    expect(close).toHaveBeenCalled();
    expect(a.link.isDataLinkOpen).toBe(false);
    expect(a.link.availableTransports).not.toContain("iroh/1");
    await vi.waitFor(() => expect(b.link.isDataLinkOpen).toBe(false));
    // Nothing left to give.
    expect(await a.link.yieldEndpoint("iroh/1", IDLE)).toBe(false);
  });

  it("a file moving keeps the session, however quiet the chat", async () => {
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const sink = { write: async () => {}, close: async () => {}, abort: () => {} };
    const { a, b } = pair({ a: { events: { onFileIncoming: () => sink } }, b: { events: { onFileIncoming: () => sink } } });
    await live(a, b);
    await vi.waitFor(() => expect(a.link.supportsFiles).toBe(true));
    async function* slow() { yield new Uint8Array(8); await held; yield new Uint8Array(8); }
    const sending = a.link.sendFile({ id: "f".repeat(22), name: "slow.bin", size: 16, mime: "application/octet-stream", timestamp: Date.now() }, slow()).catch(() => {});
    await quiet();
    expect(a.link.canYieldEndpoint("iroh/1", IDLE)).toBe(false);
    finish();
    await sending;
    await quiet();
    expect(a.link.canYieldEndpoint("iroh/1", IDLE)).toBe(true);
  });

  it("a call is on from an answer either side gave until a hang-up or a clear; an offer nobody answers rings only so long", () => {
    let now = 1_000_000;
    const calls = new PairedCalls(() => now);
    expect(calls.on).toBe(false);
    calls.set(offer());
    expect(calls.on).toBe(true);
    now += CALL_SIGNAL_MAX_AGE_MS + 1;
    expect(calls.on).toBe(false);
    calls.set(offer());
    now += 1;
    calls.heard(answer());
    now += 60 * 60_000;
    expect(calls.on).toBe(true);
    now += 1;
    calls.heard(hangUp());
    expect(calls.on).toBe(false);
    now += 1;
    calls.heard(offer());
    now += 1;
    calls.set(answer());
    expect(calls.on).toBe(true);
    now += 1;
    calls.set(null);
    expect(calls.on).toBe(false);
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
