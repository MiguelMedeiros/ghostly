import { afterEach, expect, it, vi } from "vitest";
import { createIdentity } from "../src/identity";
import { createLink } from "../src/invite";
import { DhtDelivery, emptyDhtDeliveryState } from "../src/dhtDelivery";
import type { PairingCredentials } from "../src/pairedSession";
// covers: chat.dht.delivery

/**
 * An app back after a restart: a chat already paired sends its first control envelope `firstControlAfterMs` after the
 * start, out of the burst of the links' first packets (bug hunt r7a: a daemon with two chats and two groups spent 25 of
 * pkarr.pubky.org's 30 requests on writes in its first 11 s, each chat's envelope two or three times). A text still goes
 * at once, and a chat not paired yet (a first contact over its mailbox) is not held back.
 */
function side(paired: boolean) {
  const link = createLink();
  const publish = vi.fn(async () => {});
  const credentials: PairingCredentials = { seedB64: createIdentity().seedB64, ...(paired ? { peerKey: createIdentity().pubKeyZ32 } : {}) };
  const delivery = new DhtDelivery({
    params: link.mine, mode: "stream", state: emptyDhtDeliveryState(), credentials,
    transport: { publish, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) },
    save: async () => {}, pin: async () => {}, message: async () => {}, receipt: async () => {}, changed: () => {},
    firstControlAfterMs: 15_000,
  });
  return { delivery, publish };
}
afterEach(() => vi.useRealTimers());

it("a paired chat started again sends its first control envelope after the quiet start, once", async () => {
  vi.useFakeTimers();
  const { delivery, publish } = side(true);
  await delivery.start(); await vi.advanceTimersByTimeAsync(14_000);
  expect(publish, "nothing in the start's burst").not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(publish).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(publish, "then at its usual pace").toHaveBeenCalledTimes(1);
  await delivery.stop();
});

it("a text during the quiet start goes at once; a chat not paired yet is not held back", async () => {
  vi.useFakeTimers();
  const paired = side(true);
  await paired.delivery.start(); await vi.advanceTimersByTimeAsync(1_000);
  await paired.delivery.setMode("dht"); await vi.advanceTimersByTimeAsync(0);
  expect(paired.publish, "a new mode goes at once").toHaveBeenCalledTimes(1);
  await paired.delivery.stop();
  const again = side(true);
  await again.delivery.start(); await vi.advanceTimersByTimeAsync(1_000);
  expect(await again.delivery.send("hello", Date.now(), "abcdefghijklmnopqrstuv")).toBeNull();
  expect(again.publish, "the text").toHaveBeenCalledTimes(1);
  await again.delivery.stop();
  const first = side(false);
  await first.delivery.start(); await vi.advanceTimersByTimeAsync(100);
  expect(first.publish, "a first contact's envelope at once").toHaveBeenCalledTimes(1);
  await first.delivery.stop();
});
