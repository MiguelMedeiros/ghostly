import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RELAYS, createIdentity } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { STORES, openDb, transact } from "../src/shared/idb";
import type { IdentityFetch } from "../src/proofs/contract";
import { clearDidCache, resolveDid } from "../src/proofs/did";
import { fixedIdentityHosts } from "../src/proofs/fixedHosts";
import { setPkarrRelaySource } from "../src/proofs/pkarrRelays";
import { boundedIdentityFetch } from "../src/proofs/verify";
import { PUBKY_RELAYS } from "../src/proofs/pubkyRelays";
// covers: proofs.did, settings.network.relays

const OWN = "https://pkarr.my-own-relay.example";
const transport = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) } as never;
const running: GhostlyNode[] = [];

/** Every URL a did:dht lookup asks, none of them answered (no document anywhere). */
function recording() {
  const asked: string[] = [];
  const fetch: IdentityFetch = async url => { asked.push(url); return { status: 404, contentType: "text/plain", text: "", bytes: new Uint8Array() }; };
  return { asked, fetch };
}

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No network in this test"); }));
  clearDidCache();
  await openDb();
  await transact([STORES.settings], s => { s[STORES.settings].clear(); });
});
afterEach(async () => {
  for (const node of running.splice(0)) await node.shutdown();
  vi.unstubAllGlobals();
});

describe("a contact's did:dht is read from this profile's Pkarr relays", () => {
  it("a profile that replaced the relay list is read from its own relay only, and under Hide my IP that relay is allowed", async () => {
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false });
    running.push(node);
    await node.start();
    await node.updateSettings({ settings: { relays: [OWN] } });

    const { asked, fetch } = recording();
    const did = `did:dht:${createIdentity().pubKeyZ32}`;
    await expect(resolveDid(did, { fetch })).rejects.toThrow(/No document is published/);
    expect(asked).toEqual([`${OWN}/${did.slice("did:dht:".length)}`]);

    const hosts = fixedIdentityHosts();
    expect(hosts.has(new URL(OWN).host)).toBe(true);
    // The defaults Pubky's provider does not name are not allowed any more.
    for (const relay of DEFAULT_RELAYS.filter(r => !PUBKY_RELAYS.includes(r))) expect(hosts.has(new URL(relay).host)).toBe(false);
  });
});

describe("the profile's own Pkarr relays are read for a did:dht whatever their kind, as the chats read them", () => {
  const LOOPBACK = "http://127.0.0.1:9";
  const LAN = "https://192.168.1.10";
  /** As the CLI's `nodePublicFetch`: HTTPS at a public address only. */
  const publicOnly = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.protocol !== "https:") throw new TypeError("Only HTTPS is read");
    if (/^(127\.|192\.168\.)/.test(url.hostname)) throw new TypeError(`${url.hostname} is not a public address`);
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const relayAsked: string[] = [];
  const relayFetcher = (async (input: RequestInfo | URL) => { relayAsked.push(String(input)); return new Response("", { status: 404 }); }) as typeof fetch;
  beforeEach(() => { relayAsked.length = 0; setPkarrRelaySource(() => [LOOPBACK, LAN]); });
  afterEach(() => setPkarrRelaySource(() => undefined));

  it("an http:// relay and one at a private address are asked, through the relay fetch, and nothing else is let through", async () => {
    const fetch = boundedIdentityFetch({ online: () => true, fetcher: publicOnly, relayFetcher });
    const z32 = createIdentity().pubKeyZ32;
    await expect(resolveDid(`did:dht:${z32}`, { fetch })).rejects.toThrow(/No document is published/);
    expect(relayAsked.sort()).toEqual([`${LOOPBACK}/${z32}`, `${LAN}/${z32}`]);

    // A URL a contact names keeps the HTTPS and public-address rules, even one on the relay's host or marked as a relay read.
    await expect(fetch(`${LOOPBACK}/${z32}`)).rejects.toThrow(/HTTPS only/);
    await expect(fetch(`http://127.0.0.1:8/${z32}`, { ownPkarrRelay: true })).rejects.toThrow(/HTTPS only/);
    await expect(fetch(`${LAN}/${z32}`)).rejects.toThrow(/not a public address/);
    await expect(fetch(`https://u:p@192.168.1.10/${z32}`, { ownPkarrRelay: true })).rejects.toThrow(/HTTPS only/);
    expect(relayAsked).toHaveLength(2);
  });

  it("offline, the relays are not asked either", async () => {
    const fetch = boundedIdentityFetch({ online: () => false, fetcher: publicOnly, relayFetcher });
    await expect(resolveDid(`did:dht:${createIdentity().pubKeyZ32}`, { fetch })).rejects.toThrow(/could not|Offline|No Pkarr relay/);
    expect(relayAsked).toEqual([]);
  });

  it("the engine reads the relays with the plain fetch, not with the public-address fetch the CLI gives it for a contact's addresses", async () => {
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false, identityFetch: publicOnly });
    running.push(node);
    await node.start();
    await node.updateSettings({ settings: { relays: [LOOPBACK] } });
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => { asked.push(String(input)); return new Response("", { status: 404 }); }));
    const fetch = (node as unknown as { identities: { fetch: IdentityFetch } }).identities.fetch;
    const z32 = createIdentity().pubKeyZ32;
    await expect(resolveDid(`did:dht:${z32}`, { fetch })).rejects.toThrow(/No document is published/);
    expect(asked).toEqual([`${LOOPBACK}/${z32}`]);
  });
});
