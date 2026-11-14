import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import type { ApiContext } from "../src/api";
// covers: storage.indexeddb, headless.files

/**
 * What `file list` costs in a chat of 0 to 9,000 texts and 5 files, median of 7, on the CLI's disk store reopened as a
 * new process would: the whole history filtered (what it read before) against the file index (`fileMessages`). Then
 * what the index costs once, made when a 9,000-text profile from before it opens. Only when asked:
 * `npx vitest run test/fileListBench.test.ts --mode bench` (or GHOSTLY_BENCH=1).
 */
const RUNS = 7;
const SIZES = [0, 2000, 5000, 9000];
const FILES = 5;

const message = (linkId: string, i: number, file = false): StoredMessage => ({
  linkId, id: `${i % 2 ? "peer" : "me"}_${1_700_000_000_000 + i * 1000}`, text: file ? "" : `message number ${i}, about as long as a chat line gets. `.repeat(2),
  sender: i % 2 ? "peer" : "me", timestamp: 1_700_000_000_000 + i * 1000, via: "datalink",
  ...(file && { file: { id: `${linkId}-in-${i}`, name: `file-${i}.pdf`, size: 1000, mime: "application/pdf" } }),
  details: { wire: { frame: "GHM1", protocol: "datalink/1", plaintextBytes: 120, wireBytes: 220 } } as StoredMessage["details"],
});
const rows = (linkId: string, texts: number) => Array.from({ length: texts + FILES }, (_, i) => message(linkId, i, i % Math.max(1, Math.floor((texts + FILES) / FILES)) === 0));
const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
async function time(work: () => Promise<unknown>): Promise<number> {
  const runs: number[] = [];
  for (let i = 0; i < RUNS; i++) { const start = performance.now(); await work(); runs.push(performance.now() - start); }
  return median(runs);
}

describe.skipIf(!process.env.GHOSTLY_BENCH && import.meta.env.MODE !== "bench")("file list in a long chat", () => {
  it("whole history against the file index, CLI disk store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ghostly-file-bench-"));
    try {
      vi.resetModules();
      const { openPersistentIndexedDb } = await import("../src/runtime/storage");
      const first = await openPersistentIndexedDb(dir);
      const seeded = (await import("@ghostly/browser/engine/db")).db;
      for (const size of SIZES) for (const row of rows(`chat-${size}`, size)) await seeded.putMessage(row);
      await first.close();

      vi.resetModules();
      const second = await openPersistentIndexedDb(dir);
      const { db } = await import("@ghostly/browser/engine/db");
      const { GhostlyNode } = await import("@ghostly/browser/engine/node");
      const { callApi } = await import("../src/api");
      const { filesOf } = await import("../src/files");
      const node = {
        getState: () => ({ links: SIZES.map((size) => ({ id: `chat-${size}` })), groups: [], transfers: {} }),
        fileMessages: (linkId: string) => GhostlyNode.prototype.fileMessages.call(null as never, linkId),
      };
      const ctx = { runtime: { server: { node }, paths: { name: "default" } } } as unknown as ApiContext;
      const lines = [`${"texts".padStart(6)} ${"whole history".padStart(15)} ${"file.list".padStart(12)}`];
      for (const size of SIZES) {
        const linkId = `chat-${size}`;
        const before = await time(async () => filesOf(await db.getMessages(linkId), () => null));
        const after = await time(() => callApi(ctx, "file.list", { chat: linkId }));
        lines.push(`${String(size).padStart(6)} ${before.toFixed(1).padStart(12)} ms ${after.toFixed(1).padStart(9)} ms`);
        expect(((await callApi(ctx, "file.list", { chat: linkId })) as { files: unknown[] }).files).toHaveLength(FILES);
      }
      console.log(`\n${lines.join("\n")}`);
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);

  it("the index made once, as a 9,000-text profile from before it opens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ghostly-file-bench-"));
    try {
      vi.resetModules();
      const { openPersistentIndexedDb } = await import("../src/runtime/storage");
      const first = await openPersistentIndexedDb(dir);
      // The messages store as version 15 left it.
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("ghostly", 15);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore("messages", { keyPath: ["linkId", "id"] });
          store.createIndex("byLink", "linkId");
          store.createIndex("byLinkTime", ["linkId", "timestamp"]);
          store.createIndex("byCardKind", "card.kind");
          for (const row of rows("chat-old", 9000)) store.put(row);
        };
        request.onsuccess = () => { request.result.close(); resolve(); };
        request.onerror = () => reject(request.error);
      });
      await first.close();

      vi.resetModules();
      const second = await openPersistentIndexedDb(dir);
      const { db } = await import("@ghostly/browser/engine/db");
      const start = performance.now();
      const files = await db.getFileMessages("chat-old");
      console.log(`\nupgrade to the file index + first read, 9,000 texts: ${(performance.now() - start).toFixed(0)} ms`);
      expect(files).toHaveLength(FILES);
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
