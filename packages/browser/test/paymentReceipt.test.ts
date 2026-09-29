import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentity, createLink, identityFromSeedB64 } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
// covers: chat.paired.receipts

/**
 * A payment of mine in a 1:1 chat gets two ticks once the contact's app answers for it (`pay-res`), as a text gets
 * from its receipt: its message goes with no delivery state of its own, and read one tick for good. The chat's link
 * hands the answer to the desk and then to `notePaymentReceipt`; that step is driven here, since a node with no wallet
 * offers no way of paying and its link would keep the frame back.
 */

Object.defineProperty(globalThis.navigator, "storage", { value: { estimate: async () => ({ quota: 50 * 1024 ** 3, usage: 10 * 1024 ** 3 }) }, configurable: true });

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function setup() {
  const invitation = createLink();
  const id = `receipt-${crypto.randomUUID()}`;
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putLink({ ...invitation.mine, id, profile: "paired-chat/1", participationSeed: createIdentity().seedB64, createdAt: 1,
    pairedPeerKey: identityFromSeedB64(createIdentity().seedB64).pubKeyZ32, peerTrust: { version: 1 } });
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false });
  cleanup.push(async () => { await node.shutdown(); await db.deleteLink(id); });
  await node.start();
  const answered = (paymentId: string) => (node as unknown as { notePaymentReceipt(linkId: string, paymentId: string): Promise<void> }).notePaymentReceipt(id, paymentId);
  const delivery = async (messageId: string) => (await db.getMessages(id)).find(m => m.id === messageId)?.delivery;
  return { id, answered, delivery };
}

describe("a payment of mine in a 1:1 chat", () => {
  it("gets two ticks when the contact's app answers for it, and only that payment does", async () => {
    const t = await setup();
    await db.addMessage({ linkId: t.id, id: "me_1", text: "21 sats via Cashu", sender: "me", timestamp: 1, via: "datalink", paymentId: "pay-1" });
    await db.addMessage({ linkId: t.id, id: "me_2", text: "5 sats via Cashu", sender: "me", timestamp: 2, via: "datalink", paymentId: "pay-2" });
    await t.answered("pay-1");
    expect(await t.delivery("me_1")).toBe("delivered");
    expect(await t.delivery("me_2")).toBeUndefined();
  });

  it("changes nothing for a payment the chat does not have, nor for the contact's own", async () => {
    const t = await setup();
    await db.addMessage({ linkId: t.id, id: "me_1", text: "21 sats via Cashu", sender: "me", timestamp: 1, via: "datalink", paymentId: "pay-1" });
    await db.addMessage({ linkId: t.id, id: "peer_1", text: "Requested 5 sats", sender: "peer", timestamp: 2, via: "datalink", paymentId: "req-1" });
    await t.answered("pay-other");
    await t.answered("req-1");
    expect(await t.delivery("me_1")).toBeUndefined();
    expect(await t.delivery("peer_1")).toBeUndefined();
  });
});
