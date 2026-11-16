import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { voiceDownloadName } from "@ghostly/core";
import { fileStore } from "@ghostly/browser/shared/idb";
import type { EngineState } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.files

// Every stat the save makes, by path: a voice message stepping to a free name in --dir is one stat a name.
const stats = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  const stat = ((path: string, ...rest: never[]) => { stats.push(String(path)); return (fs.stat as (...args: unknown[]) => unknown)(path, ...rest); }) as typeof fs.stat;
  return { ...fs, default: { ...fs, stat }, stat };
});

/**
 * A voice message saved into a --dir that has many copies of its name steps to the next free "<name> (n)" one stat a
 * name. Before, each step also built the "keep both" hint it then dropped, its own search from "(2)": ~k²/2 stats, 12-16 s
 * at 999 copies.
 */
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-file-save-steps-"));
  await openPersistentIndexedDb(join(dir, "db"));
  await fileStore.put({
    id: "chat-one-in-v", linkId: "chat-one", blob: new Blob(["voice"]), createdAt: 1, direction: "in",
    metadata: { name: "v.webm", size: 5, mime: "audio/webm", timestamp: 1_700_000_000_000, voice: { duration: 1_000, peaks: [] } },
    transfer: { state: "done", transferred: 5, size: 5 },
  } as never);
});

const rows = [{ id: "peer_v", sender: "peer", timestamp: 1_700_000_005_000, file: { id: "chat-one-in-v" } }];
const node = {
  getState: () => ({ links: [], groups: [], settings: {}, transport: {}, transfers: {} }) as unknown as EngineState,
  messagePage: async () => ({ messages: rows, more: false }),
  getMessages: async () => rows,
  fileMessages: async () => rows,
};
const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;

describe("file save of a voice message into a --dir full of its name", () => {
  it("steps to the free name with one stat a name, not a hint search at every step", async () => {
    const folder = join(dir, "voice");
    mkdirSync(folder);
    const name = voiceDownloadName("audio/webm", 1_700_000_005_000), stem = name.slice(0, -".webm".length);
    writeFileSync(join(folder, name), "0");
    for (let n = 2; n <= 300; n += 1) writeFileSync(join(folder, `${stem} (${n}).webm`), String(n));
    stats.length = 0;
    expect(await callApi(ctx, "file.save", { file: "chat-one-in-v", dir: folder })).toMatchObject({ path: join(folder, `${stem} (301).webm`) });
    expect(readFileSync(join(folder, `${stem} (301).webm`), "utf8")).toBe("voice");
    // 300 names taken, one free: 301 stats. Before: 90,301, each step's hint looking through all 300 from "(2)".
    expect(stats.filter((path) => path.startsWith(folder)).length).toBe(301);
  });
});
