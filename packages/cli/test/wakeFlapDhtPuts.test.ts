import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_WATCH_PEER_IDLE_MS, createIdentity } from "@ghostly/core";
import { GhostlyNode } from "@ghostly/browser/engine/node";
import { db } from "@ghostly/browser/engine/db";
import { STORES, transact } from "@ghostly/browser/shared/idb";
import type { StoredLink } from "@ghostly/browser/shared/types";
import { RelaysAndDht, type Mainline } from "../src/runtime/mainline";
import { watchWake } from "../src/runtime/wakeWatch";
// covers: headless.daemon

/**
 * Every wake republishes each chat with no session that did not publish in the last seconds, and on the CLI the DHT copy
 * of a republish goes whatever the relays' budgets say. A network that flapped every tick of the wake watch woke the
 * engine every 10 s: at 200 chats away, 12,406 DHT puts in 10 minutes against 1,006 with no wake, every packet already on
 * the DHT seconds earlier.
 *
 * An engine set up as the CLI's (clockBackBudget.test.ts), 200 saved paired chats with their contacts away, two relays
 * answering nothing, a DHT that counts its puts, and the real watch wired as `startRuntime` wires it.
 */

const MIN = 60_000;
const RELAYS = ["https://relay-one.test", "https://relay-two.test"];

const chat = (i: number) => ({ id: `chat-${i}`, profile: "paired-chat/1", createdAt: 1, label: `c${i}`, seedB64: createIdentity().seedB64,
  encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64,
  pairedPeerKey: createIdentity().pubKeyZ32, peerTrust: { version: 1 } }) as StoredLink;

let puts = 0;
const dht = {
  get: async () => { await new Promise((r) => setTimeout(r, 1_500)); return null; },
  put: async () => { puts++; await new Promise((r) => setTimeout(r, 200)); return 8; },
  destroy: async () => {},
} as unknown as Mainline;

let node: GhostlyNode | undefined;
let stopWake: (() => void) | undefined;
afterEach(async () => {
  stopWake?.(); stopWake = undefined;
  const stopped = node?.shutdown(); node = undefined;
  if (stopped) { await vi.advanceTimersByTimeAsync(30_000); await stopped; }
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
}, 60_000);

async function daemon(contacts: number) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.stubGlobal("RTCPeerConnection", undefined);
  await transact([STORES.links, STORES.messages], (s) => { s[STORES.links].clear(); s[STORES.messages].clear(); });
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  for (let i = 0; i < contacts; i++) await db.putLink(chat(i));
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    await new Promise((r) => setTimeout(r, 50));
    return init?.method === "PUT" ? new Response(null, { status: 204 }) : new Response(null, { status: 404 });
  }) as typeof fetch;
  const transport = new RelaysAndDht(dht, { relays: RELAYS, fetch: fetchFn, log: () => {} }, true);
  node = new GhostlyNode({ onState: () => {}, onMessages: () => {}, onCallSignal: () => {} }, {
    transport, automaticWallets: false, nativeTransports: {}, singleDevice: true, staysOnline: true, watchPeerIdleMs: DAEMON_WATCH_PEER_IDLE_MS,
  });
  await node.start();
  return node;
}

describe("a daemon on a network that flaps every tick of the wake watch", { timeout: 300_000 }, () => {
  it("200 chats away: DHT puts over 10 minutes stay within twice the no-wake count", async () => {
    const engine = await daemon(200);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    let flip = 0, wakes = 0;
    const flapping = () => (flip++ % 2 ? "en0/10.0.0.2" : "en0/10.0.0.3");
    stopWake = watchWake(() => { wakes++; engine.wake({ network: true }); }, { addresses: flapping });
    const from = puts;
    await vi.advanceTimersByTimeAsync(10 * MIN);
    // Before: 60 wakes and 12,406 puts (1,006 with no wake at all), the same every run. Now 4 wakes and 1,806 puts.
    expect(wakes).toBeGreaterThan(0);
    expect(puts - from).toBeLessThanOrEqual(2 * 1_006);
  });
});
