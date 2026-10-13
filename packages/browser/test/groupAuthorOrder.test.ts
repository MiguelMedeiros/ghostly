import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { AUTHOR_ORDER_SETTLE_MS, AUTHOR_ORDER_WAIT_MAX_MS, AUTHOR_ORDER_WINDOW_MS, GroupAuthorOrder } from "../src/engine/groupAuthorOrder";
import { db } from "../src/engine/db";
import { GhostlyNode } from "../src/engine/node";
import type { StoredMessage } from "../src/shared/types";
// covers: groups.catch-up

/**
 * WISP 400 requirement 10 and WISP 902 § Catch-up: a member's messages in a private group read in the order that member
 * wrote them, though two catch-up answers race. A later message placed above an older one of its author's is placed
 * again below it; nobody else's line moves, and nothing moves back.
 */

/** A history kept as the order rows come in, and an order that follows it; `missing`: a member's messages still on their way. */
function history(missing = new Set<string>()) {
  const rows: string[] = [];
  const moves: number[] = [];
  const order = new GroupAuthorOrder({ placeAgain: async (_linkId, ids) => { moves.push(ids.length); for (const id of ids) { rows.splice(rows.indexOf(id), 1); rows.push(id); } } }, id => `group:${id}`, (_groupId, sender) => missing.has(sender));
  let at = 0;
  const comes = async (sender: string, seq: number, epoch = 1, wait = 0) => {
    at += wait;
    const id = `${sender}${epoch > 1 ? `e${epoch}.` : ""}${seq}`;
    rows.push(id);
    order.placed("g", { sender, epoch, seq, id, at });
    await new Promise(done => setTimeout(done, 0));
  };
  const tick = async (wait: number) => { at += wait; order.tick(at); await new Promise(done => setTimeout(done, 0)); };
  return { rows, moves, comes, tick };
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

describe("a member's rows wait for that member's catch-up", () => {
  it("while older ones are on their way nothing moves; once they all came, every row moves once", async () => {
    const missing = new Set(["a"]);
    const { rows, moves, comes, tick } = history(missing);
    for (const seq of [9, 10, 11, 12]) await comes("a", seq);
    for (const seq of [5, 6, 7, 8]) await comes("a", seq, 1, 1000);
    await tick(1000);
    expect(moves).toEqual([]);
    for (const seq of [1, 2, 3, 4]) await comes("a", seq, 1, 1000);
    missing.delete("a");
    await tick(1000);
    expect(rows).toEqual(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10", "a11", "a12"]);
    expect(moves).toEqual([8]);
  });

  it("what never comes is not waited for: a while after the member's last row, the rows are placed anyway", async () => {
    const { rows, moves, comes, tick } = history(new Set(["a"]));
    for (const seq of [9, 10]) await comes("a", seq);
    for (const seq of [5, 6]) await comes("a", seq, 1, 1000);
    await tick(AUTHOR_ORDER_SETTLE_MS - 1);
    expect(moves).toEqual([]);
    await tick(1);
    expect(rows).toEqual(["a5", "a6", "a9", "a10"]);
  });

  it("a catch-up that goes on and on: its rows are placed now and then, and the newest stays followed to the end", async () => {
    const { rows, comes, tick } = history(new Set(["a"]));
    // The newest 4 first, then an older one every 10 s for five minutes (longer than the rows are followed).
    for (const seq of [97, 98, 99, 100]) await comes("a", seq);
    for (let seq = 96; seq > 66; seq--) { await comes("a", seq, 1, 10_000); await tick(0); }
    await tick(AUTHOR_ORDER_SETTLE_MS);
    expect(rows.slice(-4)).toEqual(["a97", "a98", "a99", "a100"]);
    expect(rows.indexOf("a96")).toBeLessThan(rows.indexOf("a97"));
    expect(30 * 10_000).toBeGreaterThan(AUTHOR_ORDER_WAIT_MAX_MS + AUTHOR_ORDER_WINDOW_MS);
  });

  it("another member's rows do not wait for that member's catch-up", async () => {
    const { rows, comes } = history(new Set(["a"]));
    await comes("a", 9);
    await comes("a", 1);
    await comes("b", 9);
    await comes("b", 1);
    expect(rows).toEqual(["a9", "a1", "b1", "b9"]);
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
});
