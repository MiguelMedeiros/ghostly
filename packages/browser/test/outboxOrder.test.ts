import { afterEach, describe, expect, it, vi } from "vitest";
import { Outbox, type Resender } from "../src/engine/outbox";
import type { StoredMessage } from "../src/shared/types";
// covers: chat.order, chat.paired.offline-send, chat.waiting

/**
 * What an outbox hands its link goes oldest first. The contact's app places a message where it arrives (WISP 400,
 * requirement 10) and no longer sorts by the time its sender says, so the order of sending is the order the contact
 * reads, for good. Seen 2026-10-02 between two apps on local relays: twelve texts written while the live session was
 * closed arrived as 0, 2, 1, 3…; thirty written while the contact's app restarted arrived with a dozen out of place;
 * on the DHT, every text written just as a receipt came went out before the two that were waiting.
 */
afterEach(() => vi.useRealTimers());

type Delivery = NonNullable<StoredMessage["delivery"]>;
const wire = (n: number) => String(n).padStart(22, "w");
const row = (n: number, delivery: Delivery, over: Partial<StoredMessage> = {}): StoredMessage =>
  ({ linkId: "order", id: `me_${wire(n)}`, wireId: wire(n), text: `m${n}`, sender: "me", timestamp: n, via: "datalink", delivery, ...over });

/** A chat's rows in memory. `slow`: ids whose next write takes a few turns of the event loop, as a write to storage may. */
function chat(rows: StoredMessage[], send: (message: StoredMessage) => Promise<string | null> = async () => null, resender: Resender = { ready: () => true }) {
  const slow = new Set<string>(), sent: string[] = [], hooks = { reads: 0, read: (_n: number) => {} };
  const store = {
    read: async () => { hooks.read(++hooks.reads); return rows.map(m => ({ ...m })); },
    update: async (id: string, delivery: Delivery, error?: string, extra?: Partial<Pick<StoredMessage, "via" | "resendUntil">>) => {
      if (slow.delete(id)) for (let i = 0; i < 20; i++) await Promise.resolve();
      const found = rows.find(m => m.id === id);
      if (found && found.delivery !== "delivered") Object.assign(found, extra, { delivery, deliveryError: error });
    },
  };
  const box = new Outbox(store, async message => { sent.push(message.text); return send(message); }, 60_000, undefined, { resender });
  return { box, rows, sent, slow, hooks, add: (message: StoredMessage) => { rows.push(message); return message.id; }, state: (n: number) => rows.find(m => m.id === `me_${wire(n)}`)?.delivery };
}

describe("a chat's messages go out in the order they were written", () => {
  it("a link that came back is looked at twice at once: each queued message goes once, oldest first", async () => {
    const c = chat([1, 2, 3, 4, 5].map(n => row(n, "queued")));
    await c.box.recover();
    // The first one's row takes a moment to write: the second look used to pass it by and send the next one first.
    c.slow.add(`me_${wire(1)}`);
    await Promise.all([c.box.flush({ reopened: true }), c.box.flush({ reopened: true }), c.box.flush()]);
    expect(c.sent).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    await c.box.stop();
  });

  it("a new message goes after the ones written before it that still wait", async () => {
    const c = chat([row(1, "waiting"), row(2, "queued")]);
    await c.box.recover();
    await c.box.transmit(c.add(row(3, "sending")));
    expect(c.sent).toEqual(["m1", "m2", "m3"]);
    expect([1, 2, 3].map(c.state)).toEqual(["sent", "sent", "sent"]);
    await c.box.stop();
  });

  it("two new messages handed over in the other order still go oldest first, once each", async () => {
    const c = chat([row(1, "sending"), row(2, "sending")]);
    await Promise.all([c.box.transmit(`me_${wire(2)}`), c.box.transmit(`me_${wire(1)}`)]);
    expect(c.sent).toEqual(["m1", "m2"]);
    await c.box.stop();
  });

  it("on the DHT, one text at a time: a text written as a receipt comes waits behind the ones before it", async () => {
    let awaiting: string | undefined;
    const c = chat([row(1, "sending")], async m => { awaiting = m.wireId; return null; }, { ready: m => !awaiting || awaiting === m.wireId, via: () => "pkarr" });
    await c.box.transmit(`me_${wire(1)}`);
    await c.box.wait(c.add(row(2, "sending")), "Waits for the text before it to be confirmed.");
    await c.box.wait(c.add(row(3, "sending")), "Waits for the text before it to be confirmed.");
    expect(c.sent).toEqual(["m1"]);
    // The path is free (the receipt was read) and a new text is written before the outbox hears of the receipt.
    awaiting = undefined;
    await c.box.transmit(c.add(row(4, "sending")));
    expect(c.sent).toEqual(["m1", "m2"]);
    // It waits its turn, without an attempt counted against it.
    expect(c.rows.find(m => m.text === "m4")).toMatchObject({ delivery: "waiting", via: "datalink" });
    for (const n of [1, 2, 3]) { awaiting = undefined; await c.box.received(wire(n)); await vi.waitFor(() => expect(c.sent).toHaveLength(n + 1)); }
    expect(c.sent).toEqual(["m1", "m2", "m3", "m4"]);
    await c.box.stop();
  });

  it("a queued message whose check comes due first does not pass an older one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let live = false;
    const c = chat([row(1, "sending")], async () => (live ? null : "You are offline."), { ready: () => live });
    await c.box.transmit(`me_${wire(1)}`);
    // Its first check finds the contact still away: the next one is 15 s on.
    await vi.advanceTimersByTimeAsync(5_000);
    await c.box.transmit(c.add(row(2, "sending")));
    expect(c.state(1)).toBe("queued");
    c.sent.length = 0;
    live = true;
    // The second one's first check comes before the first one's second.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(c.sent).toEqual(["m1", "m2"]);
    await c.box.stop();
  });

  it("a text the chat cannot carry does not hold back a later one it can", async () => {
    // On the DHT a long text waits for the live session; a short one written after it goes.
    const c = chat([row(1, "waiting", { text: "a long text, longer than the DHT carries" })], async () => null, { ready: m => m.text.length < 10 });
    await c.box.recover();
    await c.box.transmit(c.add(row(2, "sending")));
    expect(c.sent).toEqual(["m2"]);
    expect(c.state(1)).toBe("waiting");
    await c.box.stop();
  });

  it("a link that says it is open a moment before it carries text: the first messages are not left behind", async () => {
    // Seen with two apps: the look began as the session opened, found the first three not ready, and sent from the
    // fourth on; the three went at the next look, after the later ones.
    let live = false;
    const c = chat([1, 2, 3, 4, 5, 6].map(n => row(n, "waiting")), async () => null, { ready: () => live });
    await c.box.recover();
    // The link carries text from the moment the fourth message's row is read: between two steps of the same look.
    c.hooks.reads = 0;
    c.hooks.read = n => { if (n === 5) live = true; };
    await c.box.flush({ reopened: true });
    expect(c.sent).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
    await c.box.stop();
  });

  it("a text that went on the DHT and is not confirmed goes on the link before what was written after it, whichever look comes first", async () => {
    let live = false;
    const paths: string[] = [];
    const c = chat([row(1, "sending", { via: "pkarr" })], async m => { paths.push(`${m.text} ${m.via}`); return null; },
      { ready: m => live || m.text === "m1", via: () => (live ? "datalink" : "pkarr") });
    await c.box.transmit(`me_${wire(1)}`);
    await c.box.wait(c.add(row(2, "sending")), "Waits for the text before it to be confirmed.");
    await c.box.wait(c.add(row(3, "sending")), "Waits for the text before it to be confirmed.");
    // The chat goes live, and the look that is not the link's own (the DHT's state changed) comes first.
    live = true;
    await c.box.flush();
    expect(paths).toEqual(["m1 pkarr", "m1 datalink", "m2 datalink", "m3 datalink"]);
    await c.box.stop();
  });

  it("a send that never returns holds the next message back half a minute, not for good", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const c = chat([row(1, "sending"), row(2, "sending")], m => (m.text === "m1" ? new Promise<string | null>(() => {}) : Promise.resolve(null)));
    void c.box.transmit(`me_${wire(1)}`);
    void c.box.transmit(`me_${wire(2)}`);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(c.sent).toEqual(["m1"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(c.sent).toEqual(["m1", "m2"]);
    await c.box.stop();
  });
});
