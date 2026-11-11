import { afterEach, expect, it, vi } from "vitest";
import { DhtDelivery, DHT_MESSAGE_TTL, emptyDhtDeliveryState, type DhtDeliveryState } from "../src/dhtDelivery";
import { createLink } from "../src/invite";
import { createIdentity } from "../src/identity";
import { PublishFailedError, type PkarrTransport } from "../src/transport";
// covers: chat.dht.send, chat.waiting

/*
 * The outbox asks the link whether each waiting text fits a packet (`validate`) at every look and check. With no relay
 * taking texts they all wait, none on the floor, and each answer built a whole envelope: a signature, a seal to the
 * contact (its key derived again each time) and an encryption, for an answer that depends on lengths alone. 520 waiting
 * texts cost ~1,040 envelope builds per check, ~1.1 s of CPU every 5 minutes. A fit is measured, not built.
 */

// X25519 agreements (the contact's sealed key, the pinned mailboxes): the noble object is frozen, so counted here.
const agreements = vi.hoisted(() => ({ count: 0 }));
vi.mock("@noble/curves/ed25519.js", async (original) => {
  const actual = await original<typeof import("@noble/curves/ed25519.js")>();
  return { ...actual, x25519: { ...actual.x25519, getSharedSecret: (...args: Parameters<typeof actual.x25519.getSharedSecret>) => { agreements.count++; return actual.x25519.getSharedSecret(...args); } } };
});

const live: DhtDelivery[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const d of live.splice(0)) await d.stop(); });

function delivery(pinned: boolean) {
  let state: DhtDeliveryState = emptyDhtDeliveryState();
  const relays = { puts: 0 };
  const transport: PkarrTransport = {
    // Every relay refuses every PUT: the texts went nowhere and wait.
    publish: async () => { relays.puts++; throw new PublishFailedError("Publish failed on every relay: Error: https://a.test responded 403", false); },
    resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }),
  };
  const credentials = { seedB64: createIdentity().seedB64, ...(pinned && { peerKey: createIdentity().pubKeyZ32 }) };
  const d = new DhtDelivery({ params: createLink().mine, mode: "dht", credentials, transport, pollMs: 600_000,
    save: async (next) => { state = next; }, pin: async () => {}, message: async () => {}, receipt: async () => {}, changed: () => {} });
  live.push(d);
  return { d, relays, state: () => state };
}
const id = (n: number) => `t${String(n).padStart(21, "0")}`;

it("checking 520 waiting texts on a DHT-only chat with no relay taking them builds no envelope", async () => {
  const { d, state } = delivery(true);
  await d.start();
  const texts = Array.from({ length: 520 }, (_, n) => ({ id: id(n), text: `waiting text number ${n}`, at: Date.now() + n }));
  for (const t of texts.slice(0, 3)) expect(await d.send(t.text, t.at, t.id)).toContain("Publish failed on every relay");
  expect(state().pending, "nothing waits on the floor").toBeUndefined();
  const builds = vi.spyOn(DhtDelivery.prototype as unknown as { envelope: () => unknown }, "envelope");
  agreements.count = 0;
  // Two looks, as the outbox's check asks each waiting text (`waitsOn`, then `attempt`).
  for (let look = 0; look < 2; look++) for (const t of texts) expect(d.validate(t.text, t.at, t.id)).toBeNull();
  expect(builds).toHaveBeenCalledTimes(0);
  expect(agreements.count).toBe(0);
});

it("the contact's sealed key is derived once, not per envelope", async () => {
  const { d, relays } = delivery(true);
  await d.start();
  agreements.count = 0;
  for (let n = 0; n < 5; n++) await d.send(`text ${n}`, Date.now(), id(n));
  expect(relays.puts).toBeGreaterThanOrEqual(5);
  // The pinned mailboxes' secret and the envelope key: once each.
  expect(agreements.count).toBeLessThanOrEqual(2);
});

it("a fit is measured to the byte where a built envelope stops fitting, pinned or not, with a reply or not", async () => {
  for (const pinned of [false, true]) {
    const { d } = delivery(pinned);
    const inner = d as unknown as { body: (...args: unknown[]) => unknown; records: (body: unknown, recipient?: string) => unknown; sequence: number;
      options: { credentials: { peerKey?: string } }; participation: { pubKeyZ32: string } };
    const recipient = inner.options.credentials.peerKey ?? inner.participation.pubKeyZ32;
    // Each control character is six bytes of JSON: the packet's bound falls within a 256-byte text.
    for (const reply of [undefined, "abcdefgh"]) for (let n = 0; n <= 256; n += 1) {
      const text = "\u0001".repeat(n) + "x".repeat(256 - n), now = Date.now();
      const built = (() => {
        try { inner.records(inner.body(inner.sequence + 1, now, now + DHT_MESSAGE_TTL, [id(0), now, text], "abcdefghijklmnopqrstuv", reply, []), recipient); return true; }
        catch { return false; }
      })();
      // `validate` drops a reply that does not fit, so ask with it only where the text alone fits.
      const answer = d.validate(text, now, id(0), reply);
      if (reply === undefined) expect(answer === null, `${pinned ? "pinned" : "invite"}, ${n} escaped`).toBe(built);
      else if (built) expect(answer).toBeNull();
    }
  }
});
