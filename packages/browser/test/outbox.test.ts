import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../src/engine/db";
import { NotSent, Outbox, RESEND_POLICY, type Resender } from "../src/engine/outbox";
import type { StoredMessage } from "../src/shared/types";
// covers: chat.paired.offline-send, chat.paired.receipts, chat.dht.send, chat.waiting

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
  it("stops without reading the chat's history when nothing awaits a receipt", async () => {
    const p = await setup(async () => null);
    const read = vi.fn(p.store.read);
    const box = new Outbox({ ...p.store, read }, async () => null, 100, undefined, { resender: { ready: () => false } });
    await box.stop();
    expect(read).not.toHaveBeenCalled();
  });
  it("recovers an interrupted send as queued and never resurrects a deleted row", async () => {
    const p = await setup(async () => "Connection closed", { ready: () => false });
    await p.box.recover(); expect((await p.row()).delivery).toBe("queued");
    await p.box.transmit(p.id); expect((await p.row()).deliveryError).toBe("Connection closed");
    await db.deleteMessage(p.linkId, p.id); await p.box.received(p.wireId);
    expect(await p.row()).toBeUndefined(); await p.box.stop();
  });
  it("a start leaves a row already queued, with its reason and window, unwritten, and still checks it", async () => {
    const p = await setup(async () => null);
    const reason = "No DHT receipt before it expired. It goes again when the chat is live.", until = Date.now() + 86_400_000;
    await p.store.update(p.id, "queued", reason, { resendUntil: until });
    const update = vi.fn(p.store.update), send = vi.fn(async () => null);
    let ready = false;
    const box = new Outbox({ ...p.store, update }, send, 100, undefined, { resender: { ready: () => ready }, policy: { backoffMs: [10] } });
    await box.recover();
    // On the engine each write marks the chat's history changed, and the CLI host then reads it whole at start.
    expect(update).not.toHaveBeenCalled();
    expect((await p.row())).toMatchObject({ delivery: "queued", deliveryError: reason, resendUntil: until });
    ready = true;
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await box.stop();
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

  it("sends again on the new link a text whose DHT send was still on its way when the chat went live, and the contact keeps it once", async () => {
    // The Desktop pair of the 2026-09-30 nightly: a text goes on the DHT, and the chat goes live while that publish is
    // still out. The contact, live now, reads the DHT every 5 minutes: without a send on the link it waited that long.
    let live = false, publishing: () => void = () => {};
    const receive = recipient("recipient-race");
    const send = vi.fn(async (m: StoredMessage) => {
      if (m.via !== "pkarr") return receive(m);
      await new Promise<void>(resolve => { publishing = resolve; });
      return null;
    });
    const p = await setup(send, { ready: () => true, via: () => (live ? "datalink" : "pkarr") }, 60_000);
    const first = p.box.transmit(p.id);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0].via).toBe("pkarr");
    live = true; const reopened = p.box.flush({ reopened: true });
    // Once the publish returns, the text goes again, on the link.
    publishing(); await first; await reopened;
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toMatchObject({ via: "datalink", wireId: p.wireId });
    expect((await p.row())).toMatchObject({ delivery: "sent", via: "datalink" });
    // The DHT copy read later is the same message: the contact keeps one.
    await receive({ ...(await p.row()), via: "pkarr" });
    expect(await db.getMessages("recipient-race")).toHaveLength(1);
    await p.box.received(p.wireId);
    expect((await p.row()).delivery).toBe("delivered");
    await p.box.stop();
  });

  it("does not send twice a text in flight when the chat reopens and it is confirmed before its send returns", async () => {
    let publishing: () => void = () => {};
    const send = vi.fn(async () => { await new Promise<void>(resolve => { publishing = resolve; }); return null; });
    const p = await setup(send, { ready: () => true }, 60_000);
    const first = p.box.transmit(p.id);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const reopened = p.box.flush({ reopened: true });
    await p.box.received(p.wireId);
    publishing(); await first; await reopened;
    expect(send).toHaveBeenCalledTimes(1);
    expect((await p.row()).delivery).toBe("delivered");
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
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

describe("a DHT receipt deadline stamped by a clock that later went back", () => {
  const TTL = 5 * 60_000, DAY = 24 * 60 * 60_000;
  /** A DHT-only chat's text `sent`, its stored deadline `ahead` ms from now, restarted with a receipt window of `TTL`. */
  const restart = async (ahead: number) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const row: StoredMessage = { linkId: "dht-clock", id: `me_${WIRE}`, wireId: WIRE, text: "pending", sender: "me", timestamp: Date.now(), via: "pkarr", delivery: "sent" };
    const send = vi.fn(async () => null);
    const store = { read: async () => [{ ...row }], get: async () => ({ ...row }), update: async (_id: string, delivery: NonNullable<StoredMessage["delivery"]>, error?: string) => { row.delivery = delivery; row.deliveryError = error; } };
    const deadline = Date.now() + ahead;
    const box = new Outbox(store, send, TTL, () => deadline, { resender: { ready: () => false, via: () => "pkarr", requeueExpired: () => false } });
    await box.recover();
    return { row, send, box };
  };

  it("leaves 'sent' one receipt window after the restart, not an hour later", async () => {
    const t = await restart(60 * 60_000 + 4 * 60_000);
    await vi.advanceTimersByTimeAsync(TTL - 1);
    expect(t.row.delivery).toBe("sent");
    await vi.advanceTimersByTimeAsync(1);
    expect(t.row.delivery).toBe("failed");
    expect(t.row.deliveryError).toContain("No DHT receipt before it expired.");
    expect(t.send).not.toHaveBeenCalled();
    await t.box.stop();
  });

  it("past the timer's 32-bit limit, does not fail at once while the DHT still publishes it", async () => {
    const t = await restart(30 * DAY);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.row.delivery).toBe("sent");
    await vi.advanceTimersByTimeAsync(TTL - 1_000);
    expect(t.row.delivery).toBe("failed");
    expect(t.send).not.toHaveBeenCalled();
    await t.box.stop();
  });

  it("keeps a deadline within the window as it was", async () => {
    const t = await restart(4 * 60_000);
    await vi.advanceTimersByTimeAsync(4 * 60_000 - 1);
    expect(t.row.delivery).toBe("sent");
    await vi.advanceTimersByTimeAsync(1);
    expect(t.row.delivery).toBe("failed");
    await t.box.stop();
  });
});

it("a receipt timeout past the timer's 32-bit limit waits instead of firing at once", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const p = memory(async () => null, { ready: () => true }, 30 * 24 * 60 * 60_000);
  await p.box.transmit(p.id);
  await vi.advanceTimersByTimeAsync(60_000);
  expect((await p.row()).delivery).toBe("sent");
  await p.box.stop();
});

describe("what waits for the chat to carry it (WISP 400, \"Sends when live\")", () => {
  it("is kept as waiting, sent once when the chat can carry it, counting no attempt before", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let ready = false;
    const send = vi.fn(async () => null);
    const m = memory(send, { ready: () => ready });
    await m.box.wait(m.id, "Waits for the text before it to be confirmed.");
    expect(await m.row()).toMatchObject({ delivery: "waiting", deliveryError: "Waits for the text before it to be confirmed." });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(send, "nothing carries it: not sent, not failed").not.toHaveBeenCalled();
    expect((await m.row()).delivery).toBe("waiting");
    ready = true;
    await m.box.flush();
    expect(send).toHaveBeenCalledOnce();
    expect((await m.row()).delivery).toBe("sent");
    await m.box.stop();
  });

  it("survives a restart as waiting, and fails without claiming the contact may have it when the week passes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const send = vi.fn(async () => null);
    const m = memory(send, { ready: () => false });
    await m.box.wait(m.id, "Sent when your contact is reachable.");
    await m.box.stop();
    const again = new Outbox(m.store, send, 20_000, undefined, { resender: { ready: () => false } });
    await again.recover();
    expect((await m.row()).delivery).toBe("waiting");
    await vi.advanceTimersByTimeAsync(RESEND_POLICY.windowMs + 10 * 60_000);
    expect(await m.row()).toMatchObject({ delivery: "failed", deliveryError: expect.stringContaining("It was not sent") });
    expect((await m.row()).deliveryError).not.toContain("may have received");
    expect(send).not.toHaveBeenCalled();
    await again.stop();
  });
});

// agents#1693: each turn's 30 s escape (TURN_MS) was armed when the turn was queued, not when it began. Behind one slow
// turn, every turn queued before its 30th second then started at once: a link drop with hundreds of texts awaiting
// receipts ran 45 whole-chat reads together, and the daemon's heap went past 1 GB (the contact's died at 4 GB).
describe("turns behind a slow one", () => {
  /** `n` texts sent at once into a chat whose every read of its history takes `readMs`; the most reads at a time. */
  async function burst(n: number, readMs: number) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const rows: StoredMessage[] = Array.from({ length: n }, (_, i) => {
      const wireId = `t${String(i).padStart(21, "0")}`;
      return { linkId: "turns", id: `me_${wireId}`, wireId, text: `m${i}`, sender: "me", timestamp: i + 1, via: "datalink", delivery: "sending" };
    });
    let reading = 0, most = 0, reads = 0;
    const read = async () => {
      reading++; reads++; most = Math.max(most, reading);
      await new Promise(done => setTimeout(done, readMs));
      reading--;
      return rows.map(row => ({ ...row }));
    };
    const store = { read, update: async (id: string, delivery: NonNullable<StoredMessage["delivery"]>, error?: string) => {
      const row = rows.find(r => r.id === id);
      if (row && row.delivery !== "delivered") Object.assign(row, { delivery, deliveryError: error });
    } };
    // Receipts are awaited for a day: only the sends' own turns run here.
    const box = new Outbox(store, async () => null, 86_400_000, undefined, { resender: { ready: () => true } });
    const sends = rows.map(row => box.transmit(row.id));
    await vi.advanceTimersByTimeAsync(n * (readMs + 1_000) + 60_000);
    await Promise.all(sends);
    return { most, reads };
  }

  it("a turn that outlives its 30 s lets one more start, not every turn queued behind it", async () => {
    const { most, reads } = await burst(40, 35_000);
    expect(reads).toBeGreaterThanOrEqual(40);
    expect(most).toBeLessThanOrEqual(2);
  }, 30_000);

  it("turns shorter than 30 s run one at a time", async () => {
    const { most } = await burst(40, 1_000);
    expect(most).toBe(1);
  }, 30_000);
});

describe("a chat with many queued messages and the contact away", () => {
  /** `n` queued DHT texts in a store that counts its reads of the whole chat, on fake timers; `ready`: whether the chat can carry text. */
  async function many(n: number, ready: boolean) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const rows: StoredMessage[] = Array.from({ length: n }, (_, i) => {
      const wireId = `w${String(i).padStart(21, "0")}`;
      return { linkId: "many", id: `me_${wireId}`, wireId, text: `m${i}`, sender: "me", timestamp: i + 1, via: "pkarr", delivery: "queued" };
    });
    const read = vi.fn(async () => rows.map(row => ({ ...row })));
    const get = vi.fn(async (id: string) => { const row = rows.find(r => r.id === id); return row && { ...row }; });
    const store = { read, get, update: async (id: string, delivery: NonNullable<StoredMessage["delivery"]>, error?: string, extra?: Partial<Pick<StoredMessage, "via" | "resendUntil">>) => {
      const row = rows.find(r => r.id === id);
      if (row && row.delivery !== "delivered") Object.assign(row, extra, { delivery, deliveryError: error });
    } };
    const send = vi.fn(async () => null);
    const box = new Outbox(store, send, 20_000, undefined, { resender: { ready: () => ready } });
    await box.recover();
    return { rows, read, get, send, box };
  }

  it("reads the chat's history once per check, not once per older message it looks at", async () => {
    const n = 60, { rows, read, send, box } = await many(n, false);
    read.mockClear();
    // Every queued message's first check comes due: each looks at the ones written before it.
    await vi.advanceTimersByTimeAsync(RESEND_POLICY.backoffMs[0]);
    expect(send).not.toHaveBeenCalled();
    expect(rows.every(r => r.delivery === "queued")).toBe(true);
    expect(read.mock.calls.length, "a whole-history read per check, not per message looked at").toBeLessThanOrEqual(n);
    await box.stop();
  });

  it("waiting for an away contact costs one look at the chat per backoff step, not one read per pair of texts", async () => {
    const n = 300, { rows, read, get, send, box } = await many(n, false);
    // Every step of the backoff, then two more of its last one.
    for (const step of [...RESEND_POLICY.backoffMs, 300_000, 300_000]) {
      read.mockClear();
      get.mockClear();
      await vi.advanceTimersByTimeAsync(step);
      expect(send).not.toHaveBeenCalled();
      expect(read.mock.calls.length, `whole-chat reads after ${step} ms`).toBeLessThanOrEqual(1);
      expect(get.mock.calls.length, `one-message reads after ${step} ms`).toBe(0);
    }
    expect(rows.every(r => r.delivery === "queued")).toBe(true);
    await box.stop();
  });

  it("texts written one after the other to an away contact share their checks from the first backoff step on", async () => {
    const { rows, read, get, send, box } = await many(0, false);
    for (let i = 0; i < 300; i++) {
      const wireId = `w${String(i).padStart(21, "0")}`;
      // As the engine keeps a text the chat cannot carry now.
      rows.push({ linkId: "many", id: `me_${wireId}`, wireId, text: `m${i}`, sender: "me", timestamp: Date.now(), via: "datalink", delivery: "waiting" });
      await box.wait(`me_${wireId}`, "Sent when your contact is reachable.");
      // As a bot writes them over the socket, a few milliseconds apart.
      await vi.advanceTimersByTimeAsync(9);
    }
    expect(rows.every(r => r.delivery === "waiting")).toBe(true);
    for (const step of RESEND_POLICY.backoffMs) {
      read.mockClear();
      get.mockClear();
      await vi.advanceTimersByTimeAsync(step);
      expect(read.mock.calls.length + get.mock.calls.length, `store reads after ${step} ms`).toBeLessThanOrEqual(1);
    }
    expect(send).not.toHaveBeenCalled();
    await box.stop();
  });

  it("a text written while hundreds wait for the away contact does not read each of them again", async () => {
    const n = 300, { rows, read, get, send, box } = await many(n, false);
    const wireId = `w${String(n).padStart(21, "0")}`;
    rows.push({ linkId: "many", id: `me_${wireId}`, wireId, text: "new", sender: "me", timestamp: n + 1, via: "pkarr", delivery: "sending" });
    read.mockClear();
    get.mockClear();
    await box.transmit(`me_${wireId}`);
    expect(send).not.toHaveBeenCalled();
    expect(rows[n].delivery,"it waits behind the older ones").toBe("waiting");
    expect(read.mock.calls.length + get.mock.calls.length, "store reads for one new text").toBeLessThanOrEqual(2);
    await box.stop();
  });

  it("the oldest goes first once the chat can carry text again, after rounds of waiting", async () => {
    let ready = false;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const rows: StoredMessage[] = Array.from({ length: 20 }, (_, i) => {
      const wireId = `w${String(i).padStart(21, "0")}`;
      return { linkId: "many", id: `me_${wireId}`, wireId, text: `m${i}`, sender: "me", timestamp: i + 1, via: "pkarr", delivery: "queued" };
    });
    const store = { read: async () => rows.map(row => ({ ...row })), get: async (id: string) => { const row = rows.find(r => r.id === id); return row && { ...row }; },
      update: async (id: string, delivery: NonNullable<StoredMessage["delivery"]>, error?: string, extra?: Partial<Pick<StoredMessage, "via" | "resendUntil">>) => {
        const row = rows.find(r => r.id === id);
        if (row && row.delivery !== "delivered") Object.assign(row, extra, { delivery, deliveryError: error });
      } };
    const sent: string[] = [];
    const box = new Outbox(store, async m => { sent.push(m.text!); return null; }, 20_000, undefined, { resender: { ready: () => ready } });
    await box.recover();
    await vi.advanceTimersByTimeAsync(RESEND_POLICY.backoffMs[0] + RESEND_POLICY.backoffMs[1]);
    ready = true;
    // No flush: the next backoff step finds the chat able to carry them.
    await vi.advanceTimersByTimeAsync(RESEND_POLICY.backoffMs[2]);
    expect(sent).toEqual(rows.map(r => r.text));
    await box.stop();
  });

  it("a receipt for each of many messages sent on a link that came back does not read the history again", async () => {
    const n = 60, { rows, read, send, box } = await many(n, true);
    // The link comes back and every queued message goes on it.
    await box.flush({ reopened: true });
    expect(send).toHaveBeenCalledTimes(n);
    read.mockClear();
    // Each receipt arrives. Nothing is left to send, so none of them reads the chat's whole history again.
    for (const row of rows) await box.received(row.wireId);
    expect(rows.every(r => r.delivery === "delivered")).toBe(true);
    expect(read.mock.calls.length, "a receipt must not read the chat's history once there is nothing left to send").toBe(0);
    await box.stop();
  });

  it("a contact back to hundreds of waiting texts: the receipts that come during the catch-up do not each read the history again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let ready = false;
    const n = 200, rows: StoredMessage[] = Array.from({ length: n }, (_, i) => {
      const wireId = `w${String(i).padStart(21, "0")}`;
      return { linkId: "many", id: `me_${wireId}`, wireId, text: `m${i}`, sender: "me", timestamp: i + 1, via: "datalink", delivery: "waiting" };
    });
    // Each store call takes a moment, as an IndexedDB transaction does: the look spans the receipts.
    const tick = () => new Promise(resolve => setTimeout(resolve, 1));
    const read = vi.fn(async () => { await tick(); return rows.map(row => ({ ...row })); });
    const store = { read, get: async (id: string) => { await tick(); const row = rows.find(r => r.id === id); return row && { ...row }; },
      update: async (id: string, delivery: NonNullable<StoredMessage["delivery"]>, error?: string, extra?: Partial<Pick<StoredMessage, "via" | "resendUntil">>) => {
        await tick();
        const row = rows.find(r => r.id === id);
        if (row && row.delivery !== "delivered") Object.assign(row, extra, { delivery, deliveryError: error });
      } };
    // The contact's receipt comes back a moment after each send, while the look goes on.
    const send = vi.fn(async (m: StoredMessage) => { setTimeout(() => void box.received(m.wireId!), 2); return null; });
    const box = new Outbox(store, send, 20_000, undefined, { resender: { ready: () => ready } });
    const recovered = box.recover();
    await vi.advanceTimersByTimeAsync(10);
    await recovered;
    read.mockClear();
    ready = true;
    void box.flush({ reopened: true });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(rows.every(r => r.delivery === "delivered")).toBe(true);
    expect(send).toHaveBeenCalledTimes(n);
    expect(read.mock.calls.length, "whole-chat reads for the whole catch-up").toBeLessThanOrEqual(3);
    const stopped = box.stop();
    await vi.advanceTimersByTimeAsync(10);
    await stopped;
  });

  it("a contact back just before the first check: the checks that come due during the catch-up read nothing for texts already delivered", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let ready = false;
    const n = 60, rows: StoredMessage[] = Array.from({ length: n }, (_, i) => {
      const wireId = `w${String(i).padStart(21, "0")}`;
      return { linkId: "many", id: `me_${wireId}`, wireId, text: `m${i}`, sender: "me", timestamp: i + 1, via: "datalink", delivery: "waiting" };
    });
    // Each store call takes as long as an IndexedDB transaction on a long chat: the catch-up spans the first check.
    const tick = () => new Promise(resolve => setTimeout(resolve, 10));
    const read = vi.fn(async () => { await tick(); return rows.map(row => ({ ...row })); });
    const store = { read, get: async (id: string) => { await tick(); const row = rows.find(r => r.id === id); return row && { ...row }; },
      update: async (id: string, delivery: NonNullable<StoredMessage["delivery"]>, error?: string, extra?: Partial<Pick<StoredMessage, "via" | "resendUntil">>) => {
        await tick();
        const row = rows.find(r => r.id === id);
        if (row && row.delivery !== "delivered") Object.assign(row, extra, { delivery, deliveryError: error });
      } };
    const send = vi.fn(async (m: StoredMessage) => { setTimeout(() => void box.received(m.wireId!), 2); return null; });
    const box = new Outbox(store, send, 20_000, undefined, { resender: { ready: () => ready } });
    const recovered = box.recover(rows.map(row => ({ ...row })));
    await vi.advanceTimersByTimeAsync(10);
    await recovered;
    // The contact comes back half a second before each text's first check.
    await vi.advanceTimersByTimeAsync(RESEND_POLICY.backoffMs[0] - 500);
    read.mockClear();
    ready = true;
    void box.flush({ reopened: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rows.every(r => r.delivery === "delivered")).toBe(true);
    expect(send).toHaveBeenCalledTimes(n);
    expect(read.mock.calls.length, "whole-chat reads for the whole catch-up").toBeLessThanOrEqual(2);
    const stopped = box.stop();
    await vi.advanceTimersByTimeAsync(10);
    await stopped;
  });
});

describe("a session that opens (agents#2468)", () => {
  /** A chat of `history` rows of the contact's and these of mine, in a store that counts its reads; `ready`: the chat carries text. */
  function chat(mine: Partial<StoredMessage>[], history = 500, ready = () => true) {
    const rows: StoredMessage[] = Array.from({ length: history }, (_, i) => ({ linkId: "open", id: `peer_${i}`, text: `p${i}`, sender: "peer", timestamp: i + 1, via: "datalink" }));
    mine.forEach((fields, i) => {
      const wireId = `m${String(i).padStart(21, "0")}`;
      rows.push({ linkId: "open", id: `me_${wireId}`, wireId, text: `m${i}`, sender: "me", timestamp: history + i + 1, via: "datalink", delivery: "delivered", ...fields });
    });
    const read = vi.fn(async () => rows.map(row => ({ ...row })));
    const get = vi.fn(async (id: string) => { const row = rows.find(r => r.id === id); return row && { ...row }; });
    const store = { read, get, update: async (id: string, delivery: NonNullable<StoredMessage["delivery"]>, error?: string, extra?: Partial<Pick<StoredMessage, "via" | "resendUntil">>) => {
      const row = rows.find(r => r.id === id);
      if (row && row.delivery !== "delivered") Object.assign(row, extra, { delivery, deliveryError: error });
    } };
    const sent: string[] = [];
    const box = new Outbox(store, async m => { sent.push(m.text); return null; }, 20_000, undefined, { resender: { ready } });
    return { rows, read, get, sent, box, store };
  }
  /** The link says it is open, then which transport it settled on: two reopened looks. */
  const opens = async (box: Outbox) => { await Promise.all([box.flush({ reopened: true }), box.flush({ reopened: true })]); };

  it("with nothing to send again, reads nothing of the chat, after the start's look", async () => {
    const { read, get, sent, box } = chat([{}, {}]);
    // The start hands its read of the chat in, as the engine's does.
    await box.recover(await read());
    read.mockClear();
    for (let n = 0; n < 3; n++) await opens(box);
    expect([read.mock.calls.length, get.mock.calls.length, sent]).toEqual([0, 0, []]);
    await box.stop();
  });

  it("an outbox made without a start's look reads the history at its first look, and not again once it holds what that found", async () => {
    const { read, sent, box } = chat([{ delivery: "queued" }]);
    await box.flush({ reopened: true });
    expect([read.mock.calls.length, sent]).toEqual([1, ["m0"]]);
    // It awaits that one's receipt now: the next look reads it alone, and finds the chat holds nothing else.
    await box.flush({ reopened: true });
    await box.received("m".padEnd(22, "0"));
    await opens(box);
    expect([read.mock.calls.length, sent]).toEqual([2, ["m0", "m0"]]);
    await box.stop();
  });

  it("what was queued, waited or awaited its receipt at the start goes at the session, read by its id", async () => {
    let live = false;
    const { rows, read, get, sent, box } = chat([{ delivery: "queued" }, { delivery: "waiting" }, { delivery: "sent" }, {}], 500, () => live);
    await box.recover(await read());
    read.mockClear();
    live = true;
    await opens(box);
    expect([sent, read.mock.calls.length]).toEqual([["m0", "m1", "m2"], 0]);
    expect(new Set(get.mock.calls.map(([id]) => id))).toEqual(new Set(rows.filter(r => r.sender === "me" && r.text !== "m3").map(r => r.id)));
    await box.stop();
  });

  it("a text awaiting its receipt goes again on the new link, and a file stored by someone else is found by one look at the chat", async () => {
    const { rows, read, sent, box } = chat([]);
    await box.recover(await read());
    read.mockClear();
    rows.push({ linkId: "open", id: "me_w", wireId: "w".repeat(22), text: "awaiting", sender: "me", timestamp: 9_000, via: "datalink", delivery: "sending" });
    await box.transmit("me_w");
    // Once on the new link, however many ways the link says it is open.
    await opens(box);
    expect([sent, read.mock.calls.length]).toEqual([["awaiting", "awaiting"], 0]);
    // A row written by someone else (a file waiting for the live link, `storing`): the next look reads the chat once.
    await box.storing(Promise.resolve());
    await opens(box);
    expect(read.mock.calls.length).toBe(1);
    await opens(box);
    expect(read.mock.calls.length).toBe(1);
    await box.stop();
  });

  it("a text marked waiting while a session's look reads the chat goes with that session, not at its first check", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { rows, read, store, sent, box } = chat([]);
    await box.recover(await read());
    rows.push({ linkId: "open", id: "me_x", wireId: "x".repeat(22), text: "later", sender: "me", timestamp: 9_000, via: "datalink", delivery: "waiting" });
    // Its mark takes a moment, as an IndexedDB write does; the session opens meanwhile.
    const update = store.update;
    store.update = async (...args) => { await new Promise(resolve => setTimeout(resolve, 50)); return update(...args); };
    try {
      const waiting = box.wait("me_x", "Sent when your contact is reachable.");
      await vi.advanceTimersByTimeAsync(10);
      const opened = opens(box);
      await vi.advanceTimersByTimeAsync(300);
      await Promise.all([opened, waiting]);
      expect(sent, "well before its first check").toEqual(["later"]);
    } finally {
      store.update = update;
      await box.stop();
    }
  });
});

describe("texts written behind one no relay took", () => {
  /**
   * A DHT chat whose relays refuse every publication (`NotSent`), in a store that counts the rows it reads, one by one
   * or in one go; `taken`: the relays take them now.
   */
  function refused() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const rows: StoredMessage[] = [];
    const reads = { rows: 0, whole: 0 };
    const store = {
      read: async () => { reads.whole++; return rows.map(row => ({ ...row })); },
      get: async (id: string) => { reads.rows++; const row = rows.find(r => r.id === id); return row && { ...row }; },
      getMany: async (ids: string[]) => { reads.rows += ids.length; return ids.map(id => { const row = rows.find(r => r.id === id); return row && { ...row }; }); },
      update: async (id: string, delivery: NonNullable<StoredMessage["delivery"]>, error?: string, extra?: Partial<Pick<StoredMessage, "via" | "resendUntil">>) => {
        const row = rows.find(r => r.id === id);
        if (row && row.delivery !== "delivered") Object.assign(row, extra, { delivery, deliveryError: error });
      },
    };
    const relays = { taken: false };
    const sent: string[] = [];
    const send = vi.fn(async (m: StoredMessage) => {
      if (!relays.taken) return new NotSent("Publish failed on every relay.");
      sent.push(m.text);
      setTimeout(() => void box.received(m.wireId!), 1);
      return null;
    });
    // The DHT path, free: the floor holds nothing, since nothing left this device.
    const box = new Outbox(store, send, 20_000, undefined, { resender: { ready: () => true, via: () => "pkarr" } });
    const write = async (i: number) => {
      const wireId = `w${String(i).padStart(21, "0")}`;
      rows.push({ linkId: "refused", id: `me_${wireId}`, wireId, text: `m${i}`, sender: "me", timestamp: Date.now(), via: "pkarr", delivery: "sending" });
      await box.transmit(`me_${wireId}`);
    };
    return { rows, reads, relays, sent, send, box, write };
  }

  it("a new text costs a few row reads however many wait, an idle minute about one look, and they all go in order once a relay takes them", async () => {
    const { rows, reads, relays, sent, send, box, write } = refused();
    await write(0);
    expect(rows[0].delivery).toBe("waiting");
    const perSend: number[] = [];
    for (let i = 1; i < 200; i++) {
      const before = reads.rows + reads.whole;
      await write(i);
      perSend.push(reads.rows + reads.whole - before);
      // As a person writes them, a moment apart.
      await vi.advanceTimersByTimeAsync(9);
    }
    expect(rows.every(r => r.delivery === "waiting"), "all wait behind the first").toBe(true);
    // Each new text read again every text already waiting, about 4 times: 780 reads per send at 200 waiting.
    expect(Math.max(...perSend.slice(-50)), "row reads for one new text with ~200 waiting").toBeLessThanOrEqual(8);
    // Left alone: each check walked every waiting text again the same way, about 4,500 row reads a minute.
    await vi.advanceTimersByTimeAsync(RESEND_POLICY.backoffMs.slice(0, 3).reduce((a, b) => a + b));
    const attempts = send.mock.calls.length;
    reads.rows = reads.whole = 0;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reads.rows / 2, "row reads per idle minute").toBeLessThanOrEqual(20);
    expect(reads.whole / 2, "whole-chat reads per idle minute").toBeLessThanOrEqual(2);
    // Only the first is published again, at its own checks.
    expect(send.mock.calls.slice(attempts).every(([m]) => m.text === "m0")).toBe(true);
    relays.taken = true;
    await vi.advanceTimersByTimeAsync(RESEND_POLICY.backoffMs.at(-1)!);
    expect(sent).toEqual(rows.map(r => r.text));
    expect(rows.every(r => r.delivery === "delivered")).toBe(true);
    await box.stop();
  });
});
