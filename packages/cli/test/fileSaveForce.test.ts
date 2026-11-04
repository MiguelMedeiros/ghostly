import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fileStore } from "@ghostly/browser/shared/idb";
import type { EngineState } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.files

/**
 * `file save --force` replaces the file there only once the new one is written whole: a save that fails (the bytes not
 * on this device, a full disk) leaves the file it was to replace as it was. Before, it was emptied when the save
 * opened it and removed when the save failed.
 */
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-file-save-force-"));
  await openPersistentIndexedDb(join(dir, "db"));
  await fileStore.put({
    id: "chat-one-in-r", linkId: "chat-one", blob: new Blob(["new report"]), createdAt: 1, direction: "in",
    metadata: { name: "report.txt", size: 10, mime: "text/plain", timestamp: 1 },
    transfer: { state: "done", transferred: 10, size: 10 },
  } as never);
  // Its record is here, its bytes are not.
  await fileStore.put({
    id: "chat-one-in-gone", linkId: "chat-one", createdAt: 1, direction: "in",
    metadata: { name: "gone.txt", size: 4, mime: "text/plain", timestamp: 1 },
    transfer: { state: "done", transferred: 4, size: 4 },
  } as never);
});

const node = { getState: () => ({ links: [], groups: [], settings: {}, transport: {}, transfers: {} }) as unknown as EngineState };
const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;

describe("file save --force", () => {
  it("a save that fails leaves the file it was to replace as it was", async () => {
    const folder = mkdtempSync(join(dir, "fail-"));
    const target = join(folder, "keep.txt");
    writeFileSync(target, "my own notes");
    await expect(callApi(ctx, "file.save", { file: "chat-one-in-gone", path: target, force: true })).rejects.toMatchObject({ code: "not_found" });
    expect(readFileSync(target, "utf8")).toBe("my own notes");
    expect(readdirSync(folder)).toEqual(["keep.txt"]);
  });

  it("a save that succeeds replaces it, and leaves nothing beside it", async () => {
    const folder = mkdtempSync(join(dir, "ok-"));
    const target = join(folder, "report.txt");
    writeFileSync(target, "an older, longer report");
    expect(await callApi(ctx, "file.save", { file: "chat-one-in-r", path: target, force: true })).toMatchObject({ path: target, size: 10 });
    expect(readFileSync(target, "utf8")).toBe("new report");
    expect(readdirSync(folder)).toEqual(["report.txt"]);
  });

  it("without --force a failed save leaves no file", async () => {
    const folder = mkdtempSync(join(dir, "new-"));
    await expect(callApi(ctx, "file.save", { file: "chat-one-in-gone", dir: folder })).rejects.toMatchObject({ code: "not_found" });
    expect(readdirSync(folder)).toEqual([]);
  });
});
