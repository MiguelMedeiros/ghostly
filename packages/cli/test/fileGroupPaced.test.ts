import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import { fileStore } from "@ghostly/browser/shared/idb";
import type { EngineState, GroupView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { NodeFileBytes } from "../src/runtime/fileBytes";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.files

/**
 * A group `file send` the group would refuse anyway (its files of the minute are taken, or this device is not in it) is
 * refused before a byte is copied: a bot retrying until it is let through writes nothing to the files folder.
 */
const group = { id: "g1", name: "Team", status: "active", members: [] } as unknown as GroupView;

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-file-group-paced-"));
  await openPersistentIndexedDb(join(dir, "db"));
  registerFileBytes("native", async () => new NodeFileBytes(join(dir, "files")), true);
});

function ctxWith(check: { error: string | null; refused?: boolean }) {
  const node = {
    getState: () => ({ links: [], groups: [group], settings: {}, transport: {}, transfers: {} }) as unknown as EngineState,
    groupFileCheck: vi.fn(async () => check),
    sendGroupFile: vi.fn(async () => check),
    setGroupTyping: vi.fn(async () => {}),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { node, ctx };
}

describe("file send to a group that would refuse it", () => {
  const path = () => {
    const file = join(dir, "burst.bin");
    writeFileSync(file, new Uint8Array(256 * 1024));
    return file;
  };

  it("is refused at the pace before the file is copied in", async () => {
    const stage = vi.spyOn(NodeFileBytes.prototype, "stage");
    const { node, ctx } = ctxWith({ error: "You sent many files to this group just now. Wait a minute." });
    await expect(callApi(ctx, "file.send", { chat: "group:g1", path: path() })).rejects.toMatchObject({ code: "unavailable", message: "You sent many files to this group just now. Wait a minute." });
    expect(node.groupFileCheck).toHaveBeenCalledWith({ groupId: "g1" });
    expect(node.sendGroupFile).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
    expect(await fileStore.listForLink("group:g1")).toEqual([]);
    expect(readdirSync(dir)).not.toContain("files");
    stage.mockRestore();
  });

  it("is refused out of the group before the file is copied in", async () => {
    const stage = vi.spyOn(NodeFileBytes.prototype, "stage");
    const { node, ctx } = ctxWith({ error: "You were removed from this group", refused: true });
    await expect(callApi(ctx, "file.send", { chat: "group:g1", path: path() })).rejects.toMatchObject({ code: "refused", message: "You were removed from this group" });
    expect(node.sendGroupFile).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
    stage.mockRestore();
  });
});
