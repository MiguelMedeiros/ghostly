import { afterEach, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { createLink } from "../src/invite";
import { DhtDelivery, emptyDhtDeliveryState, type DhtDeliveryState } from "../src/dhtDelivery";
import { createRelayPayload, parseRelayPayload, type SignedPacket } from "../src/pkarr";
import type { PairingCredentials } from "../src/pairedSession";
import type { WireReaction } from "../src/reactions";
// covers: chat.reactions.wire

/** Reactions on DHT envelopes (WISP 403 § Reactions): the thirteenth element carries them, the fourteenth says them taken. */

function setup(options: { reactions?: [boolean, boolean] } = {}) {
  const link = createLink(), params = [link.mine, link.invite];
  const packets = new Map<string, SignedPacket>();
  const saved: DhtDeliveryState[] = [emptyDhtDeliveryState(), emptyDhtDeliveryState()];
  const credentials: PairingCredentials[] = [0, 1].map(() => ({ seedB64: createIdentity().seedB64 }));
  const messages = [new Map<string, string>(), new Map<string, string>()];
  const pending: WireReaction[][] = [[], []];
  const got: WireReaction[][] = [[], []];
  const taken: number[][] = [[], []];
  const publish = vi.fn(async (identity, records) => {
    const wire = createRelayPayload(identity, records);
    expect(wire.length).toBeLessThanOrEqual(1072);
    packets.set(identity.pubKeyZ32, parseRelayPayload(identity.pubKeyZ32, wire));
  });
  const resolve = vi.fn(async key => packets.get(key) ?? null);
  const made: DhtDelivery[] = [];
  const make = (i: number) => made[i] = new DhtDelivery({
    params: params[i], mode: "dht", state: saved[i], credentials: credentials[i],
    transport: { publish, resolve, describe: () => ({ protocol: "signed-packet fixture", relays: [] }) },
    save: async state => { saved[i] = structuredClone(state); },
    pin: async key => { credentials[i].peerKey = key; },
    message: async m => { messages[i].set(m.id, m.text); }, receipt: async () => {}, changed: () => {}, pollMs: 100,
    ...((options.reactions?.[i] ?? true) && {
      reactions: () => pending[i],
      reaction: async r => { got[i].push(r); },
      // As the engine does: what is left is announced again.
      reactionsTaken: async n => { taken[i].push(n); pending[i] = pending[i].filter(p => p.n > n); if (pending[i].length) void made[i].announceReactions(); },
    }),
  });
  return { make, pending, got, taken, messages, saved, publish, packets };
}
afterEach(() => vi.useRealTimers());
// Fake timers over real crypto: slow on a busy runner.
vi.setConfig({ testTimeout: 30_000 });

const ID = (c: string) => c.repeat(22);

it("carries this side's reactions until the contact says it took them", async () => {
  vi.useFakeTimers(); const h = setup();
  const a = h.make(0), b = h.make(1);
  await a.start(); await b.start(); await vi.advanceTimersByTimeAsync(4_500);
  h.pending[0] = [{ id: ID("m"), e: "👍", n: 10 }, { id: ID("n"), e: "", n: 11 }];
  await a.announceReactions();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.got[1]).toEqual([{ id: ID("m"), e: "👍", n: 10 }, { id: ID("n"), e: "", n: 11 }]);
  expect(h.saved[1].reactionsTaken).toBe(11);
  expect(h.taken[0]).toContain(11);
  expect(h.pending[0]).toEqual([]);
  await a.stop(); await b.stop();
});

it("a text near the bound leaves room for fewer reactions, never none of the text", async () => {
  vi.useFakeTimers(); const h = setup();
  const a = h.make(0), b = h.make(1);
  await a.start(); await b.start(); await vi.advanceTimersByTimeAsync(4_500);
  h.pending[0] = Array.from({ length: 12 }, (_, i) => ({ id: ID(String.fromCharCode(97 + i)), e: "👨‍👩‍👧‍👦", n: 100 + i }));
  expect(await a.send("x".repeat(256), Date.now(), ID("t"))).toBeNull();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.messages[1].get(ID("t"))).toBe("x".repeat(256));
  // Oldest first, as many as fit (at most eight an envelope); the rest ride on the next envelopes.
  expect(h.got[1].length).toBeGreaterThan(0);
  expect(h.got[1][0].n).toBe(100);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(new Set(h.got[1].map(r => r.n)).size).toBe(12);
  await a.stop(); await b.stop();
});

it("a reader without reactions reads the text and skips the rest", async () => {
  vi.useFakeTimers(); const h = setup({ reactions: [true, false] });
  const a = h.make(0), b = h.make(1);
  await a.start(); await b.start(); await vi.advanceTimersByTimeAsync(4_500);
  h.pending[0] = [{ id: ID("m"), e: "😂", n: 3 }];
  expect(await a.send("still here", Date.now(), ID("s"))).toBeNull();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.messages[1].get(ID("s"))).toBe("still here");
  expect(h.got[1]).toEqual([]);
  expect(h.pending[0]).toHaveLength(1);
  await a.stop(); await b.stop();
});
