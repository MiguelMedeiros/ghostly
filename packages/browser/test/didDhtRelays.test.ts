import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RELAYS, createIdentity } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { STORES, openDb, transact } from "../src/shared/idb";
import type { IdentityFetch } from "../src/proofs/contract";
import { clearDidCache, resolveDid } from "../src/proofs/did";
import { fixedIdentityHosts } from "../src/proofs/fixedHosts";
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
