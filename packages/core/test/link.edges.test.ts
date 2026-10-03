import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityFromSeedB64, type Identity } from "../src/identity";
import { fromBase64Url } from "../src/bytes";
import { buildLinkRecords, emptyLinkRecords } from "../src/records";
import { createLink, type LinkParams } from "../src/invite";
import {
  EXPECT_PEER_MS,
  AWAITING_PEER_MS,
  IDLE_THRESHOLD,
  LinkSession,
  MAX_DHT_TEXT_BYTES,
  PRESENCE_HEARTBEAT,
  PRESENCE_WINDOW,
  presenceSeenAt,
  RELAY_POLL_INTERVALS,
  WATCH_PEER_MS,
  type LinkSessionEvents,
  type LinkSessionOptions,
} from "../src/link";
import type { GhostRecord, SignedPacket } from "../src/pkarr";
import type { PkarrTransport } from "../src/transport";

// covers: chat.legacy.send, core.records, chat.paired.clock-skew, app.clock-off

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
      /** The transport hands back the copy it kept (its budget held the read, its relays rest): the network answered nothing. */
      kept: false,
      answered: new Map<string, number>(),
      readAnsweredAt: (key: string) => t.answered.get(key),
      publish: vi.fn(async (identity: Identity, records: GhostRecord[]) => {
        if (t.failPublish !== null) throw t.failPublish;
        packets.set(identity.pubKeyZ32, { pubKeyZ32: identity.pubKeyZ32, timestampMicros: BigInt(Date.now()) * 1000n, records });
      }),
      resolve: vi.fn(async (key: string) => {
        if (t.failResolve !== null) throw t.failResolve;
        if (t.kept) return t.last.get(key) ?? null;
        t.answered.set(key, Date.now());
        t.last.set(key, packets.get(key) ?? null);
        return packets.get(key) ?? null;
      }),
      describe: () => ({ protocol: "memory", relays: [] }),
      last: new Map<string, SignedPacket | null>(),
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
    onPeerClock: vi.fn(),
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
  return { net, params, a: session(params.mine, net.transport(), optionsA), b: session(params.invite, net.transport(), optionsB) };
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
    expect(a.s.peerPresence).toEqual({ online: true, lastPacketAt: NOW, seenAt: NOW, nick: "Bob", services: [{ id: "atlas", type: "http" }] });

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
    // The first read of the run found it: nothing says since when it can be there.
    expect(a.ev.onRtcSignal.mock.calls).toEqual([['{"t":"o"}', undefined]]);

    await b.s.setCallSignal("ring again");
    a.s.pollNow();
    await settle();
    expect(a.ev.onCallSignal.mock.calls).toEqual([["ring"], ["ring again"]]);
    await a.s.stop(false);
    await b.s.stop(false);
  });

  it("says how a signal was seen to come: the read before it, and the peer's packet that read found", async () => {
    const { a, b } = pair({}, { getServices: () => [] });
    b.s.start();
    await settle();
    a.s.start();
    await settle();
    // The peer's packet was there at NOW, with no signal; the signal comes in its next one.
    vi.setSystemTime(NOW + 4_000);
    await b.s.setRtcSignal('{"t":"o"}');
    vi.setSystemTime(NOW + 6_000);
    a.s.pollNow();
    await settle();
    expect(a.ev.onRtcSignal.mock.calls).toEqual([['{"t":"o"}', { since: NOW, after: NOW }]]);
    await a.s.stop(false);
    await b.s.stop(false);
  });

  it("a read that found nothing of the peer's, or only the inviter's empty packet, says so: there is no packet to hold a signal against", async () => {
    for (const placeholder of [false, true]) {
      const { net, params, a, b } = pair(); const theirs = identityFromSeedB64(params.invite.seedB64).pubKeyZ32;
      if (placeholder) net.packets.set(theirs, { pubKeyZ32: theirs, timestampMicros: BigInt(NOW - 60_000) * 1000n, records: emptyLinkRecords() });
      a.s.start();
      await settle();
      vi.setSystemTime(NOW + 4_000);
      b.s.start();
      await b.s.setRtcSignal('{"t":"o"}');
      vi.setSystemTime(NOW + 6_000);
      a.s.pollNow();
      await settle();
      expect(a.ev.onRtcSignal.mock.calls, placeholder ? "after the empty packet" : "after nothing").toEqual([['{"t":"o"}', { since: NOW, after: null }]]);
      await a.s.stop(false);
      await b.s.stop(false);
      vi.setSystemTime(NOW);
    }
  });

  it("a copy the transport kept is not a read: a signal that shows up after one was not seen to come", async () => {
    // The relays' budget held the read, or every relay rested: `resolve` handed back what it had, and the record may
    // have held the signal all along (a relay that lagged, a packet days old).
    const { a, b } = pair();
    a.transport.kept = true;
    a.s.start();
    await settle();
    a.s.pollNow();
    await settle();
    vi.setSystemTime(NOW + 4_000);
    b.s.start();
    await b.s.setRtcSignal('{"t":"o"}');
    a.transport.kept = false;
    vi.setSystemTime(NOW + 6_000);
    a.s.pollNow();
    await settle();
    expect(a.ev.onRtcSignal.mock.calls).toEqual([['{"t":"o"}', undefined]]);
    // Nor does a transport that cannot say whether the network answered give one.
    const blind = pair();
    (blind.a.transport as { readAnsweredAt?: unknown }).readAnsweredAt = undefined;
    blind.a.s.start();
    await settle();
    blind.b.s.start();
    await blind.b.s.setRtcSignal('{"t":"o"}');
    blind.a.s.pollNow();
    await settle();
    expect(blind.a.ev.onRtcSignal.mock.calls).toEqual([['{"t":"o"}', undefined]]);
    for (const side of [a, b, blind.a, blind.b]) await side.s.stop(false);
  });

  /** The peer's packet as its own clock dated it: `skew` ms from this one. */
  const dateBy = (net: ReturnType<typeof network>, skew: number) => {
    for (const [key, packet] of net.packets) net.packets.set(key, { ...packet, timestampMicros: packet.timestampMicros + BigInt(skew) * 1000n });
  };

  it.each([
    ["two minutes behind", -2 * 60_000], ["an hour behind", -60 * 60_000], ["two minutes ahead", 2 * 60_000], ["an hour ahead", 60 * 60_000],
  ])("counts how long ago a peer whose clock is %s published on this clock, once it has read its record before", async (_, skew) => {
    const { net, a, b } = pair({}, { getServices: () => [] });
    a.s.start();
    await settle();
    vi.setSystemTime(NOW + 5_000);
    b.s.start();
    await settle();
    await b.s.stop(false);
    dateBy(net, skew);
    vi.setSystemTime(NOW + 8_000);
    a.s.pollNow();
    await settle();
    // Its packet is named by its own time, and was seen to come between this run's last two reads.
    expect(a.s.peerPresence).toMatchObject({ online: true, lastPacketAt: NOW + 5_000 + skew });
    expect(presenceSeenAt(a.s.peerPresence)).toBeGreaterThanOrEqual(NOW);
    expect(presenceSeenAt(a.s.peerPresence)).toBeLessThanOrEqual(NOW + 8_000);
    // The same packet read again is no newer.
    const seen = presenceSeenAt(a.s.peerPresence);
    vi.setSystemTime(NOW + 20_000);
    a.s.pollNow();
    await settle();
    expect(presenceSeenAt(a.s.peerPresence)).toBe(seen);
    // Gone once it is as old as presence lasts, counted here.
    vi.setSystemTime(seen + PRESENCE_WINDOW);
    a.s.pollNow();
    await settle();
    expect(a.s.peerPresence).toMatchObject({ online: false, services: null });
    await a.s.stop(false);
  });

  it("the first read of a run has only the packet's own time: never newer than the read, and a clock behind looks that much older", async () => {
    const ahead = pair({}, { getServices: () => [] });
    ahead.b.s.start();
    await settle();
    await ahead.b.s.stop(false);
    dateBy(ahead.net, 60 * 60_000);
    vi.setSystemTime(NOW + 1_000);
    ahead.a.s.start();
    await settle();
    expect(ahead.a.s.peerPresence).toMatchObject({ online: true, lastPacketAt: NOW + 60 * 60_000, seenAt: NOW + 1_000 });
    await ahead.a.s.stop(false);

    vi.setSystemTime(NOW);
    const behind = pair({}, { getServices: () => [] });
    behind.b.s.start();
    await settle();
    await behind.b.s.stop(false);
    dateBy(behind.net, -60 * 60_000);
    behind.a.s.start();
    await settle();
    expect(behind.a.s.peerPresence).toMatchObject({ online: false, seenAt: NOW - 60 * 60_000 });
    await behind.a.s.stop(false);
  });

  it("says what a peer's clock reads against this one when its packet comes between two reads, and nothing for one the first read finds", async () => {
    const { net, a, b } = pair({}, { getServices: () => [] });
    a.s.start();
    await settle();
    vi.setSystemTime(NOW + 4_000);
    b.s.start();
    await settle();
    await b.s.stop(false);
    // The peer's clock is two minutes ahead: that is what dated its packet.
    for (const [key, packet] of net.packets) net.packets.set(key, { ...packet, timestampMicros: packet.timestampMicros + 120_000_000n });
    vi.setSystemTime(NOW + 6_000);
    a.s.pollNow();
    await settle();
    expect(a.ev.onPeerClock.mock.calls).toEqual([[NOW + 4_000 + 120_000, NOW, NOW + 6_000]]);
    // The same packet read again says nothing new.
    a.s.pollNow();
    await settle();
    expect(a.ev.onPeerClock).toHaveBeenCalledOnce();
    await a.s.stop(false);

    // A session that starts with the packet already there cannot tell how long it has been there.
    const late = pair({}, { getServices: () => [] });
    late.b.s.start();
    await settle();
    late.a.s.start();
    await settle();
    expect(late.a.ev.onPeerClock).not.toHaveBeenCalled();
    await late.a.s.stop(false);
    await late.b.s.stop(false);
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

  it("marks as signaling the publish of a new offer or answer and the fast reads for the answer to its offer, nothing else", async () => {
    const { a } = pair({ getServices: () => [] });
    a.s.start();
    await settle();
    const lastPublish = () => (a.transport.publish.mock.lastCall as unknown[] | undefined)?.[2];
    const lastRead = () => (a.transport.resolve.mock.lastCall as unknown[] | undefined)?.[1];
    expect(lastPublish()).toBeUndefined();
    expect(lastRead()).not.toHaveProperty("signal");
    // An offer: its publish is signaling, and so are the fast reads for its answer once it is out.
    a.s.setFastPoll(true, true);
    await a.s.setRtcSignal('{"t":"o"}');
    expect(lastPublish()).toEqual({ signal: true });
    a.s.pollNow();
    await settle();
    expect(lastRead()).toMatchObject({ urgent: true, signal: true });
    // The same signal again (a presence refresh) is not.
    await a.s.refreshAdvertisement();
    expect(lastPublish()).toBeUndefined();
    // Fast reads that wait for no answer of ours (an answer sent, the peer expected) are not signaling.
    a.s.setFastPoll(true);
    a.s.pollNow();
    await settle();
    expect(lastRead()).toMatchObject({ urgent: true });
    expect(lastRead()).not.toHaveProperty("signal");
    await a.s.stop(false);
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
    // Then it slows down step by step: twice the fast pace, then as long as the window has been over, up to its pace.
    vi.setSystemTime(NOW + EXPECT_PEER_MS);
    a.s.pollNow();
    await settle();
    expect(lastPoll(a.ev)).toBe(2 * I.fast);
    const steps: number[] = [];
    for (const after of [6_000, 12_000, 24_000, I.background, 2 * I.background]) {
      vi.setSystemTime(NOW + EXPECT_PEER_MS + after);
      a.s.pollNow();
      await settle();
      steps.push(lastPoll(a.ev));
    }
    expect(steps).toEqual([6_000, 12_000, 24_000, I.background, I.background]);

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

  it("says its reads watch a contact that went away until the contact shows itself back (the relays' budget gives them a share)", async () => {
    const { a, b } = pair({}, { getServices: () => [] });
    b.s.start();
    a.s.start();
    await settle();
    expect(a.s.peerPresence.online).toBe(true);
    const watched = () => (a.transport.resolve.mock.calls.at(-1)?.[1] as { watch?: boolean } | undefined)?.watch === true;
    a.s.pollNow();
    await settle();
    expect(watched()).toBe(false);
    // The contact's app closes, leaving a last packet that advertises nothing: still watched.
    a.s.watchPeer();
    vi.setSystemTime(NOW + 1_000);
    await b.s.stop();
    await settle();
    expect(watched()).toBe(true);
    a.s.pollNow();
    await settle();
    expect(a.s.peerPresence.online).toBe(false);
    expect(watched()).toBe(true);
    // Back: the next read is the contact's like any other.
    vi.setSystemTime(NOW + 5_000);
    b.s.start();
    await settle();
    a.s.pollNow();
    await settle();
    expect(a.s.peerPresence.online).toBe(true);
    a.s.pollNow();
    await settle();
    expect(watched()).toBe(false);
    // A contact killed leaves no last packet: its old one is not a sign it is back.
    a.s.watchPeer();
    a.s.pollNow();
    await settle();
    expect(watched()).toBe(true);
    // Nor after the two minutes.
    vi.setSystemTime(NOW + 5_000 + WATCH_PEER_MS);
    a.s.pollNow();
    await settle();
    expect(watched()).toBe(false);
    await a.s.stop(false);
    await b.s.stop(false);
  });

  it("watches a contact that went away fast, then at the active pace: the step-down never slows that", async () => {
    const { a, b } = pair();
    await b.s.refreshAdvertisement();
    a.s.start();
    await settle();
    a.s.watchPeer();
    await settle();
    expect(lastPoll(a.ev)).toBe(I.fast);
    const paces: number[] = [];
    for (const after of [0, 10_000, 60_000]) {
      vi.setSystemTime(NOW + EXPECT_PEER_MS + after);
      a.s.pollNow();
      await settle();
      paces.push(lastPoll(a.ev));
    }
    expect(paces).toEqual([I.active, I.active, I.active]);
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

describe("LinkSession and an empty packet", () => {
  it("reads the packet an inviter puts under the contact's key as nobody there", async () => {
    const { transport, packets } = network();
    const link = createLink();
    const me = identityFromSeedB64(link.mine.seedB64), contact = identityFromSeedB64(link.invite.seedB64);
    const encKey = fromBase64Url(link.mine.encKeyB64);
    // The inviter warms the contact's key: a packet with nothing in it.
    packets.set(contact.pubKeyZ32, { pubKeyZ32: contact.pubKeyZ32, timestampMicros: BigInt(NOW - 60_000) * 1000n, records: emptyLinkRecords() });
    const onPresence = vi.fn();
    const session = new LinkSession({ params: { ...link.mine, profile: "paired-chat/1" }, transport: transport(), pollIntervals: I, getServices: () => [{ id: "chat", type: "chat" }], events: { onPresence } });
    session.start();
    await vi.advanceTimersByTimeAsync(I.active * 3);
    expect(onPresence).not.toHaveBeenCalled();
    expect(session.peerPresence).toEqual({ online: false, lastPacketAt: 0, services: null });
    // Then the contact's real first packet, which says they are here.
    packets.set(contact.pubKeyZ32, { pubKeyZ32: contact.pubKeyZ32, timestampMicros: BigInt(Date.now()) * 1000n,
      records: buildLinkRecords(contact.pubKeyZ32, { messages: [], ackTimestamp: 0, services: [{ id: "chat", type: "chat" }] }, encKey).records });
    await vi.advanceTimersByTimeAsync(I.active * 2);
    expect(session.peerPresence.online).toBe(true);
    expect(me.pubKeyZ32).not.toBe(contact.pubKeyZ32);
    await session.stop(false);
  });
});
