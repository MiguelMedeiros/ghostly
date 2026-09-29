import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import type { ApiContext } from "../src/api";
// covers: storage.indexeddb, headless.api

/**
 * How long a chat takes to open from the store, 2000 messages against 50, median of 5: the whole history (what the
 * engine read before pages) and the first page (`messagePage`, and `chat.history` on the CLI's disk store, reopened as
 * a new process would). Only when asked: `npx vitest run test/longChatBench.test.ts --mode bench` (or GHOSTLY_BENCH=1).
 */
const RUNS = 5;
const SIZES = { long: 2000, short: 50 } as const;

const message = (linkId: string, i: number): StoredMessage => ({
  linkId, id: `${i % 2 ? "peer" : "me"}_${1_700_000_000_000 + i * 1000}`, text: `message number ${i}, about as long as a chat line gets. `.repeat(2),
  sender: i % 2 ? "peer" : "me", timestamp: 1_700_000_000_000 + i * 1000, via: "datalink", ...(i % 2 ? {} : { delivery: "delivered" as const }),
  details: { wire: { frame: "GHM1", protocol: "datalink/1", plaintextBytes: 120, wireBytes: 220 } } as StoredMessage["details"],
});
const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
async function time(work: () => Promise<unknown>): Promise<number> {
  const runs: number[] = [];
  for (let i = 0; i < RUNS; i++) { const start = performance.now(); await work(); runs.push(performance.now() - start); }
  return median(runs);
}
async function seed(db: typeof import("@ghostly/browser/engine/db").db) {
  // The two chats, and a third one around them in the store.
  for (const [linkId, count] of [["long", SIZES.long], ["short", SIZES.short], ["other", 500]] as const) for (let i = 0; i < count; i++) await db.putMessage(message(linkId, i));
}
const row = (store: string, what: string, ms: Record<string, number>) => `${store.padEnd(10)} ${what.padEnd(30)} ${ms.long!.toFixed(1).padStart(8)} ms ${ms.short!.toFixed(1).padStart(8)} ms`;

describe.skipIf(!process.env.GHOSTLY_BENCH && import.meta.env.MODE !== "bench")("opening a long chat", () => {
  it("web store (IndexedDB, fake-indexeddb)", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    vi.resetModules();
    const { db } = await import("@ghostly/browser/engine/db");
    const { GhostlyNode } = await import("@ghostly/browser/engine/node");
    await seed(db);
    const whole: Record<string, number> = {}, page: Record<string, number> = {};
    for (const linkId of Object.keys(SIZES)) {
      whole[linkId] = await time(() => db.getMessages(linkId));
      page[linkId] = await time(() => GhostlyNode.prototype.messagePage.call(null as never, { linkId }));
    }
    console.log(`\n${"store".padEnd(10)} ${"read".padEnd(30)} ${"2000".padStart(11)} ${"50".padStart(11)}\n${row("web", "whole history (getMessages)", whole)}\n${row("web", "first page (messagePage)", page)}`);
    expect((await GhostlyNode.prototype.messagePage.call(null as never, { linkId: "long" })).messages).toHaveLength(50);
    vi.unstubAllGlobals();
  }, 600_000);

  it("CLI and Desktop-headless store (fake-indexeddb kept on disk)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ghostly-bench-"));
    try {
      vi.resetModules();
      const { openPersistentIndexedDb } = await import("../src/runtime/storage");
      const first = await openPersistentIndexedDb(dir);
      await seed((await import("@ghostly/browser/engine/db")).db);
      await first.close();

      // A new process: the store comes back from the disk, then the chat opens.
      vi.resetModules();
      await openPersistentIndexedDb(dir);
      const { db } = await import("@ghostly/browser/engine/db");
      const { GhostlyNode } = await import("@ghostly/browser/engine/node");
      const { callApi } = await import("../src/api");
      const node = { getState: () => ({ links: Object.keys(SIZES).map((id) => ({ id })), groups: [] }), getMessages: db.getMessages, messagePage: GhostlyNode.prototype.messagePage };
      const ctx = { runtime: { server: { node }, paths: { name: "default" } } } as unknown as ApiContext;
      const whole: Record<string, number> = {}, page: Record<string, number> = {};
      for (const linkId of Object.keys(SIZES)) {
        // What `chat.history` did before pages: the whole history, sorted, and its last 50.
        whole[linkId] = await time(async () => (await db.getMessages(linkId)).slice().sort((a, b) => a.timestamp - b.timestamp).slice(-50));
        page[linkId] = await time(() => callApi(ctx, "chat.history", { chat: linkId }));
      }
      console.log(`${row("CLI", "whole history, last 50", whole)}\n${row("CLI", "chat.history (first page)", page)}`);
      expect(((await callApi(ctx, "chat.history", { chat: "long" })) as { messages: unknown[] }).messages).toHaveLength(50);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
