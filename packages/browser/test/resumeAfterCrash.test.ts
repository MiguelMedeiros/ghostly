import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAEMON_WATCH_PEER_IDLE_MS, GhostLink, RELAY_POLL_INTERVALS, REQUESTS_PER_MINUTE, RelayTransport, SIGNALING_ALLOWANCE_SHARE, identityFromSeedB64, type PkarrTransport } from "@ghostly/core";
import { GhostlyNode, type NodeOptions } from "../src/engine/node";
import { db } from "../src/engine/db";
import { DEPARTED_KEY, STORES, store, transact, wrap } from "../src/shared/idb";
import type { StoredLink } from "../src/shared/types";
import { closeWorld, fakePeerConnection, invitationWhere, killRtc, run, useFakeWorld, type Side } from "../../core/test/support/pairingWorld";

// covers: chat.paired.reconnect, core.relay-client, headless.daemon

/**
 * A daemon with 14 chats, all live, killed (`kill -9`, an OOM kill, a power cut) and started again at once, its
 * contacts all online (bug hunt, 2026-11-25). Each contact still holds the dead session, and finds it gone only when
 * its connection fails, seconds on: until then it neither answers the daemon's resume offer nor makes one. The daemon's
 * resuming chats each read for the answer every 2 s meanwhile, spent the relay's minute before the answers were out,
 * and read them only the next minute: 3 or 4 of 14 chats were live in 20 s, the rest at 61 to 74 s. After a stop with
 * a goodbye, every chat was live in seconds: the contacts watch for the app then, and answer at once.
 *
 * An engine set up as the CLI's (`singleDevice`, `staysOnline`, `watchPeerIdleMs`, WebRTC and no native transport),
 * two relays at the default budget behind a `fetch` stub, and 14 contacts with no limit (each has a budget of its own).
 */

const CHATS = 14;
const RELAYS = ["https://relay-one.test", "https://relay-two.test"];
const MIN = 60_000;
/** How long after the crash each contact's connection fails: node-datachannel's, which says no `disconnected`. */
const NOTICED_AFTER_MS = 12_000;
const peerKeyOf = (side: Side) => identityFromSeedB64(side.seedB64).pubKeyZ32;

const packets = new Map<string, Uint8Array>();
/** The relays, one store for everyone; `asked` and `hosts`: when each request reached which; `cut()`: this caller is gone. */
function relay(asked?: number[], cut?: () => boolean, hosts?: string[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (cut?.()) throw new TypeError("fetch failed");
    const key = new URL(String(input)).pathname.slice(1);
    asked?.push(Date.now());
    hosts?.push(new URL(String(input)).host);
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (init?.method === "PUT") { packets.set(key, new Uint8Array(init.body as ArrayBuffer)); return new Response(null, { status: 204 }); }
    const body = packets.get(key);
    return body ? new Response(body as BodyInit, { status: 200 }) : new Response(null, { status: 404 });
  }) as typeof fetch;
}
const unlimited = (cut?: () => boolean) => new RelayTransport({ fetch: relay(undefined, cut), relays: RELAYS, requestsPerMinute: Infinity, log: () => {} });

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

/**
 * 14 chats paired and live in the engine's last run (no limit), which then ends: killed (`crashed`: no goodbye, nothing
 * more reaches the relays, and each contact sees its connection fail `NOTICED_AFTER_MS` on), or stopped with a goodbye.
 * The engine starts again at once on the default budget: when each chat is live again, and every request on each relay.
 */
async function restarted(crashed: boolean) {
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

  // The engine's last run, with no limit: every chat live a while.
  let cut = false;
  const before = engine(unlimited(() => cut), { resumesAtOnce: Infinity });
  await settled(before.start());
  for (let t = 0; t < 3 * MIN && rows.some((_, i) => !liveIn(before, i)); t += 500) await run(500);
  expect(rows.filter((_, i) => liveIn(before, i))).toHaveLength(CHATS);
  await run(30_000);
  if (crashed) {
    cut = true;
    killRtc("app", 0, NOTICED_AFTER_MS);
  }
  await settled(before.shutdown({ quiet: crashed }));
  nodes.splice(nodes.indexOf(before), 1);

  // Started again at once, on the default budget.
  const asked: number[] = [], hosts: string[] = [];
  const node = engine(new RelayTransport({ fetch: relay(asked, undefined, hosts), relays: RELAYS, log: () => {} }));
  const start = Date.now();
  await settled(node.start());
  const liveAt: (number | null)[] = rows.map(() => null);
  for (let t = 0; t < 2 * MIN; t += 500) {
    await run(500);
    rows.forEach((_, i) => { if (liveAt[i] === null && liveIn(node, i)) liveAt[i] = Date.now() - start; });
  }
  // The most requests in any 60 s on each relay.
  const most = RELAYS.map((relay) => {
    const at = asked.filter((_, i) => hosts[i] === new URL(relay).host);
    let top = 0;
    for (let a = 0, b = 0; b < at.length; b++) { while (at[b] - at[a] >= MIN) a++; top = Math.max(top, b - a + 1); }
    return top;
  });
  return { backBy: (ms: number) => liveAt.filter((at) => at !== null && at <= ms).length, story: JSON.stringify(liveAt), most };
}

describe("the mark a goodbye leaves for the next start", () => {
  const mark = async () => wrap((await store(STORES.settings, "readonly")).get(DEPARTED_KEY));
  const lastRunDeparted = (node: GhostlyNode) => node["lastRunDeparted"] as boolean;

  it("is left by a stop that says goodbye, not by one that says nothing, and each start reads it and takes it away", async () => {
    // A profile's first start: no run before it said goodbye.
    const first = engine(unlimited());
    await settled(first.start());
    expect(lastRunDeparted(first)).toBe(false);
    await settled(first.shutdown());
    expect(await mark(), "left by the goodbye").toBeDefined();

    const second = engine(unlimited());
    await settled(second.start());
    expect(lastRunDeparted(second)).toBe(true);
    expect(await mark(), "taken by the start: a crash of this run is no goodbye").toBeUndefined();
    // A stop that says nothing (a device another replaced) leaves none, as a crash does.
    await settled(second.shutdown({ quiet: true }));
    expect(await mark()).toBeUndefined();

    const third = engine(unlimited());
    await settled(third.start());
    expect(lastRunDeparted(third)).toBe(false);
  }, 60_000);
});

describe("a daemon whose 14 chats are live, started again at once, two relays at the default budget", () => {
  it("killed: has most chats live again soon after its contacts find the old sessions gone, and never passes the budget", async () => {
    const { backBy, story, most } = await restarted(true);
    // The contacts can answer from 12 s on. Before: none live in the first minute, all 14 at 62 to 64 s, the answers
    // read only once the minute spent on 2 s looks freed. Now 11 to 14 within 30 s, as those looks share the relays'
    // minute (`OFFER_LOOKS_PER_MINUTE`). A chat that waits its turn may find the minute spent by the others' starts.
    expect(backBy(45_000), story).toBeGreaterThanOrEqual(10);
    expect(backBy(80_000), story).toBe(CHATS);
    // Never past the budget: each relay's limit and the chats' signaling allowance.
    for (const top of most) expect(top).toBeLessThanOrEqual(REQUESTS_PER_MINUTE * (1 + SIGNALING_ALLOWANCE_SHARE));
  }, 300_000);

  it("stopped with a goodbye: has every chat live again in seconds, its looks for answers at the fast pace", async () => {
    const { backBy, story } = await restarted(false);
    // The contacts heard the goodbye and watch for this app: their answers come in a second or two. Shared as after a
    // crash, 11 of 14 were live in a minute.
    expect(backBy(15_000), story).toBe(CHATS);
  }, 300_000);
});
