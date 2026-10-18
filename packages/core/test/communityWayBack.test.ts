import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostLink } from "../src/ghostlink";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { RELAY_POLL_INTERVALS } from "../src/link";
import { RelayTransport } from "../src/relay";
import { withRequestOptions, type PkarrRequestOptions, type PkarrTransport } from "../src/transport";
import { closeWorld, fakePeerConnection, invitationWhere, run, useFakeWorld, type Side } from "./support/pairingWorld";

// covers: core.relay-client, groups.protocol.community-topology

/**
 * The web app opened with 30 chats whose contacts are online, 20 whose contacts are long gone, 15 groups and 5
 * communities (bug hunt, 2026-10-13). The chats take the first minute (`CHAT_RESERVE`), and from then on the looks of
 * the chats whose contacts are gone, each asked again the moment the budget frees, take every request: a community's
 * looks, background requests asked again 5 s after a refusal, never got one. Its reads of the beacon (who the hubs are)
 * never went out in 3 minutes, nor its request in a hub's lobby, and none of its communities came back. Asked as a group
 * edge's signaling, they waited behind the edges of its other groups, all offering at once, which spent the groups'
 * allowance in the first second: the beacons were read a minute later (bug hunt, 2026-10-14). A member with no edge up
 * asks its way back within its own allowance (`back`, `WAY_BACK_SHARE`).
 */

const ONLINE = 30, GONE = 20, GROUPS = 15, EDGES = 10, COMMUNITIES = 5;
const peerKeyOf = (side: Side) => identityFromSeedB64(side.seedB64).pubKeyZ32;

/** Both default relays, one packet store (the e2e suite's LocalRelay), answering in 20 ms; the GETs of each key. */
function relays(gets: Map<string, number[]>) {
  const packets = new Map<string, Uint8Array>();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = new URL(String(input)).pathname.slice(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (init?.method === "PUT") { packets.set(key, new Uint8Array(init.body as ArrayBuffer)); return new Response(null, { status: 204 }); }
    gets.set(key, [...(gets.get(key) ?? []), Date.now()]);
    const body = packets.get(key);
    return body ? new Response(body as BodyInit, { status: 200 }) : new Response(null, { status: 404 });
  }) as typeof fetch;
}

function chat(side: Side, contact: Side, transport: PkarrTransport, name: string, resume: boolean): GhostLink {
  const link = new GhostLink({
    params: side.params,
    rtcAvailable: true,
    pairing: { credentials: { seedB64: side.seedB64, peerKey: peerKeyOf(contact) }, pinPeer: async () => {}, trustOnFirstUse: true },
    native: { peerTransports: ["webrtc/1"], peerFallback: true, automatic: true },
    ...(resume ? { resume: "webrtc/1" as const } : {}),
    madeAt: Date.now() - 30 * 86_400_000,
    transport,
    pollIntervals: RELAY_POLL_INTERVALS,
    autoConnect: true,
    createPeerConnection: () => fakePeerConnection(name),
    localFetch: vi.fn(), getServices: () => [{ id: "chat", type: "chat" }], getHostedHttpService: () => undefined,
  });
  links.push(link);
  link.start();
  link.setChatActive(false);
  return link;
}

const links: GhostLink[] = [];
beforeEach(() => useFakeWorld());
afterEach(async () => {
  let stopped = false;
  const stopping = Promise.all(links.splice(0).map((link) => link.stop(false))).finally(() => { stopped = true; });
  for (let i = 0; !stopped && i < 300; i++) await run(100);
  await stopping;
  await closeWorld();
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a community member back while 30 chats start", () => {
  it.each([
    ["as background looks: never", { background: true }, { background: true, door: true }],
    ["as an edge's signaling: behind the edges", { signal: true }, { signal: true }],
    ["as its way back: within its own allowance", { back: true }, { back: true }],
  ] as [string, PkarrRequestOptions, PkarrRequestOptions][])("reads the beacon and asks a hub's lobby %s", async (how, beaconRead, lobbyAsk) => {
    const gets = new Map<string, number[]>();
    const fetch = relays(gets);
    const pairs = Array.from({ length: ONLINE }, (_, i) => {
      const made = invitationWhere(i % 2 ? "inviter" : "joiner");
      return { app: made.inviter, contact: made.joiner };
    });
    const contacts = pairs.map((p, i) => chat(p.contact, p.app, new RelayTransport({ fetch, log: () => {} }), `c${i}`, false));
    const before = pairs.map((p, i) => chat(p.app, p.contact, new RelayTransport({ fetch, requestsPerMinute: Infinity, log: () => {} }), `a${i}`, false));
    for (let t = 0; t < 120_000 && !before.every((l) => l.isDataLinkOpen); t += 500) await run(500);
    for (const link of before) link.depart();
    await run(300);
    await Promise.all(before.map((link) => link.stop(false)));
    await run(3 * 60_000);

    // The app opens again: its chats, those whose contacts are long gone, its groups' records, and its communities.
    const transport = new RelayTransport({ fetch, log: () => {} });
    const start = Date.now();
    const app = pairs.map((p, i) => chat(p.app, p.contact, transport, `a${i}`, true));
    for (let i = 0; i < GONE; i++) {
      const made = invitationWhere(i % 2 ? "inviter" : "joiner");
      chat(made.inviter, made.joiner, transport, `g${i}`, false);
    }
    const group = withRequestOptions(transport, { group: true });
    let on = true;
    for (const g of Array.from({ length: GROUPS }, () => createIdentity())) {
      void group.resolve(g.pubKeyZ32).catch(() => {});
      void (async () => { while (on) { try { await group.publish(g, []); return; } catch { await wait(4_000); } } })();
    }
    // The edges of the last run: each offers every 10 s and looks for its member every 2 s, as resumed edges do.
    for (const edge of Array.from({ length: EDGES }, () => createIdentity())) {
      const member = createIdentity().pubKeyZ32;
      void (async () => { while (on) { await group.publish(edge, [], { signal: true }).catch(() => {}); await wait(10_000); } })();
      void (async () => { while (on) { await group.resolve(member, { watch: true, urgent: true }).catch(() => {}); await wait(2_000); } })();
    }
    // Each community: its first reading of the beacon, then its request in the hub's lobby (a read, then a write), each
    // asked again 5 s after a refusal (`BEACON_RETRY_MS`), as the engine does.
    const beacons = Array.from({ length: COMMUNITIES }, () => createIdentity().pubKeyZ32);
    const lobbies = beacons.map(() => createIdentity());
    const read: (number | null)[] = beacons.map(() => null), asked: (number | null)[] = beacons.map(() => null);
    beacons.forEach((key, i) => void (async () => {
      while (on && read[i] === null) { try { await group.resolve(key, beaconRead); read[i] = Date.now() - start; } catch { await wait(5_000); } }
      while (on && asked[i] === null) {
        try { await group.resolve(lobbies[i].pubKeyZ32, lobbyAsk); await group.publish(lobbies[i], [], lobbyAsk); asked[i] = Date.now() - start; } catch { await wait(5_000); }
      }
    })());

    const liveAt: (number | null)[] = app.map(() => null);
    for (let t = 0; t < 3 * 60_000; t += 500) {
      await run(500);
      app.forEach((link, i) => { if (liveAt[i] === null && link.isDataLinkOpen && contacts[i].isDataLinkOpen) liveAt[i] = Date.now() - start; });
    }
    on = false;
    // The chats come first either way: nearly all of them by 3 s, as in `startOnlineContacts.test.ts` (the edges' offers
    // take a request or two from the last).
    expect(liveAt.filter((at) => at !== null && at <= 10_000).length, JSON.stringify(liveAt)).toBeGreaterThanOrEqual(ONLINE - 2);
    const result = JSON.stringify({ read, asked, beaconGets: beacons.map((key) => gets.get(key)?.length ?? 0) });
    if (how.startsWith("as background")) {
      // Before: no reading of any beacon in 3 minutes, and so no request in any lobby.
      expect(read.filter((at) => at !== null && at <= 60_000), result).toHaveLength(0);
      expect(asked.filter((at) => at !== null), result).toHaveLength(0);
    } else if (how.startsWith("as an edge's")) {
      // Before: the edges took the groups' allowance, and no lobby was asked before the minute freed. A beacon may be
      // read early: a chat's offer goes to one relay while the chats need the relays, which can leave the other a request.
      expect(asked.filter((at) => at !== null && at <= 30_000), result).toHaveLength(0);
    } else {
      // Every beacon read, and every lobby asked, within seconds.
      expect(read.filter((at) => at !== null && at <= 5_000), result).toHaveLength(COMMUNITIES);
      expect(asked.filter((at) => at !== null && at <= 10_000), result).toHaveLength(COMMUNITIES);
    }
  }, 300_000);
});
