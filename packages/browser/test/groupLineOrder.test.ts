import { describe, expect, it } from "vitest";
import { GroupLineOrder, LINE_ORDER_SETTLE_MS, LINE_ORDER_WAIT_MAX_MS } from "../src/engine/groupLineOrder";
import { AUTHOR_ORDER_WINDOW_MS } from "../src/engine/groupAuthorOrder";
// covers: groups.catch-up

/** A history as a host keeps it: rows in the order they are placed, those placed again at its end. */
function historyOf(): { order: GroupLineOrder; rows: string[]; moves: string[][]; add: (id: string, epoch: number, line: boolean, at?: number, stored?: boolean) => void; settle: () => Promise<void> } {
  const rows: string[] = [], moves: string[][] = [];
  const order = new GroupLineOrder({ placeAgain: async (_link, ids) => { moves.push([...ids]); for (const id of ids) rows.push(...rows.splice(rows.indexOf(id), 1)); } });
  const add = (id: string, epoch: number, line: boolean, at = 0, stored = true) => {
    const placing = order.placing("group:g", { id, epoch, line }, at);
    if (stored) rows.push(id);
    placing(stored);
  };
  // The engine's tick, once nothing more came for a while.
  const settle = async () => { await settled(); order.tick(2 * AUTHOR_ORDER_WINDOW_MS); await settled(); };
  return { order, rows, moves, add, settle };
}
const settled = () => new Promise(done => setTimeout(done, 0));

describe("a group's lines among the messages of their moment", () => {
  it("a message of the epoch before a line placed above it takes the line, and what was written knowing it, below it", async () => {
    const { rows, add, settle } = historyOf();
    add("gone", 2, true);
    add("bob 1", 1, false);
    add("alice 1", 2, false);
    add("bob 2", 1, false);
    await settle();
    expect(rows).toEqual(["bob 1", "bob 2", "gone", "alice 1"]);
  });

  it("messages written knowing the line move nothing: a live conversation stays as it came", async () => {
    const { rows, moves, add, settle } = historyOf();
    add("bob 1", 1, false);
    add("gone", 2, true);
    add("alice 1", 2, false);
    add("joined", 3, true);
    add("carol 1", 3, false);
    await settle();
    expect(rows).toEqual(["bob 1", "gone", "alice 1", "joined", "carol 1"]);
    expect(moves).toEqual([]);
  });

  it("each line goes below the messages of the epochs before its own only", async () => {
    const { rows, add, settle } = historyOf();
    add("gone", 2, true);
    add("joined", 3, true);
    add("alice 2", 2, false);
    add("bob 1", 1, false);
    add("carol 3", 3, false);
    await settle();
    expect(rows).toEqual(["bob 1", "gone", "alice 2", "joined", "carol 3"]);
  });

  it("a line placed long ago, or a copy already there, moves nothing", async () => {
    const { rows, moves, add, settle } = historyOf();
    add("gone", 2, true, 0);
    add("bob 1", 1, false, AUTHOR_ORDER_WINDOW_MS + 1);
    add("rotated", 3, true, AUTHOR_ORDER_WINDOW_MS + 2);
    add("bob 1 again", 2, false, AUTHOR_ORDER_WINDOW_MS + 3, false);
    await settle();
    expect(rows).toEqual(["gone", "bob 1", "rotated"]);
    expect(moves).toEqual([]);
  });

  it("a catch-up page of older messages moves the lines once, not once a message", async () => {
    const { order, rows, moves, add } = historyOf();
    // The commits come first, then the messages oldest first: 12 of the epoch before them, 4 written knowing them.
    add("joined", 2, true);
    add("rotated", 3, true);
    for (let i = 0; i < 12; i++) add(`bob ${i}`, 1, false, i * 100);
    for (let i = 0; i < 4; i++) add(`carol ${i}`, 3, false, 1_200 + i * 100);
    await settled();
    order.tick(1_100 + LINE_ORDER_SETTLE_MS - 1);
    await settled();
    expect(moves).toEqual([]);
    order.tick(1_100 + LINE_ORDER_SETTLE_MS);
    await settled();
    // The older messages stay where they came: only the lines, and what was written knowing them, go below them.
    expect(rows).toEqual([...Array.from({ length: 12 }, (_, i) => `bob ${i}`), "joined", "rotated", "carol 0", "carol 1", "carol 2", "carol 3"]);
    expect(moves).toEqual([["joined", "rotated", "carol 0", "carol 1", "carol 2", "carol 3"]]);
  });

  it("older messages that keep coming move the lines once in a while, not only at the end", async () => {
    const { order, rows, moves, add } = historyOf();
    add("joined", 2, true);
    for (let at = 0; at <= LINE_ORDER_WAIT_MAX_MS; at += 1_000) {
      add(`bob ${at}`, 1, false, at);
      order.tick(at);
      await settled();
    }
    expect(moves).toHaveLength(1);
    expect(rows.at(-1)).toBe("joined");
  });

  it("rows placed again by the author order are followed where they went", async () => {
    const { order, rows, add, settle } = historyOf();
    add("bob 2", 1, false);
    add("gone", 2, true);
    add("bob 1", 1, false);
    await settle();
    expect(rows).toEqual(["bob 2", "bob 1", "gone"]);
    // The author order puts Bob's in the order he wrote them: his newest goes below the line, which follows it down.
    rows.push(...rows.splice(rows.indexOf("bob 2"), 1));
    order.moved("group:g", ["bob 2"], 0);
    await settle();
    expect(rows).toEqual(["bob 1", "bob 2", "gone"]);
  });
});
