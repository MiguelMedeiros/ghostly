import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAEMON_WATCH_PEER_IDLE_MS, GhostLink, RELAY_POLL_INTERVALS, REQUESTS_PER_MINUTE, RelayTransport, SIGNALING_ALLOWANCE_SHARE, identityFromSeedB64, type PkarrTransport } from "@ghostly/core";
import { GhostlyNode, type NodeOptions } from "../src/engine/node";
import { ResumeTurns } from "../src/engine/resumeTurns";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { StoredLink } from "../src/shared/types";
import { closeWorld, fakePeerConnection, invitationWhere, run, useFakeWorld, type Side } from "../../core/test/support/pairingWorld";

// covers: chat.paired.reconnect, core.relay-client, headless.daemon

/**
 * A daemon restarted while every one of its 50 chats' contacts is online (bug hunt, 2026-11-17): each chat was live
 * when it stopped, and resumed at once as it started. The relays' per-minute budget was spread over all 50, few got
 * through a whole offer/answer round, and the rest of each minute went on reads and offers that led nowhere: 13 of
 * 50 were back 5 minutes on in this test, 13 to 30 in the CLI lab. The chats now resume a few at a time
 * (`ResumeTurns`), the most recently live first, and the next starts as each is back.
 *
 * An engine set up as the CLI's (`singleDevice`, `staysOnline`, `watchPeerIdleMs`, WebRTC and no native transport),
 * one relay at the default budget behind a `fetch` stub, and 50 contacts that each have a budget of their own (no
 * limit here). The engine's own last run (no limit either) leaves its records and states saved, as a real stop does.
 */

const CHATS = 50;
const RELAY = "https://relay-one.test";
const MIN = 60_000;
const peerKeyOf = (side: Side) => identityFromSeedB64(side.seedB64).pubKeyZ32;

const packets = new Map<string, Uint8Array>();
/** The relay, one store for everyone; `asked`: when each request of the restarted engine reached it. */
function relay(asked?: number[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = new URL(String(input)).pathname.slice(1);
    asked?.push(Date.now());
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (init?.method === "PUT") { packets.set(key, new Uint8Array(init.body as ArrayBuffer)); return new Response(null, { status: 204 }); }
    const body = packets.get(key);
    return body ? new Response(body as BodyInit, { status: 200 }) : new Response(null, { status: 404 });
  }) as typeof fetch;
}
const unlimited = () => new RelayTransport({ fetch: relay(), relays: [RELAY], requestsPerMinute: Infinity, log: () => {} });

const links: GhostLink[] = [];
/** A contact's side of a chat (or the app's, before it has an engine): a link as the engine makes one. */
function side(me: Side, contact: Side, transport: PkarrTransport, owner: string): GhostLink {
  const link = new GhostLink({
    params: me.params, rtcAvailable: true,
    pairing: { credentials: { seedB64: me.seedB64, peerKey: peerKeyOf(contact) }, pinPeer: async () => {}, trustOnFirstUse: true },
    native: { peerTransports: ["webrtc/1"], peerFallback: true, automatic: true },
    madeAt: Date.now() - 30 * 86_400_000, transport, pollIntervals: RELAY_POLL_INTERVALS, autoConnect: true,
    createPeerConnection: () => fakePeerConnection(owner),
    localFetch: vi.fn(), getServices: () => [{ id: "chat", type: "chat" }], getHostedHttpService: () => undefined,
  });
  links.push(link); link.start(); link.setChatActive(false);
  return link;
}

const nodes: GhostlyNode[] = [];
function engine(transport: PkarrTransport, options: Partial<NodeOptions> = {}): GhostlyNode {
  const node = new GhostlyNode({ onState: () => {}, onMessages: () => {}, onCallSignal: () => {} }, {
    transport, automaticWallets: false, nativeTransports: {}, singleDevice: true, staysOnline: true, watchPeerIdleMs: DAEMON_WATCH_PEER_IDLE_MS, ...options,
  });
  nodes.push(node);
  return node;
}
/** Runs fake time until `work` settles. */
async function settled<T>(work: Promise<T>): Promise<T> {
  let done = false;
  void work.finally(() => { done = true; }).catch(() => {});
  for (let i = 0; !done && i < 600; i++) await run(100);
  return work;
}

beforeEach(async () => {
  useFakeWorld();
  packets.clear();
  await transact([STORES.links, STORES.messages], (s) => { s[STORES.links].clear(); s[STORES.messages].clear(); });
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", class { constructor() { return fakePeerConnection("app"); } });
});
afterEach(async () => {
  await settled(Promise.all([...nodes.splice(0).map((node) => node.shutdown()), ...links.splice(0).map((link) => link.stop(false))]));
  await closeWorld();
  vi.unstubAllGlobals();
}, 120_000);

describe("a daemon restarted while its 50 contacts are online, one relay at the default budget", () => {
  it("brings its chats back steadily, never past the relay's budget, and a chat opened or written to goes first", async () => {
    // Paired and live once; the app then stops with a goodbye.
    const pairs = Array.from({ length: CHATS }, (_, i) => { const made = invitationWhere(i % 2 ? "inviter" : "joiner"); return { app: made.inviter, contact: made.joiner }; });
    const contacts = pairs.map((p, i) => side(p.contact, p.app, unlimited(), `contact-${i}`));
    const first = pairs.map((p) => side(p.app, p.contact, unlimited(), "app-before"));
    for (let t = 0; t < 2 * MIN && !first.every((l) => l.isDataLinkOpen); t += 500) await run(500);
    expect(first.filter((l) => l.isDataLinkOpen)).toHaveLength(CHATS);
    for (const link of first) link.depart();
    await run(300);
    await Promise.all(first.map((link) => link.stop(false)));
    const rows = pairs.map((p, i) => ({
      ...p.app.params, id: `chat-${i}`, label: `c${i}`, createdAt: p.app.createdAt, participationSeed: p.app.seedB64,
      pairedPeerKey: peerKeyOf(p.contact), peerTrust: { version: 1, verifiedKey: peerKeyOf(p.contact) }, peerTransports: ["webrtc/1"],
      transportHistory: [{ id: `h${i}`, at: Date.now() - MIN + i * 100, kind: "live", transport: "webrtc/1" }],
    }) as unknown as StoredLink);
    for (const row of rows) await db.putLink(row);
    const liveIn = (node: GhostlyNode, i: number) => !!node["links"].get(rows[i].id)?.link?.isDataLinkOpen && contacts[i].isDataLinkOpen;

    // The engine's last run, with no limit: every chat live, then a stop. Its states and records are saved.
    const before = engine(unlimited(), { resumesAtOnce: Infinity });
    await settled(before.start());
    for (let t = 0; t < 3 * MIN && rows.some((_, i) => !liveIn(before, i)); t += 500) await run(500);
    expect(rows.filter((_, i) => liveIn(before, i))).toHaveLength(CHATS);
    await run(30_000);
    await settled(before.shutdown());
    nodes.splice(nodes.indexOf(before), 1);
    await run(10_000);

    // Started again, on the default budget.
    const asked: number[] = [];
    const node = engine(new RelayTransport({ fetch: relay(asked), relays: [RELAY], log: () => {} }));
    const start = Date.now();
    await settled(node.start());
    const liveAt: (number | null)[] = rows.map(() => null);
    const look = () => rows.forEach((_, i) => { if (liveAt[i] === null && liveIn(node, i)) liveAt[i] = Date.now() - start; });
    // A few seconds in, the person opens one chat that is not live yet and writes in another: neither waits its turn.
    await run(3_000);
    look();
    const waiting = rows.map((_, i) => i).filter((i) => liveAt[i] === null);
    const opened = waiting.at(-1)!, written = waiting.at(-2)!;
    node.setActiveLink({ linkId: rows[opened].id });
    await node.sendMessage({ linkId: rows[written].id, text: "back?" });
    for (let t = 3_000; t < 5 * MIN; t += 500) { await run(500); look(); }

    const backBy = (ms: number) => liveAt.filter((at) => at !== null && at <= ms).length;
    const story = JSON.stringify([1, 2, 3, 4, 5].map((m) => backBy(m * MIN)));
    expect(liveAt[opened], "the chat opened").not.toBeNull();
    expect(liveAt[opened]!, "the chat opened").toBeLessThanOrEqual(150_000);
    expect(liveAt[written]!, "the chat written to").toBeLessThanOrEqual(150_000);
    // Both were last in line, and are back ahead of most of the chats waiting with them.
    const ahead = (i: number) => waiting.filter((j) => liveAt[j] !== null && liveAt[j]! < liveAt[i]!).length;
    expect(ahead(opened), "chats back before the one opened").toBeLessThan(waiting.length / 2);
    expect(ahead(written), "chats back before the one written to").toBeLessThan(waiting.length / 2);
    // Steadily: chats back in the first minute, and more in each minute after. Before: 0 in the first minute, 13 at
    // the end; now 5 in the first, 32 to 37 at the end.
    expect(backBy(MIN), story).toBeGreaterThanOrEqual(4);
    for (let m = 2; m <= 5; m++) expect(backBy(m * MIN) - backBy((m - 1) * MIN), story).toBeGreaterThanOrEqual(3);
    expect(backBy(5 * MIN), story).toBeGreaterThanOrEqual(30);
    // Never past the budget: the most requests in any 60 s on the relay, its limit and the chats' signaling allowance.
    let most = 0;
    for (let a = 0, b = 0; b < asked.length; b++) { while (asked[b] - asked[a] >= MIN) a++; most = Math.max(most, b - a + 1); }
    expect(most).toBeLessThanOrEqual(REQUESTS_PER_MINUTE * (1 + SIGNALING_ALLOWANCE_SHARE));
  }, 300_000);
});

describe("chats taking turns to resume", () => {
  it("starts so many at once in the order given; each one done starts the next; one wanted now starts at once", () => {
    const started: string[] = [];
    const turns = new ResumeTurns(2, (id) => { started.push(id); return id !== "gone"; });
    for (const id of ["a", "b", "c", "gone", "d", "e"]) turns.add(id);
    expect(started).toEqual(["a", "b"]);
    turns.finished("a");
    expect(started).toEqual(["a", "b", "c"]);
    // Opened while it waits: it starts now, past the two turns, and the line keeps its order.
    turns.now("e");
    expect(started).toEqual(["a", "b", "c", "e"]);
    // Three resume: one done leaves two, as many as the turns, and nothing starts yet.
    turns.finished("b");
    expect(started).toEqual(["a", "b", "c", "e"]);
    // A chat that does not start (removed meanwhile) takes no turn: the next one does.
    turns.finished("e");
    expect(started).toEqual(["a", "b", "c", "e", "gone", "d"]);
    // Done twice, or never started, frees nothing more; a cleared line starts nothing.
    turns.finished("b"); turns.finished("zzz");
    turns.add("f");
    turns.clear();
    turns.finished("c");
    expect(started).toEqual(["a", "b", "c", "e", "gone", "d"]);
  });
});
