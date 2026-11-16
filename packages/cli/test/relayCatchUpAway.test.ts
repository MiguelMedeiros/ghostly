import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_WATCH_PEER_IDLE_MS, createIdentity, identityFromSeedB64, type SignedPacket } from "@ghostly/core";
import { GhostlyNode } from "@ghostly/browser/engine/node";
import { db } from "@ghostly/browser/engine/db";
import { STORES, transact } from "@ghostly/browser/shared/idb";
import type { StoredLink } from "@ghostly/browser/shared/types";
import { RelaysAndDht, type Mainline } from "../src/runtime/mainline";
// covers: headless.daemon, core.relay-client

/**
 * A daemon whose 50 contacts were away wrote 15 of its 50 chats' packets to the relays in 40 minutes: the DHT took the
 * rest, and the relays' copies waited (`catchUpLater`) behind the background reads, which took every request the budget
 * freed, and behind the chats' own upkeep tried again. The web app and the extension read only the relays: a contact
 * back there found the daemon's packet from before its restart, or none.
 *
 * An engine set up as the CLI's (`singleDevice`, `staysOnline`, `watchPeerIdleMs`), its saved paired chats' contacts
 * all away, two relays at the default budget behind a `fetch` stub, and a fake DHT node.
 */

const MIN = 60_000;
const RELAYS = ["https://relay-one.test", "https://relay-two.test"];

const chat = (i: number) => ({ id: `chat-${i}`, profile: "paired-chat/1", createdAt: 1, label: `c${i}`, seedB64: createIdentity().seedB64,
  encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64,
  pairedPeerKey: createIdentity().pubKeyZ32, peerTrust: { version: 1 } }) as StoredLink;

let node: GhostlyNode | undefined;
afterEach(async () => {
  const stopped = node?.shutdown(); node = undefined;
  if (stopped) { await vi.advanceTimersByTimeAsync(30_000); await stopped; }
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
}, 60_000);

describe("relay copies of a daemon whose contacts are away", { timeout: 180_000 }, () => {
  it("50 chats, every contact away: each chat's packet is on both relays within 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.stubGlobal("RTCPeerConnection", undefined);
    await transact([STORES.links, STORES.messages], (s) => { s[STORES.links].clear(); s[STORES.messages].clear(); });
    await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
    const rows = Array.from({ length: 50 }, (_, i) => chat(i));
    for (const row of rows) await db.putLink(row);
    // Per relay, the keys it took a packet of.
    const stored = new Map(RELAYS.map((relay) => [relay, new Set<string>()]));
    const relayStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      await new Promise((r) => setTimeout(r, 50));
      if (init?.method !== "PUT") return new Response(null, { status: 404 });
      stored.get(url.origin)!.add(url.pathname.slice(1));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const dht = {
      get: async (): Promise<SignedPacket | null> => { await new Promise((r) => setTimeout(r, 1_500)); return null; },
      put: async () => { await new Promise((r) => setTimeout(r, 200)); return 8; },
      destroy: async () => {},
    } as unknown as Mainline;
    const transport = new RelaysAndDht(dht, { relays: RELAYS, fetch: relayStub, log: () => {} }, true);
    node = new GhostlyNode({ onState: () => {}, onMessages: () => {}, onCallSignal: () => {} }, {
      transport, automaticWallets: false, nativeTransports: {}, singleDevice: true, staysOnline: true, watchPeerIdleMs: DAEMON_WATCH_PEER_IDLE_MS,
    });
    await node.start();
    for (let m = 0; m < 10; m++) await vi.advanceTimersByTimeAsync(MIN);
    // Before: 15 of the 50 on both, and no more after 40 minutes.
    const linkKeys = rows.map((row) => identityFromSeedB64(row.seedB64).pubKeyZ32);
    for (const relay of RELAYS) expect(linkKeys.filter((key) => !stored.get(relay)!.has(key))).toEqual([]);
  });
});
