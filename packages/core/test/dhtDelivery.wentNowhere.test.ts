import { afterEach, expect, it } from "vitest";
import { DhtDelivery, emptyDhtDeliveryState, type DhtDeliveryState } from "../src/dhtDelivery";
import { createLink } from "../src/invite";
import { createIdentity } from "../src/identity";
import { PublishFailedError, type PkarrTransport } from "../src/transport";
// covers: chat.dht.send, chat.waiting

/*
 * A text whose publish went nowhere (every relay refused it or was not asked: `PublishFailedError` with `mayBeStored`
 * false) never left this device: it leaves the floor, so the floor's own retries do not publish it behind the outbox's
 * back (a cancelled text went out once the relays answered), and the link says so (`wentNowhereFor`). One that may be
 * out (a relay that timed out) stays the floor's to retry, as before.
 */

const ID = "abcdefghijklmnopqrstuv", OTHER = "bcdefghijklmnopqrstuvw";
const live: DhtDelivery[] = [];
afterEach(async () => { for (const d of live.splice(0)) await d.stop(); });

function delivery() {
  let state: DhtDeliveryState = emptyDhtDeliveryState();
  const relays = { outcome: "nowhere" as "nowhere" | "maybe" | "ok", puts: 0 };
  const transport: PkarrTransport = {
    publish: async () => {
      relays.puts++;
      if (relays.outcome !== "ok") throw new PublishFailedError("Publish failed on every relay: Error: https://a.test responded 403", relays.outcome === "maybe");
    },
    resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }),
  };
  const d = new DhtDelivery({ params: createLink().mine, mode: "dht", credentials: { seedB64: createIdentity().seedB64 }, transport, pollMs: 600_000,
    save: async (next) => { state = next; }, pin: async () => {}, message: async () => {}, receipt: async () => {}, changed: () => {} });
  live.push(d);
  return { d, relays, state: () => state };
}

it("a text no relay holds leaves the floor, and a second text may take it", async () => {
  const { d, relays, state } = delivery();
  await d.start();
  expect(await d.send("first", Date.now(), ID)).toContain("Publish failed on every relay");
  expect(d.wentNowhereFor(ID)).toBe(true);
  expect(state().pending).toBeUndefined();
  expect(d.pendingId).toBeUndefined();
  // Nothing of it is on the floor: another text is not told to wait for its receipt.
  relays.outcome = "ok";
  expect(await d.send("second", Date.now(), OTHER)).toBeNull();
  expect(state().pending?.message[0]).toBe(OTHER);
});

it("a text a relay may hold (it timed out) stays the floor's, as before", async () => {
  const { d, relays, state } = delivery();
  await d.start();
  relays.outcome = "maybe";
  expect(await d.send("first", Date.now(), ID)).toContain("Publish failed on every relay");
  expect(d.wentNowhereFor(ID)).toBe(false);
  expect(state().pending?.message[0]).toBe(ID);
  // Sent again and refused everywhere this time: the first publication may be out, so it keeps the floor.
  relays.outcome = "nowhere";
  expect(await d.send("first", Date.now(), ID)).toContain("Publish failed on every relay");
  expect(d.wentNowhereFor(ID)).toBe(false);
  expect(state().pending?.message[0]).toBe(ID);
});

it("sent again after going nowhere, a text that goes out is no longer said to have gone nowhere", async () => {
  const { d, relays, state } = delivery();
  await d.start();
  await d.send("first", Date.now(), ID);
  expect(d.wentNowhereFor(ID)).toBe(true);
  relays.outcome = "ok";
  expect(await d.send("first", Date.now(), ID)).toBeNull();
  expect(d.wentNowhereFor(ID)).toBe(false);
  expect(state().pending?.message[0]).toBe(ID);
});
