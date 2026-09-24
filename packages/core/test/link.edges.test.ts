import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Identity } from "../src/identity";
import { createLink, type LinkParams } from "../src/invite";
import {
  EXPECT_PEER_MS,
  AWAITING_PEER_MS,
  IDLE_THRESHOLD,
  LinkSession,
  MAX_DHT_TEXT_BYTES,
  PRESENCE_HEARTBEAT,
  PRESENCE_WINDOW,
  RELAY_POLL_INTERVALS,
  type LinkSessionEvents,
  type LinkSessionOptions,
} from "../src/link";
import type { GhostRecord, SignedPacket } from "../src/pkarr";
import type { PkarrTransport } from "../src/transport";

// covers: chat.legacy.send, core.records

const NOW = 1_800_000_000_000;
const I = RELAY_POLL_INTERVALS;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => void vi.useRealTimers());

/** An in-memory Pkarr: the latest packet per key, stamped with the (fake) clock. */
function network() {
  const packets = new Map<string, SignedPacket>();
  const transport = () => {
    const t = {
      failPublish: null as unknown,
      failResolve: null as unknown,
      publish: vi.fn(async (identity: Identity, records: GhostRecord[]) => {
        if (t.failPublish !== null) throw t.failPublish;
        packets.set(identity.pubKeyZ32, { pubKeyZ32: identity.pubKeyZ32, timestampMicros: BigInt(Date.now()) * 1000n, records });
      }),
      resolve: vi.fn(async (key: string) => {
        if (t.failResolve !== null) throw t.failResolve;
        return packets.get(key) ?? null;
      }),
      describe: () => ({ protocol: "memory", relays: [] }),
    };
    return t satisfies PkarrTransport;
  };
  return { packets, transport };
}

function events() {
  return {
    onDiscoveryError: vi.fn(),
    onMessages: vi.fn(),
    onPresence: vi.fn(),
    onPeerAck: vi.fn(),
    onCallSignal: vi.fn(),
    onRtcSignal: vi.fn(),
    onStatus: vi.fn(),
    onPoll: vi.fn(),
  } satisfies LinkSessionEvents;
}

function session(params: LinkParams, transport: ReturnType<ReturnType<typeof network>["transport"]>, options: Partial<LinkSessionOptions> = {}) {
  const ev = events();
  const s = new LinkSession({ params, transport, pollIntervals: I, events: ev, ...options });
  return { s, ev, transport };
}

/** Two sessions of the same link on one in-memory network. */
function pair(optionsA: Partial<LinkSessionOptions> = {}, optionsB: Partial<LinkSessionOptions> = {}) {
  const net = network();
  const params = createLink();
  return { net, a: session(params.mine, net.transport(), optionsA), b: session(params.invite, net.transport(), optionsB) };
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const lastPoll = (ev: ReturnType<typeof events>) => ev.onPoll.mock.calls.filter(([p]) => !p.polling).at(-1)?.[0].nextInMs;

describe("LinkSession lifecycle", () => {
  it("starts once, and only announces itself when it has something to say", async () => {
    const { a } = pair();
    a.s.start();
    a.s.start();
    await settle();
    expect(a.transport.resolve).toHaveBeenCalledOnce();
    expect(a.transport.publish).not.toHaveBeenCalled();
    expect(a.ev.onStatus.mock.calls.map(([s]) => s)).toEqual(["connecting", "online"]);
    await a.s.stop();
  });

  it("publishes presence at start when advertising services or owing an acknowledgement", async () => {
    const withServices = pair({ getServices: () => [] });
    withServices.a.s.start();
    await settle();
    expect(withServices.a.transport.publish).toHaveBeenCalled();

    const owing = pair({ lastSeenTimestamp: 5 });
    owing.a.s.start();
    await settle();
    expect(owing.a.transport.publish).toHaveBeenCalled();
  });

  it("stops polling once stopped, announces the departure without services, and stops only once", async () => {
    const { a, b } = pair({ getServices: () => [{ id: "atlas", type: "http" }] });
    a.s.start();
    b.s.start();
    await settle();
    await a.s.stop();
    await a.s.stop();
    expect(a.ev.onStatus).toHaveBeenLastCalledWith("offline");
    const resolves = a.transport.resolve.mock.calls.length;
    await vi.advanceTimersByTimeAsync(I.background * 3);
    expect(a.transport.resolve).toHaveBeenCalledTimes(resolves);
    a.s.pollNow();
    expect(a.transport.resolve).toHaveBeenCalledTimes(resolves);

    b.s.pollNow();
    await settle();
    expect(b.ev.onPresence).toHaveBeenLastCalledWith(expect.objectContaining({ online: false, services: null }));
    await b.s.stop(false);
  });

  it("stops quietly without announcing, and survives a failing announcement", async () => {
    const { a } = pair();
    a.s.start();
    await settle();
    await a.s.stop(false);
    expect(a.transport.publish).not.toHaveBeenCalled();

    const other = pair();
    other.a.s.start();
    await settle();
    other.a.transport.failPublish = new Error("relay down");
    await expect(other.a.s.stop()).resolves.toBeUndefined();
  });

  it("ignores results of a poll that finishes after stop", async () => {
    const { a, b } = pair();
    await b.s.sendMessage("hello");
    let answer!: (packet: SignedPacket | null) => void;
    a.transport.resolve.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    a.s.start();
    await a.s.stop(false);
    answer(null);
    await settle();
    expect(a.ev.onMessages).not.toHaveBeenCalled();
    expect(a.ev.onStatus.mock.calls.map(([s]) => s)).toEqual(["connecting", "offline"]);
  });
});

describe("LinkSession messages", () => {
  it("delivers new messages once, acknowledges them, and the sender drops them on the ack", async () => {
    const { a, b } = pair();
    a.s.start();
    b.s.start();
    await settle();
    expect(await a.s.sendMessage("one", NOW - 2)).toBeNull();
    expect(await a.s.sendMessage("two", NOW - 1)).toBeNull();

    b.s.pollNow();
    await settle();
    expect(b.ev.onMessages).toHaveBeenCalledOnce();
    expect(b.ev.onMessages.mock.calls[0][0].map((m: { text: string }) => m.text)).toEqual(["one", "two"]);
    b.s.pollNow();
    await settle();
    expect(b.ev.onMessages).toHaveBeenCalledOnce();

    a.s.pollNow();
    await settle();
    expect(a.ev.onPeerAck).toHaveBeenCalledWith(NOW - 1);
    expect(a.s.takeUnacknowledged()).toEqual([]);
    await a.s.stop(false);
    await b.s.stop(false);
  });

  it("does not deliver messages older than what is already stored", async () => {
    const { a, b } = pair({}, { lastSeenTimestamp: NOW - 1 });
    await a.s.sendMessage("old", NOW - 1);
    b.s.start();
    await settle();
    expect(b.ev.onMessages).not.toHaveBeenCalled();
    await a.s.sendMessage("new", NOW);
    b.s.pollNow();
    await settle();
    expect(b.ev.onMessages.mock.calls[0][0].map((m: { text: string }) => m.text)).toEqual(["new"]);
    await b.s.stop(false);
  });

  it("accepts a message of exactly the DHT limit in bytes and refuses one byte more", async () => {
    const { a } = pair();
    expect(await a.s.sendMessage("é".repeat(MAX_DHT_TEXT_BYTES / 2))).toBeNull();
    const refused = await a.s.sendMessage(`${"é".repeat(MAX_DHT_TEXT_BYTES / 2)}x`);
    expect(refused).toContain(`${MAX_DHT_TEXT_BYTES + 1} bytes, max ${MAX_DHT_TEXT_BYTES}`);
    expect(a.transport.publish).toHaveBeenCalledOnce();
  });

  it("queues a message whose publish failed and retries it later", async () => {
    const { a } = pair();
    a.s.start();
    await settle();
    a.transport.failPublish = new Error("relay down");
    expect(await a.s.sendMessage("queued")).toBeNull();
    expect(a.ev.onStatus).toHaveBeenLastCalledWith("error");
    const attempts = a.transport.publish.mock.calls.length;
    a.transport.failPublish = null;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(a.transport.publish.mock.calls.length).toBeGreaterThan(attempts);
    expect(a.s.takeUnacknowledged().map((m) => m.m)).toEqual(["queued"]);
    await a.s.stop(false);
  });

  it("hands unacknowledged messages over to the data link once, reporting them as acknowledged", async () => {
    const { a } = pair();
    await a.s.sendMessage("x", 10);
    await a.s.sendMessage("y", 30);
    await a.s.sendMessage("z", 20);
    expect(a.s.takeUnacknowledged().map((m) => m.m)).toEqual(["x", "y", "z"]);
    expect(a.ev.onPeerAck).toHaveBeenCalledWith(30);
    expect(a.s.takeUnacknowledged()).toEqual([]);
    expect(a.ev.onPeerAck).toHaveBeenCalledOnce();
  });
});

describe("LinkSession presence and signals", () => {
  it("sees an advertising peer as online with its nick, and offline once its packet is too old", async () => {
    const { a, b } = pair({}, { getServices: () => [{ id: "atlas", type: "http" }], nick: "Bob" });
    b.s.start();
    await settle();
    await b.s.stop(false);
    a.s.start();
    await settle();
    expect(a.s.peerPresence).toEqual({ online: true, lastPacketAt: NOW, nick: "Bob", services: [{ id: "atlas", type: "http" }] });

    vi.setSystemTime(NOW + PRESENCE_WINDOW);
    a.s.pollNow();
    await settle();
    expect(a.s.peerPresence).toMatchObject({ online: false, lastPacketAt: NOW, services: null });
    await a.s.stop(false);
  });

  it("clears an empty nick and publishes the new one", async () => {
    const { a, b } = pair({ nick: "Alice" });
    a.s.setNick("");
    await a.s.refreshAdvertisement();
    b.s.start();
    await settle();
    expect(b.s.peerPresence.nick).toBeUndefined();
    a.s.setNick("Al");
    await a.s.refreshAdvertisement();
    b.s.pollNow();
    await settle();
    expect(b.s.peerPresence.nick).toBe("Al");
    await b.s.stop(false);
  });

  it("republishes presence on the heartbeat only while advertising", async () => {
    let services: { id: string; type: string }[] | undefined = [];
    const { a } = pair({ getServices: () => services });
    a.s.start();
    await settle();
    const before = a.transport.publish.mock.calls.length;
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT);
    expect(a.transport.publish.mock.calls.length).toBe(before + 1);
    services = undefined;
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT);
    expect(a.transport.publish.mock.calls.length).toBe(before + 1);
    await a.s.stop(false);
  });

  it("raises each call and RTC signal once, not on every poll", async () => {
    const { a, b } = pair();
    b.s.start();
    await b.s.setCallSignal("ring");
    await b.s.setRtcSignal('{"t":"o"}');
    a.s.start();
    await settle();
    a.s.pollNow();
    await settle();
    expect(a.ev.onCallSignal.mock.calls).toEqual([["ring"]]);
    expect(a.ev.onRtcSignal.mock.calls).toEqual([['{"t":"o"}']]);

    await b.s.setCallSignal("ring again");
    a.s.pollNow();
    await settle();
    expect(a.ev.onCallSignal.mock.calls).toEqual([["ring"], ["ring again"]]);
    await a.s.stop(false);
    await b.s.stop(false);
  });

  it("keeps the RTC signal out of packets published while not running", async () => {
    const { a, b } = pair();
    await b.s.setRtcSignal("sig");
    a.s.start();
    await settle();
    expect(a.ev.onRtcSignal).not.toHaveBeenCalled();
    await a.s.stop(false);
  });

  it("does not republish an unchanged RTC signal, and reports a failed publish only when asked", async () => {
    const { a } = pair();
    await a.s.setRtcSignal("sig");
    await a.s.setRtcSignal("sig");
    expect(a.transport.publish).toHaveBeenCalledOnce();

    a.transport.failPublish = new Error("relay down");
    await expect(a.s.setRtcSignal("other")).resolves.toBeUndefined();
    await expect(a.s.setRtcSignal(null, true)).rejects.toThrow("relay down");
  });

  it("does not publish the RTC signal or services in its departure packet", async () => {
    const { a, b } = pair({ getServices: () => [] });
    a.s.start();
    await a.s.setRtcSignal("sig");
    await a.s.stop();
    b.s.start();
    await settle();
    expect(b.ev.onRtcSignal).not.toHaveBeenCalled();
    expect(b.s.peerPresence.online).toBe(false);
    await b.s.stop(false);
  });

  it("tells whether an RTC signal still fits in the packet", () => {
    const { a } = pair();
    expect(a.s.fitsRtcSignal("x".repeat(100))).toBe(true);
    expect(a.s.fitsRtcSignal("x".repeat(5_000))).toBe(false);
  });
});

describe("LinkSession discovery errors", () => {
  it("reports read failures and clears them when a read succeeds", async () => {
    const { a } = pair();
    a.transport.failResolve = new Error("timeout");
    a.s.start();
    await settle();
    expect(a.ev.onDiscoveryError).toHaveBeenLastCalledWith("Could not read discovery: timeout");
    expect(a.ev.onStatus).toHaveBeenLastCalledWith("error");
    a.transport.failResolve = null;
    a.s.pollNow();
    await settle();
    expect(a.ev.onDiscoveryError).toHaveBeenLastCalledWith(null);
    expect(a.ev.onStatus).toHaveBeenLastCalledWith("online");
    await a.s.stop(false);
  });

  it("reports publish and read failures together, including thrown non-errors", async () => {
    const { a } = pair();
    a.transport.failResolve = "offline";
    a.transport.failPublish = 503;
    a.s.start();
    await settle();
    await a.s.refreshAdvertisement();
    expect(a.ev.onDiscoveryError).toHaveBeenLastCalledWith("Could not read discovery: offline. Could not publish discovery: 503");
    await a.s.stop(false);
  });

  it("retries a failed publish after a pause while running", async () => {
    const { a } = pair();
    a.s.start();
    await settle();
    a.transport.failPublish = new Error("down");
    await a.s.setCallSignal("ring");
    const attempts = a.transport.publish.mock.calls.length;
    a.transport.failPublish = null;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(a.transport.publish.mock.calls.length).toBe(attempts + 1);
    expect(a.ev.onDiscoveryError).toHaveBeenLastCalledWith(null);
    await a.s.stop(false);
  });

  it("coalesces publishes requested while one is in flight into a single follow-up", async () => {
    const { a } = pair();
    let release!: () => void;
    a.transport.publish.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    a.s.start();
    const first = a.s.refreshAdvertisement();
    const more = [a.s.refreshAdvertisement(), a.s.refreshAdvertisement(), a.s.refreshAdvertisement()];
    release();
    await Promise.all([first, ...more]);
    expect(a.transport.publish).toHaveBeenCalledTimes(2);
    await a.s.stop(false);
  });
});

describe("LinkSession poll pacing", () => {
  it("waits at the active pace for a contact never seen, then falls back to the background pace", async () => {
    const { a } = pair();
    a.s.start();
    await settle();
    expect(lastPoll(a.ev)).toBe(I.active);
    vi.setSystemTime(NOW + AWAITING_PEER_MS);
    a.s.pollNow();
    await settle();
    expect(lastPoll(a.ev)).toBe(I.background);
    await a.s.stop(false);
  });

  it("polls fast while signaling, for a bounded time", async () => {
    const { a } = pair();
    a.s.start();
    await settle();
    a.s.setFastPoll(true);
    await settle();
    expect(lastPoll(a.ev)).toBe(I.fast);
    vi.setSystemTime(NOW + 45_000);
    a.s.pollNow();
    await settle();
    expect(lastPoll(a.ev)).toBe(I.active);
    a.s.setFastPoll(false);
    await a.s.stop(false);
  });

  it("looks fast for a while when an offer is on its way, then falls back; a longer fast window is kept", async () => {
    const { a, b } = pair();
    await b.s.refreshAdvertisement();
    a.s.start();
    await settle();
    expect(lastPoll(a.ev)).toBe(I.background); // the peer was seen: no longer awaiting it
    const polls = a.transport.resolve.mock.calls.length;
    a.s.expectPeer();
    await settle();
    expect(a.transport.resolve).toHaveBeenCalledTimes(polls + 1); // looks at once
    expect(lastPoll(a.ev)).toBe(I.fast);
    vi.setSystemTime(NOW + EXPECT_PEER_MS - 1);
    a.s.pollNow();
    await settle();
    expect(lastPoll(a.ev)).toBe(I.fast);
    vi.setSystemTime(NOW + EXPECT_PEER_MS);
    a.s.pollNow();
    await settle();
    expect(lastPoll(a.ev)).toBe(I.background);

    // Signaling's own fast window (45 s) is longer: awaiting an offer does not cut it short, nor poll again.
    a.s.setFastPoll(true);
    await settle();
    const before = a.transport.resolve.mock.calls.length;
    a.s.expectPeer();
    await settle();
    expect(a.transport.resolve).toHaveBeenCalledTimes(before);
    vi.setSystemTime(NOW + EXPECT_PEER_MS + 40_000);
    a.s.pollNow();
    await settle();
    expect(lastPoll(a.ev)).toBe(I.fast);
    await a.s.stop(false);
  });

  it("slows down while the data link carries everything, and looks at once when it drops", async () => {
    const { a } = pair();
    a.s.start();
    await settle();
    a.s.setDataLinkOpen(true);
    a.s.setFastPoll(true);
    await settle();
    expect(lastPoll(a.ev)).toBe(I.connected);
    const polls = a.transport.resolve.mock.calls.length;
    a.s.setDataLinkOpen(false);
    await settle();
    expect(a.transport.resolve).toHaveBeenCalledTimes(polls + 1);
    expect(lastPoll(a.ev)).toBe(I.fast);
    await a.s.stop(false);
  });

  it("polls at chat pace while looked at, and at the idle pace after a quiet minute", async () => {
    const { a, b } = pair();
    await b.s.refreshAdvertisement();
    a.s.start();
    await settle();
    a.s.setActive(true);
    await settle();
    expect(lastPoll(a.ev)).toBe(I.active);
    vi.setSystemTime(NOW + IDLE_THRESHOLD + 1);
    a.s.pollNow();
    await settle();
    expect(lastPoll(a.ev)).toBe(I.idle);
    a.s.setActive(false);
    a.s.pollNow();
    await settle();
    expect(lastPoll(a.ev)).toBe(I.background);
    await a.s.stop(false);
  });

  it("does not start a second poll while one is running", async () => {
    const { a } = pair();
    let answer!: (packet: SignedPacket | null) => void;
    a.transport.resolve.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    a.s.start();
    a.s.pollNow();
    a.s.pollNow();
    expect(a.transport.resolve).toHaveBeenCalledOnce();
    answer(null);
    await settle();
    await a.s.stop(false);
  });
});
