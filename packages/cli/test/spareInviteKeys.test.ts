import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_WATCH_PEER_IDLE_MS, createIdentity, decodeInviteCode, identityFromSeedB64, type SignedPacket } from "@ghostly/core";
import { GhostlyNode, SPARE_INVITE_MIN_AGE_MS, STARTUP_QUIET_MS } from "@ghostly/browser/engine/node";
import { db } from "@ghostly/browser/engine/db";
import { STORES, transact } from "@ghostly/browser/shared/idb";
import type { StoredLink } from "@ghostly/browser/shared/types";
import { RelaysAndDht, type Mainline } from "../src/runtime/mainline";
// covers: headless.daemon, core.relay-client

/**
 * The engine keeps one spare invite warmed (an empty packet under each of its two keys) and replaces it with fresh keys
 * every 15 minutes while nobody takes it. The relays' side kept what it put under every one of those keys for good:
 * an idle daemon's `written` and `lastPut` grew by 8 keys an hour (343 and 690 after a simulated day), with nothing
 * happening. A spare replaced unused is forgotten now; one taken is a chat's and keeps its keys.
 *
 * An engine set up as the CLI's (`singleDevice`, `staysOnline`, `watchPeerIdleMs`) over `RelaysAndDht`, its saved
 * paired chats' contacts all away, two relays behind a `fetch` stub and a fake DHT node.
 */

const MIN = 60_000;
const RELAYS = ["https://relay-one.test", "https://relay-two.test"];

const chat = (i: number) => ({ id: `chat-${i}`, profile: "paired-chat/1", createdAt: 1, label: `c${i}`, seedB64: createIdentity().seedB64,
  encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64,
  pairedPeerKey: createIdentity().pubKeyZ32, peerTrust: { version: 1 } }) as StoredLink;

/** A DHT node that has nothing for anyone and takes every put. */
const fakeDht = () => ({
  get: async (): Promise<SignedPacket | null> => { await new Promise((r) => setTimeout(r, 1_500)); return null; },
  put: async () => { await new Promise((r) => setTimeout(r, 200)); return 8; },
  destroy: async () => {},
}) as unknown as Mainline;

/** Relays that take every packet and have none for anyone (404). */
const relayStub = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  await new Promise((r) => setTimeout(r, 50));
  return init?.method === "PUT" ? new Response(null, { status: 204 }) : new Response(null, { status: 404 });
}) as typeof fetch;

let node: GhostlyNode | undefined;
afterEach(async () => {
  // The engine stops on the fake clock: what it waits on to stop runs on it.
  const stopped = node?.shutdown(); node = undefined;
  if (stopped) { await vi.advanceTimersByTimeAsync(30_000); await stopped; }
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
}, 60_000);

async function daemon(contacts: number) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.stubGlobal("RTCPeerConnection", undefined);
  await transact([STORES.links, STORES.messages], (s) => { s[STORES.links].clear(); s[STORES.messages].clear(); });
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  const rows = Array.from({ length: contacts }, (_, i) => chat(i));
  for (const row of rows) await db.putLink(row);
  const transport = new RelaysAndDht(fakeDht(), { relays: RELAYS, fetch: relayStub, log: () => {} }, true);
  node = new GhostlyNode({ onState: () => {}, onMessages: () => {}, onCallSignal: () => {} }, {
    transport, automaticWallets: false, nativeTransports: {}, singleDevice: true, staysOnline: true, watchPeerIdleMs: DAEMON_WATCH_PEER_IDLE_MS,
  });
  await node.start();
  const maps = transport.relays as unknown as { written: Map<string, SignedPacket>; lastPut: Map<string, bigint>; lastTimestamp: Map<string, bigint> };
  const sizes = () => ({ written: maps.written.size, lastPut: maps.lastPut.size });
  const slots = (key: string) => [...maps.lastPut.keys()].filter((slot) => slot.endsWith(` ${key}`)).length;
  return { rows, node, maps, sizes, slots };
}

const ownKey = (row: StoredLink) => identityFromSeedB64(row.seedB64).pubKeyZ32;

describe("a CLI daemon's spare invites on the relays' side", { timeout: 180_000 }, () => {
  it("idle for 6 hours: written and lastPut stay flat after the first spare's cycle, the chats' keys kept", async () => {
    const { rows, maps, sizes } = await daemon(5);
    const at: Record<number, { written: number; lastPut: number }> = {};
    for (let m = 1; m <= 6 * 60; m++) {
      await vi.advanceTimersByTimeAsync(MIN);
      if (m % 60 === 0) at[m / 60] = sizes();
    }
    // Before: +8 keys an hour in `written` (2 per spare, 4 spares an hour), +16 in `lastPut` (2 relays).
    expect(at[6]!.written - at[1]!.written).toBeLessThanOrEqual(2);
    expect(at[6]!.lastPut - at[1]!.lastPut).toBeLessThanOrEqual(4);
    // What the chats put is kept.
    for (const row of rows) expect(maps.written.has(ownKey(row)), row.id).toBe(true);
  });

  it("a spare taken by a new chat keeps its keys across the next spares' cycles, and its chat goes on publishing", async () => {
    const { node, maps, sizes, slots } = await daemon(5);
    // The spare is warmed after the start's quiet time, and handed out once settled.
    await vi.advanceTimersByTimeAsync(STARTUP_QUIET_MS + SPARE_INVITE_MIN_AGE_MS + 1_000);
    const warmed = new Set(maps.written.keys());
    const { linkId, inviteCode } = await node.createLink();
    const link = (await db.getLinks()).find((l) => l.id === linkId)!;
    const mine = ownKey(link), contact = identityFromSeedB64(decodeInviteCode(inviteCode)!.seedB64).pubKeyZ32;
    expect([warmed.has(mine), warmed.has(contact)], "the chat is the warmed spare's").toEqual([true, true]);
    const first = maps.lastTimestamp.get(mine)!;
    // Two hours: eight spares replaced unused, the taken one's keys never among them.
    for (let m = 0; m < 120; m++) await vi.advanceTimersByTimeAsync(MIN);
    expect(maps.written.has(contact), "the contact's warm packet").toBe(true);
    expect(maps.written.has(mine)).toBe(true);
    expect(slots(mine)).toBe(RELAYS.length);
    expect(slots(contact)).toBe(RELAYS.length);
    // The chat put its own packet again since, dated past its first: its dates were kept.
    expect(maps.lastTimestamp.get(mine)! > first).toBe(true);
    expect(sizes().written).toBeLessThanOrEqual(warmed.size + 2);
  });
});
