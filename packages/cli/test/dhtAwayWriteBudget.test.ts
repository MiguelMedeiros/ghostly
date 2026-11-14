import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_WATCH_PEER_IDLE_MS, DiscoveryBudgetError, createIdentity, identityFromSeedB64, type SignedPacket } from "@ghostly/core";
import { GhostlyNode } from "@ghostly/browser/engine/node";
import { db } from "@ghostly/browser/engine/db";
import { STORES, transact } from "@ghostly/browser/shared/idb";
import type { StoredLink } from "@ghostly/browser/shared/types";
import { RelaysAndDht, type Mainline } from "../src/runtime/mainline";
// covers: headless.daemon, core.relay-client

/**
 * A daemon with the DHT put every chat's upkeep there at full pace however long its contacts were away: the link's
 * presence heartbeat and the mailbox keep-alive, each every 4 minutes, about 0.5 puts a minute per chat (~104 a minute
 * at 200 chats, flat for hours), where the relays' budget held most of the same packets. Background writes keep to the
 * relays' background share on the DHT now (20 a minute per relay, 40 with the two here), as background reads do; a
 * write someone waits on goes at once.
 *
 * An engine set up as the CLI's (`singleDevice`, `staysOnline`, `watchPeerIdleMs`), its saved paired chats' contacts
 * all away, two relays at the default budget behind a `fetch` stub, and a fake DHT node that counts its puts.
 */

const MIN = 60_000;
const RELAYS = ["https://relay-one.test", "https://relay-two.test"];
/** The relays' background share on these two relays (`BACKGROUND_REQUESTS_PER_MINUTE` x 2). */
const BOUND = 40;

const chat = (i: number) => ({ id: `chat-${i}`, profile: "paired-chat/1", createdAt: 1, label: `c${i}`, seedB64: createIdentity().seedB64,
  encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64,
  pairedPeerKey: createIdentity().pubKeyZ32, peerTrust: { version: 1 } }) as StoredLink;

/** A DHT node that has nothing for anyone; every put counted with its time and key. */
function fakeDht() {
  const puts: { at: number; key: string }[] = [];
  const dht = {
    get: async (): Promise<SignedPacket | null> => { await new Promise((r) => setTimeout(r, 1_500)); return null; },
    put: async (key: string) => { puts.push({ at: Date.now(), key }); await new Promise((r) => setTimeout(r, 200)); return 8; },
    destroy: async () => {},
  };
  return { dht: dht as unknown as Mainline, puts };
}

/** Relays that have no packet for anyone (404) and take every write (204). */
const relayStub = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  await new Promise((r) => setTimeout(r, 50));
  return init?.method === "PUT" ? new Response(null, { status: 204 }) : new Response(null, { status: 404 });
}) as typeof fetch;

let node: GhostlyNode | undefined;
afterEach(async () => {
  const stopped = node?.shutdown(); node = undefined;
  if (stopped) { await vi.advanceTimersByTimeAsync(30_000); await stopped; }
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
}, 60_000);

/** Per minute since `t0`, from minute `from` to `to` (excluded). */
const perMinute = (times: number[], t0: number, from: number, to: number) => {
  const counts = Array.from({ length: to - from }, () => 0);
  for (const at of times) { const m = Math.floor((at - t0) / MIN); if (m >= from && m < to) counts[m - from]++; }
  return counts;
};

describe("background DHT writes of a daemon whose contacts are away", { timeout: 180_000 }, () => {
  it("200 chats, every contact away for 40 minutes: at most the relays' background share a minute, each chat still put in its turn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.stubGlobal("RTCPeerConnection", undefined);
    await transact([STORES.links, STORES.messages], (s) => { s[STORES.links].clear(); s[STORES.messages].clear(); });
    await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
    const rows = Array.from({ length: 200 }, (_, i) => chat(i));
    for (const row of rows) await db.putLink(row);
    const { dht, puts } = fakeDht();
    const transport = new RelaysAndDht(dht, { relays: RELAYS, fetch: relayStub, log: () => {} }, true);
    node = new GhostlyNode({ onState: () => {}, onMessages: () => {}, onCallSignal: () => {} }, {
      transport, automaticWallets: false, nativeTransports: {}, singleDevice: true, staysOnline: true, watchPeerIdleMs: DAEMON_WATCH_PEER_IDLE_MS,
    });
    const t0 = Date.now();
    await node.start();
    for (let m = 0; m < 40; m++) await vi.advanceTimersByTimeAsync(MIN);
    // Past `PRESENCE_WINDOW` every contact counts as away: the upkeep is background.
    const counts = perMinute(puts.map((p) => p.at), t0, 15, 40);
    // Before: ~104 a minute (all 400 packets in one minute of every four). The profile's own packets, not background,
    // come on top: 2 every 4 minutes.
    expect(Math.max(...counts)).toBeLessThanOrEqual(BOUND + 2);
    // At the share, not starved: the minutes are used.
    expect(counts.reduce((a, b) => a + b, 0)).toBeGreaterThan(BOUND * 25 * 0.75);
    // Each key in its turn: none put at the old 4-minute pace (6 or more in 25 minutes), and every chat's heartbeat still
    // put in the last quarter hour.
    const late = new Map<string, number>();
    for (const p of puts) if (p.at - t0 >= 15 * MIN) late.set(p.key, (late.get(p.key) ?? 0) + 1);
    expect(Math.max(...late.values())).toBeLessThanOrEqual(4);
    expect(late.size).toBeGreaterThan(350);
    const lastQuarter = new Set(puts.filter((p) => p.at - t0 >= 25 * MIN).map((p) => p.key));
    expect(rows.filter((row) => !lastQuarter.has(identityFromSeedB64(row.seedB64).pubKeyZ32))).toEqual([]);
  });
});

describe("RelaysAndDht's background writes with the DHT", () => {
  it("past the share go to the relays alone, held as they say; a write someone waits on goes to the DHT at once", async () => {
    const answer = (async () => new Response(null, { status: 204 })) as typeof fetch;
    const put = vi.fn(async () => 8);
    const transport = new RelaysAndDht({ put } as unknown as Mainline, { relays: RELAYS, fetch: answer, log: () => {} });
    const ids = Array.from({ length: 60 }, () => createIdentity());
    // Asked first (`publishHeld`), then published: the share is taken once per write, not twice.
    for (const id of ids) {
      if (transport.publishHeld(id.pubKeyZ32, { background: true })) continue;
      await transport.publish(id, [{ label: "_x", value: "upkeep" }], { background: true }).catch(() => {});
    }
    expect(put).toHaveBeenCalledTimes(BOUND);
    // Published without asking first: the same share.
    const more = createIdentity();
    await transport.publish(more, [{ label: "_x", value: "upkeep" }], { background: true }).catch(() => {});
    expect(put).toHaveBeenCalledTimes(BOUND);
    // The relays' background share spent as well: held, as they say.
    expect(transport.publishHeld(ids[59]!.pubKeyZ32, { background: true })).toBeInstanceOf(DiscoveryBudgetError);
    // Writes someone waits on: on the DHT now, never held.
    for (const options of [{}, { background: true, signal: true }, { background: true, urgent: true }]) {
      expect(transport.publishHeld(ids[59]!.pubKeyZ32, options)).toBeNull();
      const n = put.mock.calls.length;
      await transport.publish(ids[59]!, [{ label: "_x", value: "now" }], options).catch(() => {});
      expect(put).toHaveBeenCalledTimes(n + 1);
    }
  });
});
