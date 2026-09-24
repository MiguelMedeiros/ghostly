import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostLink } from "../src/ghostlink";
import { createLink, type LinkParams } from "../src/invite";
import { createIdentity, identityFromSeedB64, type Identity } from "../src/identity";
import { EXPECT_PEER_MS, RELAY_POLL_INTERVALS } from "../src/link";
import type { GhostRecord, SignedPacket } from "../src/pkarr";
import type { PkarrTransport } from "../src/transport";

// covers: chat.paired.reconnect, groups.link.join

/**
 * Only the lower key dials, as soon as it sees the other side here; its offer lands in its packet a
 * moment after its presence did. The side that answers must not leave that offer to a background
 * poll (30 s on the relays): that wait, twice (the entry session, then the edge to the admin), was
 * most of the time a join through a group's link took.
 */
const NOW = 1_800_000_000_000;
const I = RELAY_POLL_INTERVALS;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
const live: GhostLink[] = [];
afterEach(async () => {
  await Promise.all(live.splice(0).map(link => link.stop(false)));
  vi.useRealTimers();
});

function network() {
  const packets = new Map<string, SignedPacket>();
  const transport = {
    publish: vi.fn(async (identity: Identity, records: GhostRecord[]) => {
      packets.set(identity.pubKeyZ32, { pubKeyZ32: identity.pubKeyZ32, timestampMicros: BigInt(Date.now()) * 1000n, records });
    }),
    resolve: vi.fn(async (key: string) => packets.get(key) ?? null),
    describe: () => ({ protocol: "memory", relays: [] }),
  } satisfies PkarrTransport;
  return transport;
}

function side(params: LinkParams, transport: PkarrTransport) {
  const onPoll = vi.fn();
  const dials = vi.fn();
  const link = new GhostLink({
    params: { ...params, profile: "paired-chat/1" },
    pairing: { credentials: { seedB64: createIdentity().seedB64 }, pinPeer: vi.fn(async () => {}), trustOnFirstUse: true },
    transport,
    pollIntervals: I,
    autoConnect: true,
    rtcAvailable: true,
    createPeerConnection: () => { dials(); throw new Error("no WebRTC in this test"); },
    localFetch: vi.fn(), getServices: () => [{ id: "chat", type: "chat" }], getHostedHttpService: () => undefined,
    events: { onPoll },
  });
  live.push(link);
  const lastPoll = () => onPoll.mock.calls.filter(([p]) => !p.polling).at(-1)?.[0].nextInMs;
  return { link, lastPoll, dials, key: identityFromSeedB64(params.seedB64).pubKeyZ32 };
}

/** One link's two ends, `low` the one whose key sorts first (it dials) and `high` the one that answers. */
function ends() {
  const transport = network();
  const invitation = createLink();
  const [x, y] = [side(invitation.mine, transport), side(invitation.invite, transport)];
  return x.key < y.key ? { low: x, high: y, transport } : { low: y, high: x, transport };
}

describe("the side that answers looks fast while an offer is on its way", () => {
  it("polls at the fast pace once it sees the dialing side here, and not for long", async () => {
    const { low, high } = ends();
    low.link.start();
    await vi.advanceTimersByTimeAsync(0);
    high.link.start();
    await vi.advanceTimersByTimeAsync(0);
    // It saw the lower key here: that side dials, so it looks fast, not at the 30 s background pace.
    expect(high.lastPoll()).toBe(I.fast);
    expect(high.dials).not.toHaveBeenCalled();

    // Nobody offered (no WebRTC here): after the window it goes back to the background pace.
    await vi.advanceTimersByTimeAsync(EXPECT_PEER_MS + I.fast);
    expect(high.lastPoll()).toBe(I.background);
  });

  it("does it once per packet of the peer's, again when the peer publishes anew", async () => {
    const { low, high } = ends();
    low.link.start();
    high.link.start();
    await vi.advanceTimersByTimeAsync(EXPECT_PEER_MS + 2 * I.fast);
    expect(high.lastPoll()).toBe(I.background);
    // The same packet seen again does not start another window.
    await vi.advanceTimersByTimeAsync(I.background);
    expect(high.lastPoll()).toBe(I.background);
    // The peer said something new (it came back, it re-offered): look fast again.
    await (low.link as unknown as { session: { refreshAdvertisement(): Promise<void> } }).session.refreshAdvertisement();
    await vi.advanceTimersByTimeAsync(I.background);
    expect(high.lastPoll()).toBe(I.fast);
  });

  it("a peer seen here for a while already (an old packet) is not waited on fast: nothing is coming now", async () => {
    const { low, high } = ends();
    low.link.start();
    await vi.advanceTimersByTimeAsync(0);
    // The dialing side has been online a while; this side starts later, as an app opening does.
    await vi.advanceTimersByTimeAsync(EXPECT_PEER_MS + 1);
    await low.link.stop(false);
    high.link.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(high.lastPoll()).toBe(I.background);
  });

  it("a link made for a peer due any moment looks fast until it shows up", async () => {
    const { low } = ends();
    low.link.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(low.lastPoll()).toBe(I.active); // never seen: the awaiting pace
    low.link.expectPeer();
    await vi.advanceTimersByTimeAsync(0);
    expect(low.lastPoll()).toBe(I.fast);
    await vi.advanceTimersByTimeAsync(EXPECT_PEER_MS + I.fast);
    expect(low.lastPoll()).toBe(I.active);
  });

  it("the dialing side dials instead of waiting", async () => {
    const { low, high } = ends();
    high.link.start();
    await vi.advanceTimersByTimeAsync(0);
    low.link.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(low.dials).toHaveBeenCalled();
  });
});
