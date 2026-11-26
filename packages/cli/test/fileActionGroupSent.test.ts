import { mkdtempSync } from "node:fs";
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
 * A group's file sent from here (WISP 503): the members fetch it from whoever holds it, the author among them, and
 * nothing on the author's device stops that. `file cancel` and `file pause` read the author's own record (done: staged
 * whole at send) and answered "Nothing to stop: the file is all here" while a member was still fetching it from them.
 */
const group = { id: "g1", name: "Team", status: "active" } as unknown as GroupView;
const OUT = "group-g1-out-sent", IN = "group-g1-in-got";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ghostly-file-action-group-sent-"));
  await openPersistentIndexedDb(join(dir, "db"));
  registerFileBytes("native", async () => new NodeFileBytes(join(dir, "files")), true);
  const done = { state: "done" as const, transferred: 95, size: 95 };
  const metadata = { name: "big.bin", size: 95, mime: "application/octet-stream", timestamp: 1 };
  await fileStore.put({ id: OUT, linkId: "group:g1", createdAt: 1, direction: "out", metadata, transfer: done });
  await fileStore.put({ id: IN, linkId: "group:g1", createdAt: 1, direction: "in", metadata, transfer: done });
});

function world() {
  const node = {
    getState: () => ({ links: [], groups: [group], settings: {}, transport: {}, transfers: {} }) as unknown as EngineState,
    fileAction: vi.fn(async () => {}),
    fileMessages: vi.fn(async () => [{ id: "me_5", sender: "me", timestamp: 5, file: { id: OUT, name: "big.bin", size: 95, mime: "application/octet-stream" } }]),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

describe("file cancel and pause of a group's file sent from here", () => {
  it("say the members fetch it, and that deleting its message for everyone takes it back", async () => {
    const { ctx, node } = world();
    for (const action of ["cancel", "pause", "decline"]) {
      await expect(callApi(ctx, "file.action", { file: OUT, action })).rejects.toMatchObject({
        code: "refused",
        message: "A file sent to a group is fetched by the members from whoever holds it: it is not stopped from here (ghostly message delete group:g1 me_5 takes it back from everyone)",
        details: { reason: "sent_to_group", group: "g1", messageId: "me_5" },
      });
    }
    expect(node.fileAction).not.toHaveBeenCalled();
  });

  it("a received one all here still says nothing is coming", async () => {
    const { ctx } = world();
    await expect(callApi(ctx, "file.action", { file: IN, action: "cancel" })).rejects.toMatchObject({ code: "refused", message: "Nothing to stop: the file is all here" });
  });
});
