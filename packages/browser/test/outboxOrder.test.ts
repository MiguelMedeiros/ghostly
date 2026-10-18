import { afterEach, describe, expect, it, vi } from "vitest";
import { Outbox, RESEND_POLICY, type Resender } from "../src/engine/outbox";
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
function chat(rows: StoredMessage[], send: (message: StoredMessage) => Promise<string | null> = async () => null, resender: Resender = { ready: () => true }, timeout: number | ((message: StoredMessage) => number) = 60_000) {
  const slow = new Set<string>(), sent: string[] = [], hooks = { reads: 0, read: (_n: number) => {} };
  const store = {
    read: async () => { hooks.read(++hooks.reads); return rows.map(m => ({ ...m })); },
    update: async (id: string, delivery: Delivery, error?: string, extra?: Partial<Pick<StoredMessage, "via" | "resendUntil">>) => {
      if (slow.delete(id)) for (let i = 0; i < 20; i++) await Promise.resolve();
      const found = rows.find(m => m.id === id);
      if (found && found.delivery !== "delivered") Object.assign(found, extra, { delivery, deliveryError: error });
    },
  };
  const box = new Outbox(store, async message => { sent.push(message.text); return send(message); }, timeout, undefined, { resender });
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
    let live = false, looking = false;
    // The link carries text from the moment the fourth message is looked at: between two steps of the same look.
    const c = chat([1, 2, 3, 4, 5, 6].map(n => row(n, "waiting")), async () => null, { ready: m => { if (looking && m.text === "m4") live = true; return live; } });
    await c.box.recover();
    looking = true;
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

/**
 * Seen 2026-10-02, two daemons on local relays, 200 texts while the contact's app was killed and started again: the
 * link stayed open 18 s after the kill, so 140 texts were sent on it and awaited a receipt. It closed and was back
 * 600 ms later, while those were still being queued again one by one. The look the new link asked for found half of
 * them neither awaiting a receipt nor queued, passed them by, and the contact read 167, 169, 171… before 89.
 */
describe("a link that drops with messages unconfirmed", () => {
  const sentOnce = async (c: ReturnType<typeof chat>, ns: number[]) => {
    for (const n of ns) await c.box.transmit(`me_${wire(n)}`);
    expect(ns.map(c.state)).toEqual(ns.map(() => "sent"));
    c.sent.length = 0;
  };

  it("and is back before they are all queued again: they go on the new link oldest first", async () => {
    const ns = [1, 2, 3, 4, 5, 6];
    const c = chat(ns.map(n => row(n, "sending")));
    await sentOnce(c, ns);
    // Queuing the first ones again takes a moment (a write to storage), and the link is back meanwhile.
    for (const n of [1, 2, 3]) c.slow.add(`me_${wire(n)}`);
    const closed = c.box.disconnected();
    await Promise.all([closed, c.box.flush({ reopened: true })]);
    expect(c.sent).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
    await c.box.stop();
  });

  it("while a look is half way: what it sent on the old link goes again before the rest goes on the new one", async () => {
    const ns = [1, 2, 3, 4];
    let dropAt: string | undefined = "m2";
    const c = chat(ns.map(n => row(n, "queued")), async m => {
      // The second one is on its way when the link closes, and a new link is there at once.
      if (m.text === dropAt) { dropAt = undefined; void c.box.disconnected(); void c.box.flush({ reopened: true }); }
      return null;
    });
    await c.box.recover();
    await c.box.flush({ reopened: true });
    await c.box.flush();
    // On the old link 1 and 2 (lost with it); on the new one all four, in order. Not 3 and 4 before 1 and 2.
    expect(c.sent).toEqual(["m1", "m2", "m1", "m2", "m3", "m4"]);
    await c.box.stop();
  });

  it("a new message written as the link closes under the look before it waits its turn", async () => {
    const c = chat([row(1, "queued"), row(2, "queued")], async m => {
      if (m.text === "m1" && c.sent.length === 1) void c.box.disconnected();
      return null;
    });
    await c.box.recover();
    await c.box.transmit(c.add(row(3, "sending")));
    // The first went on the link that closed; neither the second nor the new one goes past it.
    expect(c.sent).toEqual(["m1"]);
    expect(c.state(3)).toBe("waiting");
    await c.box.flush({ reopened: true });
    expect(c.sent).toEqual(["m1", "m1", "m2", "m3"]);
    await c.box.stop();
  });

  it("a receipt that runs out while the chat is looked at: the message goes again in its place", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const ns = [1, 2, 3];
    const c = chat(ns.map(n => row(n, "sending")), async () => null, { ready: () => true }, m => (m.text === "m1" ? 1_000 : 60_000));
    await sentOnce(c, ns);
    // Its receipt runs out, queuing it again takes a moment, and the link comes back in that moment.
    c.slow.add(`me_${wire(1)}`);
    vi.advanceTimersByTime(1_000);
    await c.box.flush({ reopened: true });
    expect(c.sent).toEqual(["m1", "m2", "m3"]);
    await c.box.stop();
  });
});

/**
 * Seen 2026-10-02, two daemons on local relays: a text, a file, a text, a voice note and a text written while the
 * contact was away, all waiting for the live link. The texts went through the outbox and the files by themselves
 * when the link came back, and the contact read the text, the file, the voice note, then the two other texts.
 */
describe("a file that waits for the live link goes in its place among the texts", () => {
  const file = (n: number): StoredMessage => ({ linkId: "order", id: `me_${n}`, text: `f${n}`, sender: "me", timestamp: n, via: "datalink", delivery: "waiting",
    file: { id: `order-out-${n}`, name: `f${n}.bin`, size: 10, mime: "application/octet-stream" } });
  /** A link that carries files as it carries text; `said` is the order everything went in. */
  function withFiles(rows: StoredMessage[], live = { open: true }, offer: (message: StoredMessage) => Promise<void> = async () => {}) {
    const said: string[] = [];
    const c = chat(rows, async m => { said.push(m.text); return null; }, {
      ready: () => live.open,
      sendFile: async message => { await offer(message); said.push(message.text); const row = rows.find(m => m.id === message.id)!; delete row.delivery; },
    });
    return { ...c, said };
  }

  it("texts and files written while away go in the order they were written", async () => {
    const c = withFiles([row(1, "waiting"), file(2), row(3, "waiting"), file(4), row(5, "waiting")]);
    await c.box.recover();
    await c.box.flush({ reopened: true });
    expect(c.said).toEqual(["m1", "f2", "m3", "f4", "m5"]);
    // Each once: a second look finds nothing left.
    await c.box.flush({ reopened: true });
    expect(c.said.filter(t => t.startsWith("f"))).toEqual(["f2", "f4"]);
    await c.box.stop();
  });

  it("a text written after a file waits for the file to be said, not for more", async () => {
    let offered = () => {};
    const c = withFiles([file(1), row(2, "waiting")], { open: true }, () => new Promise<void>(resolve => { offered = resolve; }));
    await c.box.recover();
    const look = c.box.flush({ reopened: true });
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(c.said).toEqual([]);
    offered();
    await look;
    expect(c.said).toEqual(["f1", "m2"]);
    await c.box.stop();
  });

  it("a new text written while live goes after a file that still waits", async () => {
    const c = withFiles([file(1)]);
    await c.box.transmit(c.add(row(2, "sending")));
    expect(c.said).toEqual(["f1", "m2"]);
    await c.box.stop();
  });

  it("a link that cannot carry it yet: the file is asked again by itself, and stays in its place", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const live = { open: false };
    const c = withFiles([file(1), row(2, "waiting")], live);
    await c.box.recover();
    await c.box.flush({ reopened: true });
    expect(c.said).toEqual([]);
    live.open = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(c.said).toEqual(["f1", "m2"]);
    await c.box.stop();
  });

  it("a link that closes under the look its own check asked for: the file is asked again by itself, not only by the next look", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const said: string[] = [];
    let asked = 0, drops = 1;
    // The file's check comes due first. The link says it is open a moment before it carries text, so the text before
    // the file is passed by, then goes as the file is found able to go, and the link closes under that send.
    const c = chat([file(2), row(1, "queued")], async m => { said.push(m.text); if (drops-- > 0) void c.box.disconnected(); return null; }, {
      ready: m => !!m.file || asked++ > 0,
      sendFile: async message => { said.push(message.text); delete c.rows.find(m => m.id === message.id)!.delivery; },
    });
    await c.box.recover();
    await vi.advanceTimersByTimeAsync(RESEND_POLICY.backoffMs[0]);
    expect(said[0]).toBe("m1");
    expect(c.rows[0].delivery).toBe("waiting");
    // No look since reaches the file (the text's own check reads up to its timestamp): the file's own check sends it
    // once the link is back, as the text's sends the text.
    await vi.advanceTimersByTimeAsync(RESEND_POLICY.backoffMs[1] * 2);
    expect(said.filter(t => t.startsWith("f"))).toEqual(["f2"]);
    expect(c.rows[0].delivery).toBeUndefined();
    await c.box.stop();
  });

  it("an outbox given no way to send files leaves them alone", async () => {
    const c = chat([file(1), row(2, "waiting")]);
    await c.box.recover();
    await c.box.flush({ reopened: true });
    expect(c.sent).toEqual(["m2"]);
    await c.box.stop();
  });
});

/**
 * Seen in 1 of 3 runs on local relays after #1131: a short text written after a file reached the contact first, on the
 * DHT floor, while the file waited for the live link. A file's offer now goes on the floor too (WISP 403 § Files), in
 * the floor's one slot and in its place, so the contact's chat shows text, file, text; its bytes go once live.
 */
describe("while the contact is away, a file's offer takes its place on the DHT floor", () => {
  const file = (n: number): StoredMessage => ({ linkId: "order", id: `me_${n}`, text: `f${n}`, sender: "me", timestamp: n, via: "datalink", delivery: "waiting",
    file: { id: `order-out-${n}`, name: `f${n}.bin`, size: 10, mime: "application/octet-stream" } });
  /**
   * The floor as the engine's resender sees it: one text or offer awaiting its receipt at a time; a waiting file's offer
   * goes there once (`fileOnFloor`) when the contact's app takes it (`takesFiles`), its bytes once live.
   */
  function floor(rows: StoredMessage[], options: { takesFiles?: boolean } = {}) {
    const state = { live: false, awaiting: undefined as string | undefined };
    const said: string[] = [];
    const c = chat(rows, async m => { said.push(`${m.text} ${state.live ? "live" : "floor"}`); if (!state.live) state.awaiting = m.id; return null; }, {
      ready: m => {
        if (m.file && !m.wireId) return state.live || (options.takesFiles !== false && !m.fileOnFloor && !state.awaiting);
        return state.live || !state.awaiting;
      },
      via: () => (state.live ? "datalink" : "pkarr"),
      sendFile: async message => {
        const row = rows.find(m => m.id === message.id)!;
        if (state.live) { said.push(`${message.text} live`); delete row.delivery; return; }
        said.push(`${message.text} floor`);
        state.awaiting = message.id;
        row.fileOnFloor = "sent";
      },
    });
    /** The contact's receipt for what awaits one on the floor. */
    const receipt = async () => {
      const id = state.awaiting!;
      state.awaiting = undefined;
      const row = rows.find(m => m.id === id);
      if (row?.file) { row.fileOnFloor = "seen"; await c.box.received(`floor-${id}`); } else await c.box.received(id.slice("me_".length));
    };
    return { ...c, said, state, receipt };
  }

  it("text, file, text: the contact reads them in that order, and the file's bytes go once live", async () => {
    const c = floor([]);
    await c.box.transmit(c.add(row(1, "sending")));
    c.add(file(2));
    await c.box.transmit(c.add(row(3, "sending")));
    expect(c.said).toEqual(["m1 floor"]);
    await c.receipt();
    await vi.waitFor(() => expect(c.said).toEqual(["m1 floor", "f2 floor"]));
    // The text written after the file waits for the file's receipt, not for the live link.
    await c.receipt();
    await vi.waitFor(() => expect(c.said).toEqual(["m1 floor", "f2 floor", "m3 floor"]));
    await c.receipt();
    // Said once: a look before the chat is live does not say it again.
    await c.box.flush({ reopened: true });
    expect(c.said.filter(s => s.startsWith("f2"))).toEqual(["f2 floor"]);
    c.state.live = true;
    await c.box.flush({ reopened: true });
    expect(c.said).toEqual(["m1 floor", "f2 floor", "m3 floor", "f2 live"]);
    await c.box.stop();
  });

  it("a contact whose app does not take a file on the floor: the file waits for live as before, the texts go", async () => {
    const c = floor([], { takesFiles: false });
    await c.box.transmit(c.add(row(1, "sending")));
    c.add(file(2));
    await c.box.transmit(c.add(row(3, "sending")));
    await c.receipt();
    await vi.waitFor(() => expect(c.said).toEqual(["m1 floor", "m3 floor"]));
    await c.receipt();
    c.state.live = true;
    await c.box.flush({ reopened: true });
    expect(c.said).toEqual(["m1 floor", "m3 floor", "f2 live"]);
    await c.box.stop();
  });

  it("a file written while a text awaits its receipt goes on the floor right after it, before a text written later", async () => {
    const c = floor([row(1, "sent", { via: "pkarr" })]);
    c.state.awaiting = `me_${wire(1)}`;
    c.add(file(2));
    await c.box.recover();
    await c.box.wait(c.add(row(3, "sending")), "Waits for the text before it to be confirmed.");
    await c.receipt();
    await vi.waitFor(() => expect(c.said).toEqual(["f2 floor"]));
    await c.receipt();
    await vi.waitFor(() => expect(c.said).toEqual(["f2 floor", "m3 floor"]));
    await c.box.stop();
  });

  // The engine stores a waiting file itself and tells its outbox only that it does (`storing`): a new text no longer
  // reads the chat when nothing of its own waits, so that is all it has to find the file by.
  it("a file stored when nothing else waits: a text written after it waits behind its offer", async () => {
    const c = floor([]);
    await c.box.transmit(c.add(row(1, "sending")));
    await c.receipt();
    await c.box.storing(Promise.resolve(c.add(file(2))));
    await c.box.transmit(c.add(row(3, "sending")));
    await vi.waitFor(() => expect(c.said).toEqual(["m1 floor", "f2 floor"]));
    await c.receipt();
    await vi.waitFor(() => expect(c.said).toEqual(["m1 floor", "f2 floor", "m3 floor"]));
    await c.box.stop();
  });

  it("a file whose write is still on its way when a text is written after it: the text still goes after it", async () => {
    const c = floor([]);
    await c.box.transmit(c.add(row(1, "sending")));
    await c.receipt();
    // As the engine stores a row: it is in the store, and what follows the write (the chat shown again) is not over yet.
    let over = () => {};
    const stored = c.box.storing(new Promise<void>(resolve => { c.add(file(2)); over = resolve; }));
    await c.box.transmit(c.add(row(3, "sending")));
    over();
    await stored;
    await vi.waitFor(() => expect(c.said).toEqual(["m1 floor", "f2 floor"]));
    await c.receipt();
    await vi.waitFor(() => expect(c.said).toEqual(["m1 floor", "f2 floor", "m3 floor"]));
    await c.box.stop();
  });
});

/**
 * Seen 2026-10-17 on the CLI's store at 10,000 messages: each text sent read and sorted the chat's whole history first
 * (about 220 ms per send) to find the messages before it that still wait, and found none.
 */
describe("a new text with nothing before it still to go", () => {
  function long(n: number) {
    const rows = Array.from({ length: n }, (_, i) => row(i + 1, "delivered")), sent: string[] = [];
    const counts = { reads: 0 };
    const box = new Outbox({
      read: async () => { counts.reads++; return rows.map(m => ({ ...m })); },
      get: async id => { const found = rows.find(m => m.id === id); return found && { ...found }; },
      update: async (id, delivery, error, extra) => { const found = rows.find(m => m.id === id); if (found && found.delivery !== "delivered") Object.assign(found, extra, { delivery, deliveryError: error }); },
    }, async m => { sent.push(m.text); return null; });
    const add = (m: StoredMessage) => { rows.push(m); return m.id; };
    return { box, rows, sent, counts, add };
  }

  it("goes without the chat's history being read, once a look at it found nothing of mine to go", async () => {
    const c = long(1_000);
    for (const n of [1001, 1002, 1003, 1004, 1005]) {
      await c.box.transmit(c.add(row(n, "sending")));
      await c.box.received(wire(n));
    }
    expect(c.sent).toEqual(["m1001", "m1002", "m1003", "m1004", "m1005"]);
    // The first send's look, and none after it.
    expect(c.counts.reads).toBe(1);
    await c.box.stop();
  });

  it("a text whose row is still being stored when a later one is sent: the later one looks, and goes after it", async () => {
    const c = long(10);
    await c.box.transmit(c.add(row(11, "sending")));
    await c.box.received(wire(11));
    // The row is in the store, and what follows its write is not over when the next text is sent.
    let over = () => {};
    const first = c.box.transmit(`me_${wire(12)}`, { storing: new Promise<void>(resolve => { c.add(row(12, "sending")); over = resolve; }) });
    const second = c.box.transmit(c.add(row(13, "sending")));
    over();
    await Promise.all([first, second]);
    expect(c.sent).toEqual(["m11", "m12", "m13"]);
    await c.box.stop();
  });

  it("a write it was told of that fails: the send it was for fails, and the next one is not held back for it", async () => {
    const c = long(10);
    await expect(c.box.transmit(`me_${wire(11)}`, { storing: Promise.reject(new Error("full")) })).rejects.toThrow("full");
    await c.box.transmit(c.add(row(12, "sending")));
    await c.box.received(wire(12));
    const reads = c.counts.reads;
    await c.box.transmit(c.add(row(13, "sending")));
    expect(c.sent).toEqual(["m12", "m13"]);
    expect(c.counts.reads).toBe(reads);
    await c.box.stop();
  });
});
