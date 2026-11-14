import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createIdentity, type GhostRecord, type Identity, type PaymentRequest, type PkarrTransport } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { StoredLink, StoredMessage, StoredPayment } from "../src/shared/types";
// covers: delivery.hold.request, payments.cashu.request, chat.paired.delete-message

/*
 * A Cashu/Lightning request to an away contact is saved pending at the desk, and its chat line waits for the live
 * session (`waiting`) or is held in storage (`sending`, then `held` or `failed`). When the session opens, the desk
 * sends every pending request of the chat (`replay`). Deleting the line here before the contact had it withdrew the
 * request only when it was `waiting`: a held one, or one whose hold failed, still went at the next session, with
 * its invoice and mints, and could be paid.
 */

const transport: PkarrTransport = {
  publish: async (_identity: Identity, _records: GhostRecord[]) => {},
  publishPayload: async () => {},
  resolve: async () => null,
  describe: () => ({ protocol: "none", relays: [] }),
};

const nodes: GhostlyNode[] = [];
beforeEach(async () => {
  const stores = [STORES.settings, STORES.links, STORES.messages, STORES.payments];
  await transact(stores, (s) => { for (const name of stores) s[name].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown().catch(() => {}); vi.restoreAllMocks(); });

type Inner = {
  desk: { save(payment: StoredPayment): Promise<void>; payment(id: string): StoredPayment | undefined; replay(linkId: string): Promise<void>; host: { getLink(linkId: string): unknown } };
};

/** A chat with one request of ours on its desk and its line in the state given; the contact comes live afterwards. */
async function chat(delivery: StoredMessage["delivery"]) {
  const link: StoredLink = { id: `chat-${crypto.randomUUID().slice(0, 8)}`, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64 };
  await db.putLink(link);
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false });
  nodes.push(node);
  // Nothing dials: the contact is away until the test opens its session.
  vi.spyOn(node as unknown as { startLink(id: string): void }, "startLink").mockImplementation(() => {});
  await node.start();
  const { desk } = node as unknown as Inner;
  const paymentId = "req-10000", messageId = "me_5";
  await desk.save({ id: paymentId, linkId: link.id, kind: "request", direction: "out", amount: 10_000, unit: "sat", state: "pending", createdAt: 5,
    invoice: "lntbs100u1fake", mints: ["https://testnut.cashu.space"], network: "testnet" } as StoredPayment);
  await db.putMessage({ linkId: link.id, id: messageId, text: "⚡ Requested 10,000 test sats", sender: "me", timestamp: 5, via: delivery === "waiting" ? "datalink" : "hold",
    paymentId, ...(delivery && { delivery }) } as StoredMessage);
  /** The contact's session opens: what the desk sends it. */
  const live = async () => {
    const sent: PaymentRequest[] = [];
    vi.spyOn(desk.host, "getLink").mockImplementation((id) => id === link.id ? { supportsPayments: true, sendPaymentRequest: async (r: PaymentRequest) => { sent.push(r); } } : undefined);
    await desk.replay(link.id);
    return sent.map((r) => ({ id: r.id, amount: r.amount.value }));
  };
  const remove = async () => {
    node.deleteMessage({ linkId: link.id, messageId });
    await vi.waitFor(async () => expect(await db.getMessage(link.id, messageId)).toBeUndefined());
    await vi.waitFor(() => expect((node as unknown as { links: Map<string, { stored: StoredLink }> }).links.get(link.id)?.stored.deletedIds).toContain(messageId));
  };
  return { desk, paymentId, live, remove };
}

for (const delivery of ["sending", "held", "failed"] as const) {
  const line = delivery === "sending" ? "being held" : delivery === "held" ? "held for the away contact" : "not held (the hold failed)";
  it(`a request whose line is ${line}, left alone, goes at the next session: the contact can pay it`, async () => {
    const t = await chat(delivery);
    expect(await t.live()).toEqual([{ id: t.paymentId, amount: "10000" }]);
    expect(t.desk.payment(t.paymentId)?.state).toBe("pending");
  });

  it(`a request whose line is ${line}, deleted here, never goes out at the next session`, async () => {
    const t = await chat(delivery);
    await t.remove();
    await vi.waitFor(() => expect(t.desk.payment(t.paymentId)?.state).toBe("failed"));
    expect(await t.live()).toEqual([]);
  });
}

it("a request waiting for the live session, deleted here, is withdrawn too (as before)", async () => {
  const t = await chat("waiting");
  await t.remove();
  await vi.waitFor(() => expect(t.desk.payment(t.paymentId)?.state).toBe("failed"));
  expect(await t.live()).toEqual([]);
});

for (const delivery of [undefined, "delivered"] as const) {
  it(`a request the contact already has (${delivery ? "its held copy picked up" : "sent live"}), deleted here, stays open: its payment may still come`, async () => {
    const t = await chat(delivery);
    await t.remove();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.desk.payment(t.paymentId)?.state).toBe("pending");
  });
}
