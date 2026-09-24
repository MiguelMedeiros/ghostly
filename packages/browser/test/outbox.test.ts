import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/engine/db";
import { Outbox } from "../src/engine/outbox";
import type { StoredMessage } from "../src/shared/types";
// covers: chat.paired.offline-send, chat.paired.receipts, chat.dht.send

afterEach(() => vi.useRealTimers());
let serial = 0;
async function setup(send: (message: StoredMessage) => Promise<string | null>) {
  const linkId = `outbox-${++serial}`, wireId = "abcdefghijklmnopqrstuv", id = `me_${wireId}`;
  await db.addMessage({ linkId, id, wireId, text: "hello", sender: "me", timestamp: 1, via: "datalink", delivery: "sending" });
  const store = { read: () => db.getMessages(linkId), update: (id: string, delivery: NonNullable<StoredMessage["delivery"]>, error?: string) => db.updateDelivery(linkId, id, delivery, error) };
  return { linkId, id, wireId, store, box: new Outbox(store, send, 100), row: async () => (await db.getMessages(linkId))[0] };
}
describe("durable paired message delivery", () => {
  it("records sent separately from received and keeps receipts terminal across races", async () => {
    const p = await setup(async () => null);
    await p.box.transmit(p.id); expect((await p.row()).delivery).toBe("sent");
    await p.box.received(p.wireId);
    await Promise.all([p.store.update(p.id, "failed"), p.store.update(p.id, "sent")]);
    expect((await p.row()).delivery).toBe("delivered");
    await p.box.stop();
  });
  it("keeps the same wire ID after lost receipt, engine restart and retry; receiver deduplicates", async () => {
    const receive = vi.fn(async (m: StoredMessage) => {
      await db.addMessage({ ...m, linkId: "recipient-retry", id: `peer_${m.wireId}`, sender: "peer", delivery: undefined });
      return null;
    });
    const p = await setup(receive); await p.box.transmit(p.id);
    await p.box.stop();
    const restarted = new Outbox(p.store, receive, 100);
    await restarted.recover(); expect((await p.row()).delivery).toBe("failed");
    await Promise.all([restarted.transmit(p.id), restarted.transmit(p.id)]);
    expect(receive).toHaveBeenCalledTimes(2);
    expect(await db.getMessages("recipient-retry")).toHaveLength(1);
    await restarted.received(p.wireId); await restarted.stop();
  });
  it("recovers an interrupted send as uncertain and never resurrects a deleted row", async () => {
    const p = await setup(async () => "Connection closed");
    await p.box.recover(); expect((await p.row()).delivery).toBe("failed");
    await p.box.transmit(p.id); expect((await p.row()).deliveryError).toBe("Connection closed");
    await db.deleteMessage(p.linkId, p.id); await p.box.received(p.wireId);
    expect(await p.row()).toBeUndefined(); await p.box.stop();
  });
  it("keeps delivery uncertain if persisting a receipt fails", async () => {
    const p = await setup(async () => null);
    const update = p.store.update;
    const box = new Outbox({ ...p.store, update: (id, state, error) => state === "delivered"
      ? Promise.reject(new Error("Storage unavailable")) : update(id, state, error) }, async () => null, 100);
    await box.transmit(p.id);
    await expect(box.received(p.wireId)).rejects.toThrow("Storage unavailable");
    await box.disconnected();
    expect((await p.row()).delivery).toBe("failed");
    await box.stop();
  });
  it("does not claim delivery after receipt timeout", async () => {
    const p = await setup(async () => null);
    await p.box.transmit(p.id);
    await vi.waitFor(async () => expect((await p.row()).delivery).toBe("failed"));
    await p.box.received(p.wireId); expect((await p.row()).delivery).toBe("delivered");
    await p.box.stop();
  });
});

it("resumes a DHT receipt timer at the original deadline without retransmitting on restart", async () => {
  vi.useFakeTimers();
  const row: StoredMessage = { linkId: "dht-restart", id: "me_abcdefghijklmnopqrstuv", wireId: "abcdefghijklmnopqrstuv", text: "pending", sender: "me", timestamp: Date.now(), via: "pkarr", delivery: "sent" };
  const send = vi.fn(async () => null);
  const store = { read: async () => [row], update: async (_id: string, delivery: NonNullable<StoredMessage["delivery"]>) => { row.delivery = delivery; } };
  const deadline = Date.now() + 10_000;
  const first = new Outbox(store, send, 300_000, () => deadline);
  await first.recover(); await vi.advanceTimersByTimeAsync(4000); await first.stop();
  expect(row.delivery).toBe("sent");
  const restarted = new Outbox(store, send, 300_000, () => deadline);
  await restarted.recover(); await vi.advanceTimersByTimeAsync(5999);
  expect(row.delivery).toBe("sent");
  await vi.advanceTimersByTimeAsync(1);
  expect(row.delivery).toBe("failed"); expect(send).not.toHaveBeenCalled();
  await restarted.stop();
});
