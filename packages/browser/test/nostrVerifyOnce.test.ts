import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { readRelays } from "../src/nostr/relay";
import { nodeSocket, TestNostrRelay } from "./helpers/nostrRelay";
// covers: nostr.social.notes

/**
 * Every copy a relay sent was put through a BIP-340 check (3 ms each on One) before its id was looked up: Load notes
 * from 8 relays checked 160 events for 20 notes. A copy of an event already checked, the same in every field, is taken
 * without a second check; one that only borrows its id is not taken at all.
 */
const verifies = vi.hoisted(() => ({ count: 0 }));
vi.mock("nostr-tools/pure", async original => {
  const actual = await original<typeof import("nostr-tools/pure")>();
  return { ...actual, verifyEvent: (event: Parameters<typeof actual.verifyEvent>[0]) => { verifies.count++; return actual.verifyEvent(event); } };
});

const now = Math.floor(Date.now() / 1000);
const alice = generateSecretKey(), bob = generateSecretKey();
const A = getPublicKey(alice);
const relay = new TestNostrRelay(), forger = new TestNostrRelay();
beforeAll(async () => { await relay.listen(); await forger.listen(); });
afterAll(async () => { await relay.close(); await forger.close(); });
beforeEach(() => { verifies.count = 0; });

it("checks the signature of an event once, however many relays send it", async () => {
  for (let i = 0; i < 5; i++) relay.add({ kind: 1, tags: [], content: `note ${i}`, created_at: now - 10 + i }, alice);
  // The same relay under four addresses: four relays holding the same five notes.
  const four = [relay.url, `${relay.url}/b`, `${relay.url}/c`, `${relay.url}/d`];
  const result = await readRelays(four, { kinds: [1], authors: [A] }, { makeSocket: nodeSocket, timeoutMs: 3000 });
  expect(result.events.map(e => e.content)).toEqual(["note 4", "note 3", "note 2", "note 1", "note 0"]);
  expect(result.answered.sort()).toEqual([...four].sort());
  expect(verifies.count).toBe(5);
});

it("leaves out what the filter does not ask for without checking it", async () => {
  relay.add({ kind: 1, tags: [], content: "bob's", created_at: now }, bob);
  // The relay answers more than it was asked: Bob's note beside Alice's five.
  const original = relay.select.bind(relay);
  relay.select = () => original({ kinds: [1] });
  try {
    const result = await readRelays([relay.url], { kinds: [1], authors: [A] }, { makeSocket: nodeSocket, timeoutMs: 3000 });
    expect(result.events).toHaveLength(5);
    expect(verifies.count).toBe(5);
  } finally {
    relay.select = original;
  }
});

it("a copy that borrows a checked event's id with other content is not taken", async () => {
  const genuine = relay.add({ kind: 1, tags: [], content: "genuine", created_at: now - 1 }, alice);
  forger.events.push({ ...genuine, content: "forged" });
  const result = await readRelays([relay.url, forger.url], { kinds: [1], authors: [A] }, { makeSocket: nodeSocket, timeoutMs: 3000 });
  expect(result.events.find(e => e.id === genuine.id)?.content).toBe("genuine");
  expect(result.events.some(e => e.content === "forged")).toBe(false);
});
