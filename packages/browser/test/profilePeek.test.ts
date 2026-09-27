import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { DhtDelivery, DiscoveryBudgetError, HoldKeys, createIdentity, identityFromSeedB64, createLink, createRelayPayload, emptyDhtDeliveryState, parseRelayPayload,
  type DhtDeliveryState, type PairingCredentials, type PkarrTransport, type SignedPacket } from "@ghostly/core";
import { PEEK_LIMITS, ProfilePeek, readPathOf, readProfileStore, type ProfilePeekHost } from "../src/engine/profilePeek";
import { databaseExists } from "../src/backup/database";
import { STORES, wrap } from "../src/shared/idb";
import type { StoredGroup, StoredLink } from "../src/shared/types";
import { CommunityWorld } from "./communityWorld";
// covers: profiles.peek, groups.community.head

/*
 * Checking other profiles (WISP 04 § Checking other profiles): a contact, C, and the profile it writes to, B, which is
 * not running. The running profile peeks at B's chats with B's stored state, over a fake DHT that records every call.
 */

afterEach(() => vi.useRealTimers());

/** A Pkarr DHT in memory: packets by key, every read and publication counted. */
function fakeDht() {
  const packets = new Map<string, SignedPacket>();
  const publish = vi.fn(async (identity: Parameters<PkarrTransport["publish"]>[0], records: Parameters<PkarrTransport["publish"]>[1]) => {
    packets.set(identity.pubKeyZ32, parseRelayPayload(identity.pubKeyZ32, createRelayPayload(identity, records)));
  });
  const resolve = vi.fn(async (key: string, _options?: { background?: boolean }) => packets.get(key) ?? null);
  const publishPayload = vi.fn(async () => {});
  const transport: PkarrTransport = { publish, resolve, publishPayload, describe: () => ({ protocol: "fake", relays: [] }) };
  return { packets, publish, resolve, publishPayload, transport };
}

/** C and B paired over the DHT, then B stopped: what B stored, and C still running to send. */
async function pairedThenAway() {
  vi.useFakeTimers();
  const dht = fakeDht(), link = createLink(), params = [link.mine, link.invite];
  const saved: DhtDeliveryState[] = [emptyDhtDeliveryState(), emptyDhtDeliveryState()];
  const credentials: PairingCredentials[] = [0, 1].map(() => ({ seedB64: createIdentity().seedB64 }));
  const make = (i: number) => new DhtDelivery({ params: params[i], mode: "dht", state: saved[i], credentials: credentials[i], transport: dht.transport,
    save: async (state) => { saved[i] = structuredClone(state); }, pin: async (key) => { credentials[i].peerKey = key; },
    message: async () => {}, receipt: async () => {}, changed: () => {}, pollMs: 100 });
  const c = make(0), b = make(1);
  await c.start(); await b.start(); await vi.advanceTimersByTimeAsync(4_500);
  expect(credentials.every((x) => x.peerKey)).toBe(true);
  await b.stop();
  const stored = (): StoredLink => ({ id: "link-b", profile: "paired-chat/1", participationSeed: credentials[1].seedB64, pairedPeerKey: credentials[1].peerKey,
    seedB64: params[1].seedB64, peerPubKeyZ32: params[1].peerPubKeyZ32, encKeyB64: params[1].encKeyB64, createdAt: 1, dhtDeliveryState: structuredClone(saved[1]) });
  return { dht, c, stored, params, credentials, make };
}

const host = (transport: PkarrTransport, links: () => StoredLink[], extra: Partial<ProfilePeekHost> = {}): ProfilePeekHost => ({
  transport, direct: true, online: () => true, readPath: () => "dht", read: async () => ({ links: links(), settings: {} }), ...extra });

it("sees a text waiting for a profile that is not running, and writes nothing anywhere", async () => {
  const w = await pairedThenAway();
  expect(await w.c.send("for B only", Date.now(), "textforbbbbbbbbbbbbbbb")).toBeNull();
  await vi.advanceTimersByTimeAsync(200);
  const before = w.stored(), publications = w.dht.publish.mock.calls.length;
  const peek = new ProfilePeek(host(w.dht.transport, () => [before]));
  const result = await peek.peek("b", "ghostly_b");
  expect(result.status).toBe("done");
  expect(result.chats).toEqual([{ linkId: "link-b", peer: before.peerPubKeyZ32, peerSequence: before.dhtDeliveryState!.peerSequence, text: "textforbbbbbbbbbbbbbbb", held: 0 }]);
  // Reads only, as background requests; nothing published, and B's state as it was.
  expect(w.dht.publish.mock.calls.length).toBe(publications);
  expect(w.dht.publishPayload).not.toHaveBeenCalled();
  expect(w.dht.resolve.mock.calls.slice(-result.reads).every(([, options]) => options?.background === true)).toBe(true);
  expect(JSON.stringify(result)).not.toContain("for B only");
  await w.c.stop();
});

it("does not count a text the profile already took, nor a keep-alive envelope", async () => {
  const w = await pairedThenAway();
  const peek = new ProfilePeek(host(w.dht.transport, () => [w.stored()]));
  expect((await peek.peek("b", "ghostly_b")).chats[0].text, "only the contact's keep-alive").toBeNull();
  expect(await w.c.send("hello", Date.now(), "takenbbbbbbbbbbbbbbbbb")).toBeNull();
  await vi.advanceTimersByTimeAsync(200);
  expect((await peek.peek("b", "ghostly_b")).chats[0].text).toBe("takenbbbbbbbbbbbbbbbbb");
  // B runs again, takes it, and stops before its receipt clears the text from C's envelope.
  const envelope = new Map(w.dht.packets);
  const b = w.make(1); await b.start(); await vi.advanceTimersByTimeAsync(150); await b.stop();
  for (const [key, packet] of envelope) w.dht.packets.set(key, packet);
  expect(w.stored().dhtDeliveryState!.receipt?.id).toBe("takenbbbbbbbbbbbbbbbbb");
  expect((await peek.peek("b", "ghostly_b")).chats[0].text).toBeNull();
  await w.c.stop();
});

it("ignores an envelope signed by a key other than the contact's", async () => {
  const w = await pairedThenAway();
  await w.c.stop();
  // Someone else holding a copy of the invite writes the contact's invite mailbox.
  w.credentials[0] = { seedB64: createIdentity().seedB64 };
  const forger = w.make(0); await forger.start(); await vi.advanceTimersByTimeAsync(200);
  await forger.send("fake", Date.now(), "forgedbbbbbbbbbbbbbbbb"); await vi.advanceTimersByTimeAsync(200);
  const unpinned = { ...w.stored(), dhtDeliveryState: { ...w.stored().dhtDeliveryState!, peerPinned: undefined } };
  const result = await new ProfilePeek(host(w.dht.transport, () => [unpinned])).peek("b", "ghostly_b");
  expect(result.chats[0].text).toBeNull();
  // The same envelope from the key the chat pinned would count: it is the signature that keeps it out.
  const forgerKey = identityFromSeedB64(w.credentials[0].seedB64).pubKeyZ32;
  expect((await new ProfilePeek(host(w.dht.transport, () => [{ ...unpinned, pairedPeerKey: forgerKey }])).peek("b", "ghostly_b")).chats[0].text).toBe("forgedbbbbbbbbbbbbbbbb");
  await forger.stop();
});

it("counts items held for the profile from the sender's hold pointer, without fetching them", async () => {
  const w = await pairedThenAway();
  await w.c.stop();
  const stored = { ...w.stored(), hold: { enabled: true, outSeq: 0, inSeq: 1, peerAck: 0, pointerRev: 0, peerPointerRev: 2, outbox: [], refused: 0 } };
  const sender = new HoldKeys(w.params[0], w.credentials[0].seedB64, identityFromSeedB64(w.credentials[1].seedB64).pubKeyZ32);
  const now = Date.now();
  await w.dht.transport.publish(sender.identity, sender.pointerRecords({ rev: 3, issued: now, expires: now + 86_400_000, manifestUrl: "https://s3.example/m", top: 4, ack: 0, count: 3, bytes: 90, refused: [] }));
  const result = await new ProfilePeek(host(w.dht.transport, () => [stored])).peek("b", "ghostly_b");
  expect(result.chats[0].held).toBe(3);
  expect(result.reads).toBe(2);
});

it("skips a profile that reads the network another way, and says why", async () => {
  const w = await pairedThenAway();
  const peek = new ProfilePeek(host(w.dht.transport, () => [w.stored()], { read: async () => ({ links: [w.stored()], settings: { readRelays: true } }) }));
  const reads = w.dht.resolve.mock.calls.length;
  expect(await peek.peek("b", "ghostly_b")).toEqual({ status: "path", reads: 0, chats: [] });
  expect(w.dht.resolve.mock.calls.length).toBe(reads);
  expect(readPathOf({ relays: ["https://b.example/", "https://a.example"] }, false)).toBe(readPathOf({ relays: ["https://a.example", "https://b.example"] }, false));
  expect(readPathOf({ relays: ["https://a.example"] }, false)).not.toBe(readPathOf({ relays: ["https://b.example"] }, false));
  expect(readPathOf({ relays: ["https://a.example"] }, true)).toBe("dht");
  await w.c.stop();
});

it("keeps each profile within its own budget, chats taken in turn", async () => {
  const dht = fakeDht();
  const links = Array.from({ length: 10 }, (_, i) => {
    const link = createLink();
    return { id: `link-${i}`, profile: "paired-chat/1", participationSeed: createIdentity().seedB64, pairedPeerKey: createIdentity().pubKeyZ32,
      seedB64: link.invite.seedB64, peerPubKeyZ32: link.invite.peerPubKeyZ32, encKeyB64: link.invite.encKeyB64, createdAt: 1 } as StoredLink;
  });
  // Groups and entry sessions are not chats.
  const noise = [{ ...links[0], id: "edge", group: "g" }, { ...links[1], id: "entry", groupEntry: "guest" as const }];
  let now = 1_000_000;
  const peek = new ProfilePeek(host(dht.transport, () => [...links, ...noise], { now: () => now }));
  const seen: string[] = [];
  for (let round = 0; round < 3; round++) {
    const result = await peek.peek("b", "ghostly_b");
    expect(result.reads).toBe(PEEK_LIMITS.readsPerRound);
    seen.push(...result.chats.map((c) => c.linkId));
    now += 60_000;
  }
  expect(new Set(seen)).toEqual(new Set(links.map((l) => l.id)));
  expect(seen).not.toContain("edge");
  // 18 reads in ten minutes: this profile rests; another profile has a budget of its own.
  expect(await peek.peek("b", "ghostly_b")).toMatchObject({ status: "rested", reads: 0 });
  expect((await peek.peek("c", "ghostly_c")).reads).toBe(PEEK_LIMITS.readsPerRound);
  now += PEEK_LIMITS.windowMs;
  expect((await peek.peek("b", "ghostly_b")).reads).toBe(PEEK_LIMITS.readsPerRound);
  expect(dht.publish).not.toHaveBeenCalled();
});

it("waits when the relays' budget is spent, looks at nothing offline, and opens only other profiles' databases", async () => {
  const dht = fakeDht();
  const link = createLink();
  const stored = { id: "l", profile: "paired-chat/1", participationSeed: createIdentity().seedB64, pairedPeerKey: createIdentity().pubKeyZ32,
    seedB64: link.invite.seedB64, peerPubKeyZ32: link.invite.peerPubKeyZ32, encKeyB64: link.invite.encKeyB64, createdAt: 1 } as StoredLink;
  dht.resolve.mockRejectedValueOnce(new DiscoveryBudgetError(30_000));
  let online = true;
  const peek = new ProfilePeek(host(dht.transport, () => [stored, { ...stored, id: "m" }], { online: () => online }));
  expect(await peek.peek("b", "ghostly_b")).toMatchObject({ status: "budget", chats: [] });
  online = false;
  expect(await peek.peek("b", "ghostly_b")).toEqual({ status: "offline", reads: 0, chats: [] });
  await expect(peek.peek("b", "ghostly")).rejects.toThrow("Not another profile");
  await expect(peek.peek("b", "ghostly-ark-wallet")).rejects.toThrow("Not another profile");
});

it("reads another profile's database without creating, upgrading or changing it", async () => {
  expect(await readProfileStore("ghostly_absent")).toBeNull();
  expect(await databaseExists("ghostly_absent")).toBe(false);
  const open = indexedDB.open("ghostly_other", 3);
  open.onupgradeneeded = () => {
    open.result.createObjectStore(STORES.links, { keyPath: "id" }).put({ id: "x", peerPubKeyZ32: "p" });
    open.result.createObjectStore(STORES.settings).put({ relays: ["https://r.example"] }, "settings");
  };
  (await wrap(open)).close();
  expect(await readProfileStore("ghostly_other")).toEqual({ links: [{ id: "x", peerPubKeyZ32: "p" }], groups: [], settings: { relays: ["https://r.example"] } });
  const again = await wrap(indexedDB.open("ghostly_other"));
  expect(again.version).toBe(3);
  again.close();
});

it("sees a community group's new frame from its beacon's head, and nothing once that profile took it", { timeout: 120_000 }, async () => {
  const world = new CommunityWorld();
  const alice = world.add("alice"), bob = world.add("bob"), carol = world.add("carol");
  const id = await alice.groups.create("Open door");
  const link = await alice.groups.enableLink(id);
  for (const p of [bob, carol]) await p.groups.joinByLink(`https://app.ghostly.tools/#/join/${link}`);
  await world.until(() => [bob, carol].every((p) => world.member(p, id)), 10 * 60_000);
  await world.run(40_000);
  // Bob's profile stops running; the running one (another profile of his device) reads the network as it would.
  bob.online = false;
  const transport: PkarrTransport = { resolve: async (key) => { const records = world.pkarr.get(key); return records ? { pubKeyZ32: key, records, timestamp: 0n } as unknown as SignedPacket : null; },
    publish: vi.fn(async () => { throw new Error("no"); }), describe: () => ({ protocol: "world", relays: [] }) };
  const bobStored = async () => ({ links: [], groups: await bob.store.getGroups(), settings: {} });
  const peek = new ProfilePeek(host(transport, () => [], { read: bobStored, now: () => world.now }));
  const quiet = await peek.peek("bob", "ghostly_bob");
  expect(quiet.chats).toEqual([expect.objectContaining({ linkId: `group:${id}`, text: null })]);
  await carol.groups.send(id, "carol, while bob is away");
  // A hub republishes the beacon within 30 s, with the newest frame it holds.
  await world.run(40_000);
  const seen = await peek.peek("bob", "ghostly_bob");
  expect(seen.reads).toBe(1);
  expect(seen.chats[0].text).toMatch(/:\d+:[0-9a-f]{16}:\d+$/);
  expect(transport.publish).not.toHaveBeenCalled();
  // Bob runs again and is caught up: the same head is no longer new for him.
  bob.online = true;
  await world.until(() => world.texts(bob, id).includes("carol, while bob is away"), 3 * 60_000);
  await world.run(5_000);
  // A session saves what it took (`seen`) a second after taking it.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  bob.online = false;
  const after = await peek.peek("bob", "ghostly_bob");
  expect(after.chats[0].text).toBeNull();
  expect(after.chats[0].peerSequence).toBeGreaterThan(seen.chats[0].peerSequence);
});

it("leaves mesh groups and groups it left out: they publish nothing to look at", async () => {
  const dht = fakeDht();
  const base = { createdAt: 1 } as const;
  const groups = [{ id: "mesh", ...base, state: {} }, { id: "gone", ...base, community: { status: "left", rv: "x" } }, { id: "left", ...base, left: { at: 1, admin: "a" }, community: { status: "active", rv: "x" } }] as unknown as StoredGroup[];
  const result = await new ProfilePeek(host(dht.transport, () => [], { read: async () => ({ links: [], groups, settings: {} }) })).peek("b", "ghostly_b");
  expect(result).toEqual({ status: "done", reads: 0, chats: [] });
});
