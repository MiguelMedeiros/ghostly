import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_WATCH_PEER_IDLE_MS, createIdentity, type SignedPacket } from "@ghostly/core";
import { GhostlyNode } from "@ghostly/browser/engine/node";
import { db } from "@ghostly/browser/engine/db";
import { STORES, transact } from "@ghostly/browser/shared/idb";
import type { StoredLink } from "@ghostly/browser/shared/types";
import { RelaysAndDht, type Mainline } from "../src/runtime/mainline";
// covers: headless.daemon, core.relay-client

/**
 * A daemon whose contacts were away asked the relays for each of them every few seconds: a background read the budget
 * held back came again when the budget freed its next request, which went to the key whose turn it was, and every other
 * held key asked again for nothing. With 200 contacts away, ~2,500 reads a minute were asked and held for ~30 that went
 * out, and the asking grew with uptime (4,500 a minute after 4 hours). A held read now comes again near its own turn.
 *
 * An engine set up as the CLI's (`singleDevice`, `staysOnline`, `watchPeerIdleMs`), its saved paired chats' contacts
 * all away, two relays at the default budget behind a `fetch` stub, and a fake DHT node.
 */

const MIN = 60_000;
const RELAYS = ["https://relay-one.test", "https://relay-two.test"];
const CHATS = 100;

const chat = (i: number) => ({ id: `chat-${i}`, profile: "paired-chat/1", createdAt: 1, label: `c${i}`, seedB64: createIdentity().seedB64,
  encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64,
  pairedPeerKey: createIdentity().pubKeyZ32, peerTrust: { version: 1 } }) as StoredLink;

let node: GhostlyNode | undefined;
afterEach(async () => {
  const stopped = node?.shutdown(); node = undefined;
  if (stopped) { await vi.advanceTimersByTimeAsync(30_000); await stopped; }
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
}, 60_000);

describe("held background reads of a daemon whose contacts are away", { timeout: 180_000 }, () => {
  it("100 chats, every contact away for 2 hours: the reads asked stay at the polls' pace, not growing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.stubGlobal("RTCPeerConnection", undefined);
    await transact([STORES.links, STORES.messages], (s) => { s[STORES.links].clear(); s[STORES.messages].clear(); });
    await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
    for (let i = 0; i < CHATS; i++) await db.putLink(chat(i));
    const gets: number[] = [];
    const relayStub = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise((r) => setTimeout(r, 50));
      if (init?.method === "PUT") return new Response(null, { status: 204 });
      gets.push(Date.now());
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const dht = {
      get: async (): Promise<SignedPacket | null> => { await new Promise((r) => setTimeout(r, 1_500)); return null; },
      put: async () => { await new Promise((r) => setTimeout(r, 200)); return 8; },
      destroy: async () => {},
    } as unknown as Mainline;
    const transport = new RelaysAndDht(dht, { relays: RELAYS, fetch: relayStub, log: () => {} }, true);
    const asked: number[] = [];
    const resolve = transport.relays.resolve.bind(transport.relays);
    transport.relays.resolve = (...args) => { asked.push(Date.now()); return resolve(...args); };
    node = new GhostlyNode({ onState: () => {}, onMessages: () => {}, onCallSignal: () => {} }, {
      transport, automaticWallets: false, nativeTransports: {}, singleDevice: true, staysOnline: true, watchPeerIdleMs: DAEMON_WATCH_PEER_IDLE_MS,
    });
    const t0 = Date.now();
    await node.start();
    for (let m = 0; m < 120; m++) await vi.advanceTimersByTimeAsync(MIN);
    const perMinute = (times: number[], from: number, to: number) => times.filter((at) => at >= t0 + from * MIN && at < t0 + to * MIN).length / (to - from);
    const early = perMinute(asked, 15, 45), late = perMinute(asked, 90, 120);
    // Each chat's link and its mailbox read their contact, and one held far down the turns asks again every 15 s at most
    // (`BACKGROUND_TURN_MAX_MS`): about 8 a minute per contact, as many in the second hour as in the first. Before: ~21 a
    // minute per contact in the second hour, and growing.
    expect(late).toBeLessThan(CHATS * 10);
    expect(late).toBeLessThan(early * 1.2);
    // As many reads go out as before: the budget's background share is still used.
    expect(perMinute(gets, 90, 120)).toBeGreaterThan(25);
  });
});
