import { appendFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostLink } from "../src/ghostlink";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { RELAY_POLL_INTERVALS } from "../src/link";
import { RelayTransport } from "../src/relay";
import { DiscoveryBudgetError, withRequestOptions, type PkarrTransport } from "../src/transport";
import { emptyDhtDeliveryState, type DhtDeliveryState } from "../src/dhtDelivery";
import { setLinkTraceSink } from "../src/linkTrace";
import { closeWorld, fakePeerConnection, invitationWhere, killRtc, useFakeWorld, yieldToLoop, type Side } from "./support/pairingWorld";

// covers: core.relay-client, chat.paired.reconnect, groups.connection

/**
 * Who gets the relays' requests when several links want them at once (2026-09-27, the CLI twoPeers flake traced with
 * per-request relay logs). Each app has its own `RelayTransport` (its own 30 requests a minute per relay, as a process
 * has) over relays kept in memory; links are `GhostLink`s as the engine runs them, a group's edges on the transport
 * wrapped with `group: true` (node.ts `groupTransport`); WebRTC is stood in for by peer connections that open once
 * offer and answer met; fake time. Numbers go to `SHARES_REPORT` when it is set.
 */

/** Relays kept in memory: the newest payload per key, every request logged. */
class MemoryRelays {
  packets = new Map<string, Uint8Array>();
  requests: { at: number; who: string; host: string; method: string; key: string }[] = [];
  constructor(readonly hosts: string[]) {}
  get urls() { return this.hosts.map(h => `https://${h}`); }
  fetchFor(who: string): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input)), key = url.pathname.slice(1);
      this.requests.push({ at: Date.now(), who, host: url.host, method: init?.method ?? "GET", key });
      // Relays behind one name share what they store.
      if (init?.method === "PUT") { this.packets.set(key, new Uint8Array(init.body as ArrayBuffer)); return new Response(null, { status: 204 }); }
      const packet = this.packets.get(key);
      return packet ? new Response(packet as BodyInit) : new Response(null, { status: 404 });
    }) as typeof fetch;
  }
  /** `who`'s requests in [from, from + ms), by lane: the reads of each key in `lanes`, and everything else. */
  share(who: string, from: number, ms: number, lanes: Record<string, string[]>): Record<string, number> {
    const counts: Record<string, number> = Object.fromEntries([...Object.keys(lanes), "other"].map(lane => [lane, 0]));
    for (const r of this.requests) {
      if (r.who !== who || r.at < from || r.at >= from + ms) continue;
      const lane = r.method === "GET" ? Object.keys(lanes).find(l => lanes[l].includes(r.key)) : undefined;
      counts[lane ?? "other"]++;
    }
    return counts;
  }
  /** A process's own budget over these relays. */
  transport(who: string): RelayTransport { return new RelayTransport({ relays: this.urls, fetch: this.fetchFor(who), log: () => {} }); }
}

const report = (row: Record<string, unknown>) => { const file = process.env.SHARES_REPORT; if (file) appendFileSync(file, JSON.stringify(row) + "\n"); };
const keyOf = (side: Side) => identityFromSeedB64(side.seedB64).pubKeyZ32;
const links: GhostLink[] = [];

/** One side of a saved contact (a chat, or a group's edge: pinned in advance), as node.ts `startLink` opens it. */
function open(owner: string, transport: PkarrTransport, side: Side, peer: Side, options: { dht?: { state: DhtDeliveryState }; resume?: boolean; expectPeer?: boolean } = {}): GhostLink {
  const link = new GhostLink({
    params: side.params,
    pairing: { credentials: { seedB64: side.seedB64, peerKey: keyOf(peer) }, pinPeer: async () => {}, trustOnFirstUse: true },
    dht: options.dht ? { state: options.dht.state, save: async state => { options.dht!.state = state; } } : undefined,
    native: { peerTransports: ["webrtc/1"], peerFallback: true, automatic: true },
    ...(options.resume ? { resume: "webrtc/1" as const } : {}),
    transport,
    pollIntervals: RELAY_POLL_INTERVALS,
    autoConnect: true,
    createPeerConnection: () => fakePeerConnection(owner),
    localFetch: vi.fn(), getServices: () => [{ id: "chat", type: "chat" }], getHostedHttpService: () => undefined,
  });
  links.push(link);
  link.start();
  // A daemon: nobody looks at a chat.
  link.setChatActive(false);
  if (options.expectPeer) link.expectPeer();
  if (link.myPubKeyZ32 < side.params.peerPubKeyZ32) void link.connect().catch(() => {});
  return link;
}

async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 100) { await vi.advanceTimersByTimeAsync(100); await yieldToLoop(); }
}
async function until(check: () => boolean, limit: number): Promise<number> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > limit) return Infinity;
    await run(100);
  }
  return Date.now() - start;
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const loads: ReturnType<typeof setInterval>[] = [];
/**
 * A community group's requests on `groups` (a transport wrapped with `group: true`), read from a key nobody publishes:
 * its hub's periodic looks at its records (`background`), or its door's knock reads (node.ts reads knocks every 2 s for
 * ten minutes after a link is enabled, 5 s otherwise).
 */
function community(groups: PkarrTransport, everyMs: number, background: boolean): string {
  const key = createIdentity().pubKeyZ32;
  loads.push(setInterval(() => void groups.resolve(key, { background }).catch(() => {}), everyMs));
  return key;
}

beforeEach(() => {
  useFakeWorld();
  // Every step of every link, for reading where the time went.
  const trace = process.env.SHARES_TRACE;
  if (trace) setLinkTraceSink(line => appendFileSync(trace, line + "\n"));
});
afterEach(async () => {
  for (const load of loads.splice(0)) clearInterval(load);
  let stopped = false;
  const stopping = Promise.all(links.splice(0).map(link => link.stop(false))).finally(() => { stopped = true; });
  for (let i = 0; !stopped && i < 300; i++) await run(100);
  await stopping;
  await closeWorld();
});

/**
 * Cause 1. Alice is in a chat and two groups with Bob, and her daemon stops: Bob's chat and both edges lose her at
 * once, and all watch fast for her. She sends a message as a one-shot (a fresh process that starts only the chat, #401).
 * On dev (28f57efb) the edges spent both relays' minute in about 40 s, and the chat waited for the next minute to read
 * her offer; the reserve for a chat began only once a chat's request was refused.
 */
describe("a contact comes back to a chat while the groups shared with it watch too", () => {
  it.each([2_000, 10_000, 20_000, 30_000, 40_000])("the one-shot starts %i ms after the daemon stopped: the chat is live again in seconds", async after => {
    const relays = new MemoryRelays(["a.test", "b.test"]);
    const aliceRelays = relays.transport("alice"), bobRelays = relays.transport("bob");
    const aliceGroups = withRequestOptions(aliceRelays, { group: true }), bobGroups = withRequestOptions(bobRelays, { group: true });
    // The chat: Alice has the lower key (she dials). One edge each way.
    const chat = invitationWhere("inviter"), edgeA = invitationWhere("inviter"), edgeB = invitationWhere("joiner");
    const aliceDht = { state: emptyDhtDeliveryState() }, bobDht = { state: emptyDhtDeliveryState() };
    const alice = [open("alice", aliceRelays, chat.inviter, chat.joiner, { dht: aliceDht }), open("alice", aliceGroups, edgeA.inviter, edgeA.joiner), open("alice", aliceGroups, edgeB.inviter, edgeB.joiner)];
    const bob = [open("bob", bobRelays, chat.joiner, chat.inviter, { dht: bobDht }), open("bob", bobGroups, edgeA.joiner, edgeA.inviter), open("bob", bobGroups, edgeB.joiner, edgeB.inviter)];
    // One of the groups is a community: Bob's app looks at its records all the time (its background share on each relay).
    const hub = community(bobGroups, 1_500, true);
    expect(await until(() => [...alice, ...bob].every(l => l.isDataLinkOpen), 180_000), "all live at first").toBeLessThan(Infinity);
    await run(70_000);

    // Alice's daemon stops: it says goodbye on every link and exits.
    for (const link of alice) link.depart();
    await run(300);
    const stoppedAt = Date.now();
    await Promise.all(alice.map(link => link.stop(false)));
    killRtc("alice");
    await run(after);

    // The one-shot: a fresh process (its own budget), the chat alone, back from where the daemon left it.
    const oneShot = open("alice", relays.transport("alice-once"), chat.inviter, chat.joiner, { dht: aliceDht, resume: true });
    const startedAt = Date.now();
    const liveMs = await until(() => oneShot.isDataLinkOpen && bob[0].isDataLinkOpen, 120_000);
    const bobReads = relays.requests.filter(r => r.who === "bob" && r.at >= startedAt - 60_000 && r.at < startedAt).length;
    // What Bob's app spent from the stop to the one-shot, on both relays: its chat's reads, its edges', the community's looks.
    const share = relays.share("bob", stoppedAt, after, { chat: [chat.joiner.params.peerPubKeyZ32], edges: [edgeA.joiner.params.peerPubKeyZ32, edgeB.joiner.params.peerPubKeyZ32], community: [hub] });
    report({ scenario: "chat-back-with-groups", after, liveMs, bobRequestsInTheMinuteBefore: bobReads, share });
    // Dev (28f57efb): 2.6, 2.6, 4.6, 18.6 and 8.6 s; from 20 s on, Bob's minute was spent (60 of 60), the groups 29 of
    // the 42 requests before a one-shot at 30 s. Now: 2.6 to 4.6 s, the groups 15 of 30, and room left in the minute.
    expect(liveMs, "the chat is live again").toBeLessThanOrEqual(10_000);
  }, 400_000);
});

/**
 * Cause 2. A new group's edge next to a community group on one relay (or with one of two cooling down): the community's
 * background looks take their share (20 of 30), and on dev the edge was left one poll every 6 s, its offer and its answer
 * missing each other's fast windows.
 */
describe("a new group edge next to a community's background looks, on one relay", () => {
  it("opens in seconds: the looks yield while the edge signals", async () => {
    const results: number[] = [], shares: Record<string, number>[] = [];
    for (let run_ = 0; run_ < 4; run_++) {
      const relays = new MemoryRelays(["a.test"]);
      const apps = ["alice", "bob"].map(who => withRequestOptions(relays.transport(who), { group: true }));
      // Each app looks at a community's records every 3 s (the background share of the minute) and reads its door's
      // knocks every 6 s: the minute is spent when the edge starts.
      const keys = apps.map(groups => [community(groups, 3_000, true), community(groups, 6_000, false)]);
      await run(70_000 + run_ * 700);
      const startedAt = Date.now();
      // The admin admits the other: both open the edge and look fast for each other (node.ts `openEdge(…, expectPeer)`).
      const edge = invitationWhere(run_ % 2 === 0 ? "inviter" : "joiner");
      const a = open("alice", apps[0], edge.inviter, edge.joiner, { expectPeer: true }), b = open("bob", apps[1], edge.joiner, edge.inviter, { expectPeer: true });
      const liveMs = await until(() => a.isDataLinkOpen && b.isDataLinkOpen, 180_000);
      results.push(liveMs);
      // What the admin's app spent in the edge's first 30 s, on the one relay.
      await run(Math.max(0, startedAt + 30_000 - Date.now()));
      shares.push(relays.share("alice", startedAt, 30_000, { edge: [edge.inviter.params.peerPubKeyZ32], looks: [keys[0][0]], knocks: [keys[0][1]] }));
      for (const load of loads.splice(0)) clearInterval(load);
      await Promise.all([a.stop(false), b.stop(false)]);
    }
    report({ scenario: "edge-next-to-hub", liveMs: results, median: median(results), shares });
    // Dev (28f57efb): 76.6 s three times, and never in 3 min once; the looks took 9 of the edge's first 30 s. Now:
    // 4.6 to 10.6 s, the looks 5.
    expect(Math.max(...results), "every edge live").toBeLessThanOrEqual(20_000);
  }, 400_000);
});

/**
 * Cause 3. The side that answers looks fast for 30 s from the dialer's fresh packet (`EXPECT_PEER_MS`). The dialer's
 * offer held back by its budget can land just after: on dev the answerer read it at its next background poll, 30 s on.
 */
describe("the dialer's offer held back by its budget past the answerer's fast window", () => {
  it.each([20_000, 29_000, 31_000, 34_000, 40_000, 50_000])("the offer lands %i ms after the dialer's first packet: read within seconds", async heldMs => {
    const relays = new MemoryRelays(["a.test", "b.test"]);
    const chat = invitationWhere("inviter");
    // The dialer's first packet goes out, then its budget holds every publish until `heldMs` from it.
    const dialerRelays = relays.transport("dialer");
    let firstAt = 0;
    const dialer: PkarrTransport = {
      ...dialerRelays,
      publish: async (identity, records, options) => {
        if (firstAt && Date.now() < firstAt + heldMs) throw new DiscoveryBudgetError(firstAt + heldMs - Date.now());
        await dialerRelays.publish(identity, records, options);
        firstAt ||= Date.now();
      },
      resolve: (key, options) => dialerRelays.resolve(key, options),
      describe: () => dialerRelays.describe(),
    };
    const a = open("dialer", dialer, chat.inviter, chat.joiner), b = open("answerer", relays.transport("answerer"), chat.joiner, chat.inviter);
    const liveMs = await until(() => a.isDataLinkOpen && b.isDataLinkOpen, 180_000);
    const afterOffer = liveMs - heldMs;
    report({ scenario: "held-offer", heldMs, liveMs, afterOfferMs: afterOffer });
    // Dev (28f57efb), live after the offer went out: 2.6, 3.6, 45.6, 42.6, 36.6 and 26.6 s (the answerer at its
    // background pace, and past 45 s the dialer too). Now: 2.6, 3.6, 3.6, 4.6, 6.6 and 12.6 s.
    expect(afterOffer, "live soon after the offer went out").toBeLessThanOrEqual(heldMs < 30_000 ? 5_000 : 16_000);
  }, 300_000);
});
