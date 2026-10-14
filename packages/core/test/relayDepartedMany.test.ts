import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostLink } from "../src/ghostlink";
import { identityFromSeedB64 } from "../src/identity";
import { RELAY_POLL_INTERVALS } from "../src/link";
import { RelayTransport } from "../src/relay";
import type { PkarrTransport } from "../src/transport";
import { closeWorld, fakePeerConnection, invitationWhere, run, useFakeWorld, type Side } from "./support/pairingWorld";

// covers: core.relay-client, chat.paired.reconnect

/**
 * Several contacts leave a CLI daemon at once and come back (CLI bug hunt, 2026-10-14): 10 contacts said goodbye
 * together and started again 20 s later. The daemon read each one that left fast, on the reads that go past the
 * relays' minute, and spent both relays' minute in the 10 s after the goodbyes, when none could be back yet; then it
 * read nobody for 45 s. A chat with no HyperDHT listener at the daemon was live again only 42 to 51 s after its contact
 * was back, against 2.7 s for one contact alone.
 */

const CHATS = 10;
const peerKeyOf = (side: Side) => identityFromSeedB64(side.seedB64).pubKeyZ32;

/** Two loopback relays, one packet store, answering in 20 ms. */
function relays() {
  const packets = new Map<string, Uint8Array>();
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = new URL(String(input)).pathname.slice(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (init?.method === "PUT") { packets.set(key, new Uint8Array(init.body as ArrayBuffer)); return new Response(null, { status: 204 }); }
    const body = packets.get(key);
    return body ? new Response(body as BodyInit, { status: 200 }) : new Response(null, { status: 404 });
  }) as typeof fetch;
}

const links: GhostLink[] = [];
/** A saved chat as the engine starts it (node.ts `startLink`); `resume`: it was live when the app last ran. */
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

beforeEach(() => useFakeWorld());
afterEach(async () => {
  let stopped = false;
  const stopping = Promise.all(links.splice(0).map((link) => link.stop(false))).finally(() => { stopped = true; });
  for (let i = 0; !stopped && i < 300; i++) await run(100);
  await stopping;
  await closeWorld();
});

describe("a daemon whose contacts all leave at once and come back", () => {
  it("has every chat live again within seconds of its contact being back", async () => {
    const fetch = relays();
    const pairs = Array.from({ length: CHATS }, (_, i) => {
      const made = invitationWhere(i % 2 ? "inviter" : "joiner");
      return { hub: made.inviter, contact: made.joiner };
    });
    // The daemon: one transport on the relays' budget for all its chats.
    const transport = new RelayTransport({ fetch, log: () => {} });
    const hub = pairs.map((p, i) => chat(p.hub, p.contact, transport, `h${i}`, false));
    let contacts = pairs.map((p, i) => chat(p.contact, p.hub, new RelayTransport({ fetch, log: () => {} }), `c${i}`, false));
    for (let t = 0; t < 180_000 && !hub.every((l) => l.isDataLinkOpen); t += 500) await run(500);
    expect(hub.filter((l) => l.isDataLinkOpen), "live before the contacts leave").toHaveLength(CHATS);
    // Three quiet minutes.
    await run(3 * 60_000);

    // All the contacts say goodbye and stop together; 20 s later they start again.
    for (const link of contacts) link.depart();
    await run(300);
    await Promise.all(contacts.map((link) => link.stop(false)));
    links.splice(0, links.length, ...hub);
    await run(20_000);
    const start = Date.now();
    contacts = pairs.map((p, i) => chat(p.contact, p.hub, new RelayTransport({ fetch, log: () => {} }), `c${i}`, true));

    const liveAt: (number | null)[] = hub.map(() => null);
    for (let t = 0; t < 60_000; t += 500) {
      await run(500);
      hub.forEach((link, i) => { if (liveAt[i] === null && link.isDataLinkOpen && contacts[i].isDataLinkOpen) liveAt[i] = Date.now() - start; });
    }
    // Before: the daemon read nobody from 10 s after the goodbyes until the minute freed, and 9 of the 10 chats were live
    // 43 to 45 s after their contacts were back. After: most within 5 s, the others in the chats' next share of reads.
    expect(liveAt.filter((at) => at !== null && at <= 20_000), JSON.stringify(liveAt)).toHaveLength(CHATS);
    expect(liveAt.filter((at) => at !== null && at <= 5_000).length, JSON.stringify(liveAt)).toBeGreaterThanOrEqual(CHATS / 2);
  }, 300_000);
});
