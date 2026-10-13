import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { AUTHOR_ORDER_WINDOW_MS, GroupAuthorOrder } from "../src/engine/groupAuthorOrder";
import { db } from "../src/engine/db";
import { GhostlyNode } from "../src/engine/node";
import type { StoredMessage } from "../src/shared/types";
// covers: groups.catch-up

/**
 * WISP 400 requirement 10 and WISP 902 § Catch-up: a member's messages in a private group read in the order that member
 * wrote them, though two catch-up answers race. A later message placed above an older one of its author's is placed
 * again below it; nobody else's line moves, and nothing moves back.
 */

/** A history kept as the order rows come in, and an order that follows it. */
function history() {
  const rows: string[] = [];
  const order = new GroupAuthorOrder({ placeAgain: async (_linkId, ids) => { for (const id of ids) { rows.splice(rows.indexOf(id), 1); rows.push(id); } } }, id => `group:${id}`);
  let at = 0;
  const comes = async (sender: string, seq: number, epoch = 1, wait = 0) => {
    at += wait;
    const id = `${sender}${epoch > 1 ? `e${epoch}.` : ""}${seq}`;
    rows.push(id);
    order.placed("g", { sender, epoch, seq, id, at });
    await new Promise(done => setTimeout(done, 0));
  };
  return { rows, comes };
}

describe("a member's messages in a private group, in the order that member wrote them", () => {
  it("the newest that came first go below the older ones handed on after them, and the last line is the newest", async () => {
    const { rows, comes } = history();
    for (const seq of [1, 2, 7, 8]) await comes("a", seq);
    for (const seq of [3, 4, 5, 6]) await comes("a", seq);
    expect(rows).toEqual(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]);
  });

  it("another member's lines that came between keep their order and their place", async () => {
    const { rows, comes } = history();
    await comes("a", 9);
    await comes("b", 1);
    await comes("a", 1);
    await comes("b", 2);
    await comes("a", 2);
    expect(rows).toEqual(["b1", "a1", "b2", "a2", "a9"]);
  });

  it("a member's own answer racing another's hand-on, slice by slice: one list in the order written", async () => {
    const { rows, comes } = history();
    // The hand-on 1-12 and the author's own last 4 (9-12) come interleaved; the hand-on's copies of 9-12 are known.
    for (const seq of [1, 2, 3, 4, 5, 9, 6, 10, 7, 11, 8, 12]) await comes("a", seq);
    expect(rows).toEqual(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10", "a11", "a12"]);
  });

  it("in order, nothing moves; a later epoch is later whatever its number", async () => {
    const { rows, comes } = history();
    await comes("a", 40);
    await comes("a", 1, 2);
    await comes("a", 41);
    expect(rows).toEqual(["a40", "a41", "ae2.1"]);
  });

  it("a message placed a while ago stays where it is: one older that comes after the catch-up is placed where it comes", async () => {
    const { rows, comes } = history();
    await comes("a", 9);
    await comes("a", 3, 1, AUTHOR_ORDER_WINDOW_MS);
    expect(rows).toEqual(["a9", "a3"]);
  });
});

describe("the engine places a group's rows again", () => {
  it("below everything, in the order given, and tells the pages those rows only", async () => {
    const onMessageChanges = vi.fn();
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onMessageChanges }, { automaticWallets: false });
    const linkId = "group:order";
    const row = (id: string, member: string, timestamp: number): StoredMessage => ({ linkId, id, text: id, sender: "peer", member, timestamp, sentAt: timestamp, via: "datalink" });
    for (const [i, [id, member]] of [["a9", "a"], ["b1", "b"], ["a1", "a"], ["a10", "a"]].entries()) await db.addMessage(row(id, member, 1000 + i));
    await (node as unknown as { placeAgain(linkId: string, ids: string[]): Promise<void> }).placeAgain(linkId, ["a9", "a10", "gone"]);
    expect((await db.getMessages(linkId)).map(m => m.id)).toEqual(["b1", "a1", "a9", "a10"]);
    expect(onMessageChanges).toHaveBeenCalledOnce();
    expect(onMessageChanges.mock.calls[0]![1].messages.map((m: StoredMessage) => m.id)).toEqual(["a9", "a10"]);
    // The time each shows is still the one its sender said.
    expect((await db.getMessage(linkId, "a9"))!.sentAt).toBe(1000);
  });

  it("in one write: a catch-up's rows moved together cost the store one disk sync, not one a row", async () => {
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onMessageChanges: vi.fn() }, { automaticWallets: false });
    const linkId = "group:one-write";
    const ids = Array.from({ length: 32 }, (_, i) => `a${i + 1}`);
    for (const [i, id] of ids.entries()) await db.addMessage({ linkId, id, text: id, sender: "peer", member: "a", timestamp: 1000 + i, sentAt: 1000 + i, via: "datalink" });
    await db.addMessage({ linkId, id: "b1", text: "b1", sender: "peer", member: "b", timestamp: 2000, sentAt: 2000, via: "datalink" });
    const transaction = vi.spyOn(IDBDatabase.prototype, "transaction");
    await (node as unknown as { placeAgain(linkId: string, ids: string[]): Promise<void> }).placeAgain(linkId, ids);
    const writes = transaction.mock.calls.filter(([, mode]) => mode === "readwrite");
    transaction.mockRestore();
    expect(writes).toHaveLength(1);
    expect((await db.getMessages(linkId)).map(m => m.id)).toEqual(["b1", ...ids]);
  });
});
