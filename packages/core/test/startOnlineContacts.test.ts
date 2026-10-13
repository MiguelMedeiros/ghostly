import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostLink } from "../src/ghostlink";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { RELAY_POLL_INTERVALS } from "../src/link";
import { RelayTransport } from "../src/relay";
import { isDiscoveryBudgetError, withRequestOptions, type PkarrTransport } from "../src/transport";
import { closeWorld, fakePeerConnection, invitationWhere, run, useFakeWorld, type Side } from "./support/pairingWorld";

// covers: core.relay-client, chat.paired.reconnect

/**
 * The web app opened while its contacts are online (bug hunt, 2026-10-13): 50 chats, 30 of whose contacts are online,
 * and 20 groups, on the default relays' budget. Every link read and wrote at once as the app started, and the minute was
 * spent in its first second: on every chat's first read, the presence of the chats whose contacts were long gone and the
 * groups' records. The offers and answers that did not fit, and every read for an answer, waited for the minute to free:
 * 0 of 30 chats were live 60 s after the start. The engine starts the chats live most recently first (`nativeStartOrder`).
 */

const ONLINE = 30, GONE = 20, GROUPS = 20;
const peerKeyOf = (side: Side) => identityFromSeedB64(side.seedB64).pubKeyZ32;

/** Both default relays, one packet store (the e2e suite's LocalRelay), answering in 20 ms. */
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

const links: GhostLink[] = [];
beforeEach(() => useFakeWorld());
afterEach(async () => {
  let stopped = false;
  const stopping = Promise.all(links.splice(0).map((link) => link.stop(false))).finally(() => { stopped = true; });
  for (let i = 0; !stopped && i < 300; i++) await run(100);
  await stopping;
  await closeWorld();
});

describe("the app opened while its contacts are online", () => {
  it("brings every chat whose contact is online back within seconds, ahead of the chats whose contacts are gone and of its groups", async () => {
    const fetch = relays();
    // Half of the chats are dialled by the app (the lower key), half by the contact.
    const pairs = Array.from({ length: ONLINE }, (_, i) => {
      const made = invitationWhere(i % 2 ? "inviter" : "joiner");
      return { app: made.inviter, contact: made.joiner };
    });
    // The contacts: daemons with a budget each, live with the app once.
    const contacts = pairs.map((p, i) => chat(p.contact, p.app, new RelayTransport({ fetch, log: () => {} }), `c${i}`, false));
    const before = pairs.map((p, i) => chat(p.app, p.contact, new RelayTransport({ fetch, requestsPerMinute: Infinity, log: () => {} }), `a${i}`, false));
    for (let t = 0; t < 120_000 && !before.every((l) => l.isDataLinkOpen); t += 500) await run(500);
    expect(before.filter((l) => l.isDataLinkOpen), "live before the app closes").toHaveLength(ONLINE);
    // The app closes; its contacts stay up, and look for it.
    for (const link of before) link.depart();
    await run(300);
    await Promise.all(before.map((link) => link.stop(false)));
    await run(3 * 60_000);

    // The app opens again, one transport on the default relays' budget for everything it runs: the chats live most
    // recently first, then those whose contacts are long gone (nothing under their keys), then its groups (no member
    // online), which read their records and write their own.
    const transport = new RelayTransport({ fetch, log: () => {} });
    const start = Date.now();
    const app = pairs.map((p, i) => chat(p.app, p.contact, transport, `a${i}`, true));
    for (let i = 0; i < GONE; i++) {
      const made = invitationWhere(i % 2 ? "inviter" : "joiner");
      chat(made.inviter, made.joiner, transport, `g${i}`, false);
    }
    const group = withRequestOptions(transport, { group: true });
    let groupsOn = true;
    for (const g of Array.from({ length: GROUPS }, () => createIdentity())) {
      void group.resolve(g.pubKeyZ32).catch(() => {});
      void (async () => {
        while (groupsOn) {
          try { await group.publish(g, []); return; }
          catch (error) { await new Promise((resolve) => setTimeout(resolve, isDiscoveryBudgetError(error) ? Math.max(250, error.retryInMs) : 4_000)); }
        }
      })();
    }

    const liveAt: (number | null)[] = app.map(() => null);
    for (let t = 0; t < 60_000; t += 500) {
      await run(500);
      app.forEach((link, i) => { if (liveAt[i] === null && link.isDataLinkOpen && contacts[i].isDataLinkOpen) liveAt[i] = Date.now() - start; });
    }
    groupsOn = false;
    // Before: 6 of 30 at 2.5 s (contacts whose offers the app answered with the minute's last requests), the rest at
    // 63 to 67 s, once the minute freed. After: all of them by 3 s.
    expect(liveAt.filter((at) => at !== null && at <= 10_000), JSON.stringify(liveAt)).toHaveLength(ONLINE);
  }, 300_000);
});
