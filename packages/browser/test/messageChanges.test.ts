import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMessageChanges } from "../src/shared/messageChanges";
import type { StoredMessage } from "../src/shared/types";
// covers: storage.indexeddb

/**
 * What changed in a history, made on the copy a page or the CLI holds (`applyMessageChanges`): after any run of new
 * rows, changed rows and deleted ones, the copy is exactly what the store reads whole (`db.getMessages`), in its order.
 */
await import("../src/engine/db");
let db: typeof import("../src/engine/db").db;

beforeEach(async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.resetModules();
  ({ db } = await import("../src/engine/db"));
}, 60_000);
afterEach(() => vi.unstubAllGlobals());

const message = (id: string, timestamp: number, text = id): StoredMessage => ({ linkId: "chat", id, text, sender: "peer", timestamp, via: "datalink" });

/** The engine's side: the rows named, read as stored now; one not there is deleted. */
async function changesOf(ids: string[]) {
  const rows = await Promise.all(ids.map((id) => db.getMessage("chat", id)));
  return { messages: rows.filter((r): r is StoredMessage => !!r), deleted: ids.filter((_, i) => !rows[i]) };
}

describe("a history kept up to date from what changed", () => {
  it("is the store's whole history after every change, in its order (time, then id)", async () => {
    let seed = 11;
    const random = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    for (let i = 0; i < 40; i++) await db.putMessage(message(`m${random(1000)}`, 1_000 + random(20)));
    let copy = await db.getMessages("chat");
    for (let step = 0; step < 200; step++) {
      const existing = copy.map((m) => m.id);
      const touched: string[] = [];
      for (let n = 1 + random(3); n > 0; n--) {
        const kind = random(4);
        if (kind === 0 || !existing.length) {
          // New, often at the end, sometimes sharing a time with others, sometimes older than the rest.
          const id = `n${step}-${n}-${random(1000)}`;
          await db.putMessage(message(id, random(5) ? 1_020 + step : 1_000 + random(20)));
          touched.push(id);
        } else {
          const id = existing[random(existing.length)]!;
          if (kind === 1) await db.deleteMessage("chat", id);
          else await db.patchMessage("chat", id, (m) => ({ text: `${m.text}+`, reactions: { peer: { e: "👍", n: step, at: step } } }));
          touched.push(id);
        }
      }
      const before = copy;
      copy = applyMessageChanges(copy, await changesOf(touched));
      expect(copy).toEqual(await db.getMessages("chat"));
      expect(before).not.toBe(copy);
    }
  });

  it("leaves the list it was given as it was", () => {
    const history = [message("a", 1), message("b", 2)];
    const next = applyMessageChanges(history, { messages: [message("c", 3), { ...message("a", 1), text: "edited" }], deleted: ["b"] });
    expect(history.map((m) => [m.id, m.text])).toEqual([["a", "a"], ["b", "b"]]);
    expect(next.map((m) => [m.id, m.text])).toEqual([["a", "edited"], ["c", "c"]]);
  });
});
