import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/engine/db";
import { Outbox, RESEND_POLICY, type Resender } from "../src/engine/outbox";
import type { StoredMessage } from "../src/shared/types";
// covers: chat.paired.offline-send, chat.paired.receipts, chat.dht.send

afterEach(() => vi.useRealTimers());
let serial = 0;
const WIRE = "abcdefghijklmnopqrstuv";
async function setup(send: (message: StoredMessage) => Promise<string | null>, resender?: Resender, timeout = 100) {
  const linkId = `outbox-${++serial}`, wireId = WIRE, id = `me_${wireId}`;
  await db.addMessage({ linkId, id, wireId, text: "hello", sender: "me", timestamp: 1, via: "datalink", delivery: "sending" });
  const store = { read: () => db.getMessages(linkId), update: (id: string, delivery: NonNullable<StoredMessage["delivery"]>, error?: string, extra?: Partial<Pick<StoredMessage, "via" | "resendUntil">>) => db.updateDelivery(linkId, id, delivery, error, extra) };
  return { linkId, id, wireId, store, box: new Outbox(store, send, timeout, undefined, { resender }), row: async () => (await db.getMessages(linkId))[0] };
}
/** The engine's store in memory, for the tests on fake timers (fake-indexeddb runs on real ones). */
function memory(send: (message: StoredMessage) => Promise<string | null>, resender?: Resender, timeout = 20_000) {
  const row: StoredMessage = { linkId: "memory", id: `me_${WIRE}`, wireId: WIRE, text: "hello", sender: "me", timestamp: 1, via: "datalink", delivery: "sending" };
  const store = { read: async () => [{ ...row }], update: async (_id: string, delivery: NonNullable<StoredMessage["delivery"]>, error?: string, extra?: Partial<Pick<StoredMessage, "via" | "resendUntil">>) => {
    if (row.delivery === "delivered") return;
    Object.assign(row, extra, { delivery, deliveryError: error });
  } };
  return { id: row.id, wireId: WIRE, store, box: new Outbox(store, send, timeout, undefined, { resender }), row: async () => ({ ...row }) };
}
/** A receiver that keeps what it gets the way the engine does: one row per link and message id. */
const recipient = (linkId: string) => vi.fn(async (m: StoredMessage) => {
  await db.addMessage({ ...m, linkId, id: `peer_${m.wireId}`, sender: "peer", delivery: undefined });
  return null;
});

describe("durable paired message delivery", () => {
  it("records sent separately from received and keeps receipts terminal across races", async () => {
    const p = await setup(async () => null);
    await p.box.transmit(p.id); expect((await p.row()).delivery).toBe("sent");
    await p.box.received(p.wireId);
    await Promise.all([p.store.update(p.id, "failed"), p.store.update(p.id, "sent"), p.store.update(p.id, "queued")]);
    expect((await p.row()).delivery).toBe("delivered");
    await p.box.stop();
  });
  it("keeps the same wire ID after lost receipt, engine restart and retry; receiver deduplicates", async () => {
    const receive = recipient("recipient-retry");
    const p = await setup(receive); await p.box.transmit(p.id);
    await p.box.stop();
    // Stopping leaves it queued, for the next start to send again.
    expect((await p.row()).delivery).toBe("queued");
    const restarted = new Outbox(p.store, receive, 100, undefined, { resender: { ready: () => false } });
    await restarted.recover(); expect((await p.row()).delivery).toBe("queued");
    await Promise.all([restarted.transmit(p.id, { manual: true }), restarted.transmit(p.id, { manual: true })]);
    expect(receive).toHaveBeenCalledTimes(2);
    expect(await db.getMessages("recipient-retry")).toHaveLength(1);
    await restarted.received(p.wireId); await restarted.stop();
    expect((await p.row()).delivery).toBe("delivered");
  });
  it("recovers an interrupted send as queued and never resurrects a deleted row", async () => {
    const p = await setup(async () => "Connection closed", { ready: () => false });
    await p.box.recover(); expect((await p.row()).delivery).toBe("queued");
    await p.box.transmit(p.id); expect((await p.row()).deliveryError).toBe("Connection closed");
    await db.deleteMessage(p.linkId, p.id); await p.box.received(p.wireId);
    expect(await p.row()).toBeUndefined(); await p.box.stop();
  });
  it("keeps delivery uncertain if persisting a receipt fails", async () => {
    const p = await setup(async () => null);
    const update = p.store.update;
    const box = new Outbox({ ...p.store, update: (id, state, error, extra) => state === "delivered"
      ? Promise.reject(new Error("Storage unavailable")) : update(id, state, error, extra) }, async () => null, 100, undefined, { resender: { ready: () => false } });
    await box.transmit(p.id);
    await expect(box.received(p.wireId)).rejects.toThrow("Storage unavailable");
    await box.disconnected();
    expect((await p.row()).delivery).toBe("queued");
    await box.stop();
  });
  it("does not claim delivery after a receipt timeout: it is queued, and a late receipt still counts", async () => {
    const p = await setup(async () => null, { ready: () => false });
    await p.box.transmit(p.id);
    await vi.waitFor(async () => expect((await p.row()).delivery).toBe("queued"));
    await p.box.received(p.wireId); expect((await p.row()).delivery).toBe("delivered");
    await p.box.stop();
  });
});

describe("automatic resend", () => {
  it("sends an unconfirmed message again when the link comes back, once, and the bubble goes delivered by itself", async () => {
    let live = true;
    const receive = recipient("recipient-back");
    // The first send lands in a session that is closing: nothing arrives, no receipt.
    const send = vi.fn(async (m: StoredMessage) => (send.mock.calls.length === 1 ? null : receive(m)));
    const p = await setup(send, { ready: () => live }, 60_000);
    await p.box.transmit(p.id);
    live = false; await p.box.disconnected();
    expect((await p.row())).toMatchObject({ delivery: "queued", deliveryError: "Connection closed before receipt. Delivery is unconfirmed." });
    expect((await p.row()).resendUntil).toBeGreaterThan(Date.now() + RESEND_POLICY.windowMs - 60_000);
    live = true; await p.box.flush({ reopened: true });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].wireId).toBe(p.wireId);
    expect(await db.getMessages("recipient-back")).toHaveLength(1);
    expect((await p.row()).delivery).toBe("sent");
    await p.box.received(p.wireId);
    expect((await p.row()).delivery).toBe("delivered");
    await p.box.stop();
  });

  it("sends again what went on the old link and still awaits a receipt when a new link opens", async () => {
    const send = vi.fn(async () => null);
    const p = await setup(send, { ready: () => true }, 60_000);
    await p.box.transmit(p.id);
    await p.box.flush();
    expect(send).toHaveBeenCalledTimes(1);
    await p.box.flush({ reopened: true });
    expect(send).toHaveBeenCalledTimes(2);
    await p.box.stop();
  });

  it("waits with backoff while the contact is away, and sends as soon as it can", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let live = false;
    const send = vi.fn(async () => (live ? null : "You are offline."));
    const ready = vi.fn(() => live);
    const p = memory(send, { ready }, 20_000);
    await p.box.transmit(p.id);
    expect((await p.row()).delivery).toBe("queued");
    const [first, second] = RESEND_POLICY.backoffMs;
    await vi.advanceTimersByTimeAsync(first - 1); expect(ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(ready).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(second); expect(ready).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    live = true;
    await vi.advanceTimersByTimeAsync(RESEND_POLICY.backoffMs[2]);
    expect(send).toHaveBeenCalledTimes(2);
    expect((await p.row()).delivery).toBe("sent");
    await p.box.received(p.wireId);
    await vi.advanceTimersByTimeAsync(RESEND_POLICY.windowMs);
    expect(send).toHaveBeenCalledTimes(2);
    expect((await p.row()).delivery).toBe("delivered");
    await p.box.stop();
  });

  it("keeps its backoff when the chat is looked at again in between", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const ready = vi.fn(() => false);
    const p = memory(async () => "You are offline.", { ready });
    await p.box.transmit(p.id);
    const [first, second] = RESEND_POLICY.backoffMs;
    await vi.advanceTimersByTimeAsync(first);
    // The DHT view changes every few seconds: each change looks, none pushes the next check back.
    for (let i = 0; i < 5; i++) { await vi.advanceTimersByTimeAsync(second / 5 - 1); await p.box.flush(); }
    ready.mockClear();
    await vi.advanceTimersByTimeAsync(5);
    expect(ready).toHaveBeenCalledTimes(1);
    await p.box.stop();
  });

  it("stops by itself after its attempts, keeping Retry, which starts over", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const send = vi.fn(async () => null);
    const p = memory(send, { ready: () => true }, 1_000);
    await p.box.transmit(p.id);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(send).toHaveBeenCalledTimes(RESEND_POLICY.maxAttempts);
    const row = await p.row();
    expect(row.delivery).toBe("failed");
    expect(row.deliveryError).toContain(`Sent ${RESEND_POLICY.maxAttempts} times without a receipt`);
    await p.box.transmit(p.id, { manual: true });
    expect(send).toHaveBeenCalledTimes(RESEND_POLICY.maxAttempts + 1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await p.row()).delivery).toBe("queued");
    await p.box.stop();
  });

  it("gives up after its window while the contact stays away", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const p = memory(async () => "You are offline.", { ready: () => false });
    await p.box.transmit(p.id);
    await vi.advanceTimersByTimeAsync(RESEND_POLICY.windowMs + 5 * 60_000);
    expect(await p.row()).toMatchObject({ delivery: "failed" });
    expect((await p.row()).deliveryError).toContain("Not confirmed within 7 days");
    await p.box.stop();
  });

  it("a restart after the window leaves it for Retry", async () => {
    const p = await setup(async () => null, { ready: () => false });
    await p.store.update(p.id, "queued", "Connection closed.", { resendUntil: Date.now() - 1 });
    await p.box.recover();
    expect((await p.row()).delivery).toBe("failed");
    await p.box.stop();
  });

  it("sends queued messages oldest first, and the next one when a receipt frees the DHT path", async () => {
    const linkId = `outbox-${++serial}`, sent: string[] = [];
    const ids = ["aaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbb", "cccccccccccccccccccccc"];
    for (const [i, wireId] of ids.entries())
      await db.addMessage({ linkId, id: `me_${wireId}`, wireId, text: `m${i}`, sender: "me", timestamp: 10 - i, via: "datalink", delivery: "queued" });
    const store = { read: () => db.getMessages(linkId), update: (id: string, d: NonNullable<StoredMessage["delivery"]>, e?: string, x?: Partial<Pick<StoredMessage, "via" | "resendUntil">>) => db.updateDelivery(linkId, id, d, e, x) };
    // One text awaiting its receipt at a time, as the DHT path allows.
    let awaiting: string | undefined;
    const box = new Outbox(store, async m => { awaiting = m.wireId; sent.push(m.text); return null; }, 60_000, undefined,
      { resender: { ready: m => !awaiting || awaiting === m.wireId, via: () => "pkarr" } });
    await box.recover();
    await box.flush();
    expect(sent).toEqual(["m2"]);
    expect((await db.getMessages(linkId)).find(m => m.text === "m2")?.via).toBe("pkarr");
    const next = awaiting!; awaiting = undefined;
    await box.received(next);
    await vi.waitFor(() => expect(sent).toEqual(["m2", "m1"]));
    await box.stop();
  });

  it("hands a message to store-and-forward once the contact has been away a while", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const divert = vi.fn(async () => true);
    const p = memory(async () => "You are offline.", { ready: () => false, divert });
    await p.box.transmit(p.id);
    // Checks at 5, 20 and 50 s: a reload is quicker than that, so nothing is stored for it yet.
    const [a, b, c, d] = RESEND_POLICY.backoffMs;
    await vi.advanceTimersByTimeAsync(a + b + c);
    expect(a + b + c).toBeLessThan(RESEND_POLICY.holdAfterMs);
    expect(divert).not.toHaveBeenCalled();
    // The first check past a minute away hands it over.
    await vi.advanceTimersByTimeAsync(d);
    expect(divert).toHaveBeenCalledTimes(1);
    expect(divert.mock.calls[0][0]).toMatchObject({ id: p.id, wireId: p.wireId });
    await vi.advanceTimersByTimeAsync(RESEND_POLICY.windowMs);
    expect(divert).toHaveBeenCalledTimes(1);
    await p.box.stop();
  });
});

describe("a DHT text that expired unconfirmed", () => {
  const dht = (requeueExpired: boolean) => {
    const row: StoredMessage = { linkId: "dht-expiry", id: `me_${WIRE}`, wireId: WIRE, text: "pending", sender: "me", timestamp: 1, via: "pkarr", delivery: "sending" };
    const store = { read: async () => [{ ...row }], update: async (_id: string, delivery: NonNullable<StoredMessage["delivery"]>, error?: string, extra?: Partial<Pick<StoredMessage, "via" | "resendUntil">>) => { if (row.delivery !== "delivered") Object.assign(row, extra, { delivery, deliveryError: error }); } };
    let live = false;
    const send = vi.fn(async () => null);
    const box = new Outbox(store, send, 300_000, undefined, { resender: { ready: () => live, via: () => (live ? "datalink" : "pkarr"), requeueExpired: () => requeueExpired } });
    return { row, send, box, goLive: () => { live = true; } };
  };

  it("waits for the live link in a live chat, and goes on it as soon as it opens", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const t = dht(true);
    await t.box.transmit(t.row.id);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(t.row).toMatchObject({ delivery: "queued", via: "pkarr" });
    t.goLive(); await t.box.flush({ reopened: true });
    expect(t.send).toHaveBeenCalledTimes(2);
    expect(t.row).toMatchObject({ delivery: "sent", via: "datalink" });
    await t.box.stop();
  });

  it("is final in a DHT-only chat, where Retry is the way", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const t = dht(false);
    await t.box.transmit(t.row.id);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(t.row.delivery).toBe("failed");
    await vi.advanceTimersByTimeAsync(RESEND_POLICY.windowMs);
    expect(t.send).toHaveBeenCalledTimes(1);
    await t.box.stop();
  });

  it("still awaiting its DHT receipt, goes on a link that opens meanwhile", async () => {
    const t = dht(true);
    await t.box.transmit(t.row.id);
    expect(t.row).toMatchObject({ delivery: "sent", via: "pkarr" });
    t.goLive(); await t.box.flush({ reopened: true });
    expect(t.send).toHaveBeenCalledTimes(2);
    expect(t.row.via).toBe("datalink");
    await t.box.stop();
  });
});

it("resumes a DHT receipt timer at the original deadline without retransmitting on restart", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const row: StoredMessage = { linkId: "dht-restart", id: `me_${WIRE}`, wireId: WIRE, text: "pending", sender: "me", timestamp: Date.now(), via: "pkarr", delivery: "sent" };
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
  // The DHT path retried within its own budget until expiry: that is final, and waits for Retry.
  expect(row.delivery).toBe("failed"); expect(send).not.toHaveBeenCalled();
  await restarted.stop();
});
