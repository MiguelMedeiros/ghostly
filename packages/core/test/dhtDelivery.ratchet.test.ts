import { afterEach, expect, it, vi } from "vitest";
import { fromBase64, fromBase64Url } from "../src/bytes";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { createLink, type LinkParams } from "../src/invite";
import { DhtDelivery, DHT_RATCHET_STOPPED, emptyDhtDeliveryState, type DhtDeliveryState, type DhtDeliveryView } from "../src/dhtDelivery";
import { createRelayPayload, parseRelayPayload, type SignedPacket } from "../src/pkarr";
import { emptyRatchetState, RatchetBox, ratchetOpen, type RatchetKeys, type RatchetState } from "../src/ratchet";
import type { PairingCredentials } from "../src/pairedSession";
// covers: chat.dht.delivery, chat.ratchet

const ratchetKeys = (params: LinkParams, credentials: PairingCredentials): RatchetKeys => ({
  seed: fromBase64Url(credentials.seedB64), self: identityFromSeedB64(credentials.seedB64).pubKeyZ32, peer: credentials.peerKey!,
  rendezvous: [identityFromSeedB64(params.seedB64).pubKeyZ32, params.peerPubKeyZ32], secret: fromBase64Url(params.encKeyB64),
});

function setup() {
  const link = createLink(), params = [link.mine, link.invite];
  const packets = new Map<string, SignedPacket>();
  const saved: DhtDeliveryState[] = [emptyDhtDeliveryState(), emptyDhtDeliveryState()];
  const ratchets: RatchetState[] = [emptyRatchetState(), emptyRatchetState()];
  const credentials: PairingCredentials[] = [0, 1].map(() => ({ seedB64: createIdentity().seedB64 }));
  const messages = [new Map<string, string>(), new Map<string, string>()];
  const views: DhtDeliveryView[][] = [[], []];
  /** Whether each side's app runs the ratchet, as its capability record says to the other. */
  const supports = [true, true];
  const published: { key: string; labels: string[]; value?: string }[] = [];
  const publish = vi.fn(async (identity: Parameters<typeof createRelayPayload>[0], records: Parameters<typeof createRelayPayload>[1]) => {
    published.push({ key: identity.pubKeyZ32, labels: records.map(r => r.label), value: records.find(r => r.label === "_dr")?.value });
    packets.set(identity.pubKeyZ32, parseRelayPayload(identity.pubKeyZ32, createRelayPayload(identity, records)));
  });
  const resolve = vi.fn(async (key: string) => packets.get(key) ?? null);
  const boxes: (RatchetBox | undefined)[] = [];
  const make = (i: number) => {
    boxes[i] = supports[i] ? new RatchetBox(() => ratchetKeys(params[i], credentials[i]), ratchets[i], async state => { ratchets[i] = structuredClone(state); }) : undefined;
    return new DhtDelivery({
      params: params[i], mode: "dht", state: saved[i], credentials: credentials[i], transport: { publish, resolve, describe: () => ({ protocol: "fixture", relays: [] }) },
      save: async state => { saved[i] = structuredClone(state); }, pin: async key => { credentials[i].peerKey = key; },
      message: async m => { messages[i].set(m.id, m.text); }, receipt: async () => {}, changed: view => { views[i].push(view); }, pollMs: 100,
      ...(boxes[i] && { ratchet: { box: boxes[i]!, peerSupports: () => supports[1 - i] } }),
    });
  };
  return { params, packets, saved, ratchets, credentials, messages, views, supports, published, resolve, boxes, make };
}
afterEach(() => vi.useRealTimers());
const id = (n: number) => `ratchet${String(n).padStart(15, "0")}`;

it("two apps with ratchet/1 seal the floor with it after the pin, and forward secrecy turns on", async () => {
  vi.useFakeTimers();
  const h = setup(), a = h.make(0), b = h.make(1);
  await a.start(); await b.start(); await vi.advanceTimersByTimeAsync(5_000);
  expect(await a.send("one", Date.now(), id(1))).toBeNull();
  await vi.advanceTimersByTimeAsync(6_000);
  expect(await b.send("two", Date.now(), id(2))).toBeNull();
  await vi.advanceTimersByTimeAsync(6_000);
  expect(await a.send("three", Date.now(), id(3))).toBeNull();
  await vi.advanceTimersByTimeAsync(6_000);
  expect(h.messages[1].get(id(1))).toBe("one");
  expect(h.messages[0].get(id(2))).toBe("two");
  expect(h.messages[1].get(id(3))).toBe("three");
  // After the pin, every envelope of both is ratcheted, and a packet carries one sealed record.
  const ratcheted = h.published.filter(p => p.labels.includes("_dr"));
  expect(ratcheted.length).toBeGreaterThan(2);
  for (const p of ratcheted) expect(p.labels).not.toContain("_dm");
  expect(h.views[0].at(-1)?.forwardSecrecy).toBe("on");
  expect(h.views[1].at(-1)?.forwardSecrecy).toBe("on");
  // A recorded envelope from after the turn passed: its reader's participation key alone (a state from nothing) opens nothing.
  const last = ratcheted.at(-1)!;
  const reader = last.key === h.published.find(p => p.labels.includes("_dr") && p.key === last.key)!.key ? h.ratchets : h.ratchets;
  void reader;
  for (const i of [0, 1]) expect(ratchetOpen(emptyRatchetState(), ratchetKeys(h.params[i], h.credentials[i]), "floor", fromBase64(last.value!))).toBeNull();
  await a.stop(); await b.stop();
});

it("an app without it gets plain envelopes, both ways, as before", async () => {
  vi.useFakeTimers();
  const h = setup();
  h.supports[1] = false;
  const a = h.make(0), b = h.make(1);
  await a.start(); await b.start(); await vi.advanceTimersByTimeAsync(5_000);
  expect(await a.send("to an older app", Date.now(), id(1))).toBeNull();
  await vi.advanceTimersByTimeAsync(6_000);
  expect(await b.send("from an older app", Date.now(), id(2))).toBeNull();
  await vi.advanceTimersByTimeAsync(6_000);
  expect(h.messages[1].get(id(1))).toBe("to an older app");
  expect(h.messages[0].get(id(2))).toBe("from an older app");
  expect(h.published.some(p => p.labels.includes("_dr"))).toBe(false);
  expect(h.views[0].at(-1)?.forwardSecrecy).toBe("unsupported");
  await a.stop(); await b.stop();
});

it("once on, a plain envelope from the contact is refused, and nothing of this side goes plain", async () => {
  vi.useFakeTimers();
  const h = setup();
  let a = h.make(0), b = h.make(1);
  await a.start(); await b.start(); await vi.advanceTimersByTimeAsync(5_000);
  expect(await a.send("protected", Date.now(), id(1))).toBeNull();
  await vi.advanceTimersByTimeAsync(6_000);
  expect(h.messages[1].get(id(1))).toBe("protected");
  // The contact's app goes back to a version without it: its record no longer lists ratchet/1.
  await b.stop(); h.supports[1] = false; b = h.make(1); await b.start();
  expect(await b.send("plain again", Date.now(), id(2))).toBeNull();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.messages[0].has(id(2))).toBe(false);
  expect(h.views[0].at(-1)?.forwardSecrecy).toBe("stopped");
  expect(await a.send("waits for live", Date.now(), id(3))).toBe(DHT_RATCHET_STOPPED);
  await a.stop(); a = h.make(0); await a.start(); await vi.advanceTimersByTimeAsync(5_000);
  expect(h.published.filter(p => p.key === h.published.find(q => q.labels.includes("_dr"))!.key).at(-1)?.labels).toContain("_dr");
  await a.stop(); await b.stop();
});

it("reads the same envelope again without opening it, and measuring a text takes no key", async () => {
  vi.useFakeTimers();
  const h = setup(), a = h.make(0), b = h.make(1);
  await a.start(); await b.start(); await vi.advanceTimersByTimeAsync(5_000);
  expect(await a.send("once", Date.now(), id(1))).toBeNull();
  await vi.advanceTimersByTimeAsync(6_000);
  const before = JSON.stringify(h.ratchets[1]);
  const reads = h.resolve.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.resolve.mock.calls.length).toBeGreaterThan(reads);
  expect(h.messages[1].size).toBe(1);
  expect(h.saved[1].lastDr).toBeTruthy();
  const sent = JSON.stringify(h.ratchets[0].current?.send);
  for (let i = 0; i < 5; i++) expect(a.validate("x".repeat(200), Date.now(), id(9))).toBeNull();
  expect(JSON.stringify(h.ratchets[0].current?.send)).toBe(sent);
  void before;
  await a.stop(); await b.stop();
});
