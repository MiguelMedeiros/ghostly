import { appendFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostLink } from "../src/ghostlink";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { RELAY_POLL_INTERVALS } from "../src/link";
import { RelayTransport } from "../src/relay";
import { DiscoveryBudgetError, withRequestOptions, type PkarrTransport } from "../src/transport";
import { emptyDhtDeliveryState, type DhtDeliveryState } from "../src/dhtDelivery";
import { setLinkTraceSink } from "../src/linkTrace";
import { closeWorld, fakePeerConnection, invitationWhere, killRtc, rtc, useFakeWorld, yieldToLoop, type Side } from "./support/pairingWorld";

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
  /** Every packet put, in order. */
  puts: { at: number; key: string; body: Uint8Array }[] = [];
  /** `host key` → an older packet that relay still serves: it missed the newer ones (its budget refused them). */
  stale = new Map<string, Uint8Array>();
  /** `host key`: that relay has no packet under the key (it answers 404), whatever the others hold. */
  missing = new Set<string>();
  constructor(readonly hosts: string[]) {}
  get urls() { return this.hosts.map(h => `https://${h}`); }
  fetchFor(who: string): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input)), key = url.pathname.slice(1);
      this.requests.push({ at: Date.now(), who, host: url.host, method: init?.method ?? "GET", key });
      // Relays behind one name share what they store.
      if (init?.method === "PUT") {
        const body = new Uint8Array(init.body as ArrayBuffer);
        this.packets.set(key, body); this.puts.push({ at: Date.now(), key, body }); this.stale.delete(`${url.host} ${key}`);
        return new Response(null, { status: 204 });
      }
      const packet = this.missing.has(`${url.host} ${key}`) ? undefined : this.stale.get(`${url.host} ${key}`) ?? this.packets.get(key);
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
  transport(who: string, relays = this.urls): RelayTransport { return new RelayTransport({ relays, fetch: this.fetchFor(who), log: () => {} }); }
}

const report = (row: Record<string, unknown>) => { const file = process.env.SHARES_REPORT; if (file) appendFileSync(file, JSON.stringify(row) + "\n"); };
const keyOf = (side: Side) => identityFromSeedB64(side.seedB64).pubKeyZ32;
const links: GhostLink[] = [];

/** One side of a saved contact (a chat, or a group's edge: pinned in advance), as node.ts `startLink` opens it. */
function open(owner: string, transport: PkarrTransport, side: Side, peer: Side, options: { dht?: { state: DhtDeliveryState }; resume?: boolean; resumeFloor?: number; expectPeer?: boolean } = {}): GhostLink {
  const link = new GhostLink({
    params: side.params,
    pairing: { credentials: { seedB64: side.seedB64, peerKey: keyOf(peer) }, pinPeer: async () => {}, trustOnFirstUse: true },
    dht: options.dht ? { state: options.dht.state, save: async state => { options.dht!.state = state; } } : undefined,
    native: { peerTransports: ["webrtc/1"], peerFallback: true, automatic: true },
    ...(options.resume ? { resume: "webrtc/1" as const, resumeFloor: options.resumeFloor } : {}),
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
 * A member of a private group is killed and starts again (bug hunt r5a, 2026-09-29, three CLIs on the public relays): it
 * has a chat and an edge (or two, in two groups) with each of the two others. Back, every link offers at once and looks
 * for an answer, but the others hold the dead sessions until their connections go (`noticeMs` from the kill: about 20 s
 * with node-datachannel, 45 s where liveness finds out). Case `order:groups:noticeMs`; `MESH_BACK_CASES` runs others.
 * On the CLI (more publishes at start than here) one group was enough: edges live 75 to 110 s after the restart.
 */
describe("a member of a private group killed and back, with a chat and an edge to each other member", () => {
  const cases = (process.env.MESH_BACK_CASES ?? "lower:2:20000,higher:2:20000,lower:2:25000,lower:1:40000,higher:1:40000,lower:2:30000,higher:2:30000,higher:2:40000,lower:2:3000").split(",").map(c => {
    const [order, groups, noticeMs] = c.split(":");
    return { order: order as "lower" | "higher", groups: Number(groups), noticeMs: Number(noticeMs) };
  });
  // An answer not taken fails as ICE gives up (31 s with node-datachannel, #408): a dialer that reads it later misses it.
  beforeEach(() => { rtc.answerFailsAfterMs = 31_000; });
  it.each(cases)("its key the $order on the edges, $groups group(s), its end noticed after $noticeMs ms: every edge live soon after", async ({ order, groups, noticeMs }) => {
    // The default relays and their shares: 30 requests a minute on one, 60 on the other.
    const relays = new MemoryRelays(["pkarr.pubky.org", "pkarr.pubky.app"]);
    const groupsOf = (t: PkarrTransport) => withRequestOptions(t, { group: true });
    // Per pair of members: their chat, and an edge per group. On the edges C dials when its key is the lower one (the
    // "inviter" side dials in `invitationWhere`); C is always the first of a pair it is in.
    const pair = () => ({ chat: invitationWhere("inviter"), edges: Array.from({ length: groups }, () => invitationWhere(order === "lower" ? "inviter" : "joiner")) });
    const withA = pair(), withB = pair(), ab = pair();
    const dhts = new Map<string, { state: DhtDeliveryState }>();
    const dht = (side: Side) => { if (!dhts.has(side.seedB64)) dhts.set(side.seedB64, { state: emptyDhtDeliveryState() }); return dhts.get(side.seedB64)!; };
    const ends = (made: { inviter: Side; joiner: Side }, first: boolean) => first ? [made.inviter, made.joiner] : [made.joiner, made.inviter];
    const openAll = (owner: string, t: PkarrTransport, pairs: [ReturnType<typeof pair>, boolean][], resume = false) => pairs.flatMap(([p, first]) => {
      const [me, peer] = ends(p.chat, first);
      return [{ kind: "chat", peer: me.params.peerPubKeyZ32, link: open(owner, t, me, peer, { dht: dht(me), resume }) },
        ...p.edges.map(e => ends(e, first)).map(([me, peer]) => ({ kind: "edge", peer: me.params.peerPubKeyZ32, link: open(owner, groupsOf(t), me, peer, { resume }) }))];
    });
    const startC = (t: PkarrTransport, resume: boolean) => openAll("c", t, [[withA, true], [withB, true]], resume);
    let c = startC(relays.transport("c"), false);
    const a = openAll("a", relays.transport("a"), [[withA, false], [ab, true]]);
    const b = openAll("b", relays.transport("b"), [[withB, false], [ab, false]]);
    const all = () => [...a, ...b, ...c].map(l => l.link);
    expect(await until(() => all().every(l => l.isDataLinkOpen), 240_000), "all live at first").toBeLessThan(Infinity);
    await run(70_000);

    // Killed: nothing said. The others' connections to it notice once its consent checks go unanswered (about 20 s with
    // node-datachannel; liveness gives up after 45 s where nothing says so).
    killRtc("c", noticeMs);
    await Promise.all(c.map(l => l.link.stop(false)));
    await run(2_500);
    // Back, a fresh process with its own budget: every link was live when it quit.
    c = startC(relays.transport("c2"), true);
    const startedAt = Date.now();
    const chats = c.filter(l => l.kind === "chat");
    let chatsMs = Infinity;
    const edgesMs = await until(() => {
      if (chatsMs === Infinity && chats.every(l => l.link.isDataLinkOpen)) chatsMs = Date.now() - startedAt;
      return all().every(l => l.isDataLinkOpen);
    }, 240_000);
    const share = relays.share("c2", startedAt, 60_000, { edges: c.filter(l => l.kind === "edge").map(l => l.peer), chats: chats.map(l => l.peer) });
    // …and on each relay: its writes and its reads in that minute, next to the relay's share (30 and 60).
    const perRelay = Object.fromEntries(relays.hosts.map(host => {
      const mine = relays.requests.filter(r => r.who === "c2" && r.host === host && r.at >= startedAt && r.at < startedAt + 60_000);
      return [host, { put: mine.filter(r => r.method === "PUT").length, get: mine.filter(r => r.method === "GET").length }];
    }));
    report({ scenario: "mesh-member-back", order, groups, noticeMs, edgesMs, chatsMs, share, perRelay });
    // Dev (eacaf6a6), from the restart: 62.6 s in every case (18.6 s with one group noticed after 20 s); the restarted
    // app's edges had spent the groups' share of both relays before the answers came, and with 45 s of fast looks its
    // chats too. Now: 18.6, 18.6, 26.6, 42.6 and 42.6 s, a few seconds after the others notice. With reads in turn per
    // key (#689) the first case is 26.6 s: one edge's read fell one past the groups' burst at 18 s, and the chats' reserve,
    // kept a minute after they were live, held it until the startup's requests aged out (66.6 s) until the reserve went
    // per chat. Two groups noticed after 30 or 40 s (bug hunt r6a, r7a), an answer not taken failing after 31 s: on dev
    // (9a94a7f4) lower:2:30000 92.6 s, higher:2:30000 42.6 s, higher:2:40000 66.6 s, the minute spent by 42 s with 14 puts
    // on each relay at start (six links' presence, then their offers). With the offer in the first packet (8 puts): 34.6,
    // 34.6 and 50.6 s. lower:2:40000 (not a default case) 66.6 → 58.6 s: six links looking every 2 s, then every 4 to 8 s,
    // still spend the minute before the others notice. higher:2:20000 18.6 → 26.6 s (one edge's read one past the groups'
    // burst at 18 s, as lower:2:20000 was already). Noticed at once (0.5 s after the restart, as after a goodbye): 2.6 s.
    expect(edgesMs, "every edge live again").toBeLessThanOrEqual(noticeMs + 12_000);
    if (noticeMs <= 5_000) expect(edgesMs, "noticed at once: live in the offers' first looks").toBeLessThanOrEqual(5_000);
  }, 600_000);
});

/**
 * A contact's offer from before the last session, served after a restart by a relay that missed the packet clearing it
 * (bug hunt r7a: a relay whose budget refused a packet the other relay took kept the older one). The app back answered
 * it, never sent its own resume offer, and waited on it until ICE gave up; the contact, which answers only once it
 * notices the old session went, was live with it a minute later. A contact that noticed during a long downtime and
 * offered then is answered at once as before.
 */
describe("a contact's offer from before the last session, after a restart", () => {
  beforeEach(() => { rtc.answerFailsAfterMs = 31_000; });
  it.each([
    { name: "old, on a relay that missed its clearing", stale: true, noticeMs: 20_000, downMs: 2_500 },
    { name: "made during a long downtime", stale: false, noticeMs: 5_000, downMs: 20_000 },
  ])("$name: live soon after the contact can answer", async ({ stale, noticeMs, downMs }) => {
    const relays = new MemoryRelays(["a.test", "b.test"]);
    // The contact has the lower key: it offered first, and after a restart the app back has to answer or be answered.
    const made = invitationWhere("inviter"), contact = made.inviter, me = made.joiner;
    const peer = open("p", relays.transport("p"), contact, me);
    const mine = open("c", relays.transport("c"), me, contact);
    expect(await until(() => peer.isDataLinkOpen && mine.isDataLinkOpen, 120_000), "live at first").toBeLessThan(Infinity);
    const liveSince = Date.now();
    const contactKey = me.params.peerPubKeyZ32, offer = relays.puts.filter(p => p.key === contactKey && p.at < liveSince - 300).pop()!;
    await run(30_000);
    // b.test missed what the contact put after its offer.
    if (stale) relays.stale.set(`b.test ${contactKey}`, offer.body);
    killRtc("c", noticeMs);
    await mine.stop(false);
    await run(downMs);
    // Back, reading b.test first (a fresh process's first relay), with the start of its last session kept.
    const back = open("c", relays.transport("c2", ["https://b.test", "https://a.test"]), me, contact, { resume: true, resumeFloor: liveSince });
    const liveMs = await until(() => back.isDataLinkOpen && peer.isDataLinkOpen, 180_000);
    report({ scenario: "offer-before-last-session", stale, noticeMs, downMs, liveMs });
    // Dev (d31cdaad): the old offer answered, 32.1 s (its answer failed at 31 s; the contact noticed at 17.5 s); the
    // downtime offer 1.6 s. Now: 18.6 and 1.6 s.
    const canAnswerIn = Math.max(0, noticeMs - downMs);
    expect(liveMs, "live soon after the contact can answer").toBeLessThanOrEqual(canAnswerIn + 5_000);
  }, 300_000);
});

/**
 * The start of the last session is this device's clock, and an offer's time is the contact's. Held one against the
 * other, an offer the contact made a moment ago read as "from before the last session" for as long as the contact's
 * clock was behind the moment that session began: an app that restarted within two minutes of going live, with a
 * contact whose clock ran two minutes behind, dropped every offer of the contact until its clock caught up. Seen with
 * two web apps (2026-10-02): both reloaded 40 s after pairing, live again after 190 s; with clocks that agree, 3 s.
 * When both apps are back at once both offer, and the one with the lower key keeps its offer: the other has to take
 * it. An offer this run saw arrive (it was not in the contact's record at an earlier read) is new, whatever its time.
 */
describe("both apps restart soon after their session began, and the contact's clock is behind", () => {
  beforeEach(() => { rtc.answerFailsAfterMs = 31_000; });
  it.each([
    { name: "two minutes", behindMs: 2 * 60_000 },
    { name: "nine minutes", behindMs: 9 * 60_000 },
  ])("$name behind: live again within seconds", async ({ behindMs }) => {
    const relays = new MemoryRelays(["a.test", "b.test"]);
    // The contact has the lower key: its offer is the one that stands when both offer.
    const made = invitationWhere("inviter"), contact = made.inviter, me = made.joiner;
    const peer = open("p", relays.transport("p"), contact, me);
    const mine = open("c", relays.transport("c"), me, contact);
    expect(await until(() => peer.isDataLinkOpen && mine.isDataLinkOpen, 120_000), "live at first").toBeLessThan(Infinity);
    const liveSince = Date.now();
    await run(20_000);
    killRtc("c", 1_000); killRtc("p", 1_000);
    await mine.stop(false); await peer.stop(false);
    await run(2_500);
    // Both back, this app a second before its contact. The contact's clock is behind this one: by this clock the
    // session began that much after the time the contact's offers say, and by the contact's that much before mine.
    const back = open("c", relays.transport("c2"), me, contact, { resume: true, resumeFloor: liveSince + behindMs });
    await run(1_000);
    const peerBack = open("p", relays.transport("p2"), contact, me, { resume: true, resumeFloor: liveSince - behindMs });
    const liveMs = await until(() => back.isDataLinkOpen && peerBack.isDataLinkOpen, 15 * 60_000);
    report({ scenario: "both-restart-soon-after-live-contact-behind", behindMs, liveMs });
    expect(liveMs, "live within seconds of the contact's offer").toBeLessThanOrEqual(10_000);
  }, 300_000);
});

/**
 * An offer is new to this app when a read of the contact's record did not have it and the next one does. That holds
 * only when the first of the two showed what the record held: a relay that has no packet of the contact's says nothing
 * of what another relay still holds, and a copy the transport kept says nothing of now. An offer made long ago must
 * not be answered for having shown up late: answering it holds the data link on a connection nobody offers any more.
 */
describe("an offer made long ago that shows up after this run's first read", () => {
  const steps = (lines: string[], me: string, step: string) => lines.map(l => JSON.parse(l) as { me: string; step: string; state?: string }).filter(l => l.me === me.slice(0, 6) && l.step === step);

  it.each([
    { name: "a contact gone for ten minutes, its last packet (with its offer) on one relay only, the other answering that it has none", resume: false },
    { name: "the same on a chat that was live at its last run, the contact's clock ten minutes behind this one (its offer reads as from before that session either way)", resume: true },
  ])("$name: not answered", async ({ resume }) => {
    const lines: string[] = [];
    setLinkTraceSink(line => lines.push(line));
    try {
      const relays = new MemoryRelays(["a.test", "b.test"]);
      const made = invitationWhere("inviter"), contact = made.inviter, me = made.joiner;
      const peer = open("p", relays.transport("p"), contact, me);
      const mine = open("c", relays.transport("c"), me, contact);
      expect(await until(() => peer.isDataLinkOpen && mine.isDataLinkOpen, 120_000), "live at first").toBeLessThan(Infinity);
      const liveSince = Date.now();
      const contactKey = me.params.peerPubKeyZ32, offer = relays.puts.filter(p => p.key === contactKey && p.at < liveSince - 300).pop()!;
      // Both apps go; the contact's packet from before the session, its offer still in it, is all that is left, on b.test.
      killRtc("c", 1_000); killRtc("p", 1_000);
      await mine.stop(false); await peer.stop(false);
      await run(10 * 60_000);
      relays.packets.delete(contactKey);
      relays.missing.add(`a.test ${contactKey}`);
      relays.stale.set(`b.test ${contactKey}`, offer.body);
      lines.length = 0;
      // Back, reading a.test first: nothing there. Then b.test: the old packet.
      const back = open("c", relays.transport("c2", ["https://a.test", "https://b.test"]), me, contact, resume ? { resume: true, resumeFloor: liveSince + 10 * 60_000 } : {});
      await run(30_000);
      expect(steps(lines, back.myPubKeyZ32, "rtc-signal-in"), "the old offer was read").not.toHaveLength(0);
      expect(steps(lines, back.myPubKeyZ32, "datalink").filter(l => l.state === "answering"), "and not answered").toEqual([]);
    } finally { setLinkTraceSink(null); }
  }, 300_000);
});

/**
 * What an edge whose member is gone for good costs: the member's app is killed and never comes back. The edge that
 * stayed notices, offers again and again (each offer stands 90 s, then waits longer between tries), and reads the
 * member's key meanwhile. Longer-standing offers (looked at every 4 to 8 s once 10 s old) must not cost more reads.
 */
describe("an edge whose member never comes back", () => {
  it("reads no more a minute than before, while its offers stand longer", async () => {
    const relays = new MemoryRelays(["pkarr.pubky.org", "pkarr.pubky.app"]);
    const made = invitationWhere("inviter");
    const stays = open("stays", withRequestOptions(relays.transport("stays"), { group: true }), made.inviter, made.joiner);
    const goes = open("goes", withRequestOptions(relays.transport("goes"), { group: true }), made.joiner, made.inviter);
    expect(await until(() => stays.isDataLinkOpen && goes.isDataLinkOpen, 120_000), "live at first").toBeLessThan(Infinity);
    await run(70_000);
    killRtc("goes", 20_000);
    await goes.stop(false);
    const killedAt = Date.now();
    await run(20 * 60_000);
    const perMinute = (fromMin: number, toMin: number) =>
      relays.requests.filter(r => r.who === "stays" && r.method === "GET" && r.at >= killedAt + fromMin * 60_000 && r.at < killedAt + toMin * 60_000).length / (toMin - fromMin);
    const reads = { first2: perMinute(0, 2), next3: perMinute(2, 5), next5: perMinute(5, 10), last10: perMinute(10, 20) };
    report({ scenario: "dead-edge", reads });
    // Dev (eacaf6a6), reads a minute in minutes 0-2, 2-5, 5-10 and 10-20: 17.5, 16.3, 6.4 and 2. Now: 8.5, 10.7, 4.6
    // and 2 (each offer looks fast only its first 10 s).
    expect(reads.first2).toBeLessThanOrEqual(12);
    expect(reads.next3).toBeLessThanOrEqual(13);
    expect(reads.next5).toBeLessThanOrEqual(6);
    expect(reads.last10).toBeLessThanOrEqual(2);
  }, 600_000);
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
