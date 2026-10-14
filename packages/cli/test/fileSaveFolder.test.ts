import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { fileStore } from "@ghostly/browser/shared/idb";
import type { EngineState } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { parseArgs } from "../src/args";
import { COMMANDS, positionals } from "../src/commands";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.files

/**
 * `file save --path` naming a folder: a bad_request that says to name a file or use --dir, never a hint to --force over
 * it (which then failed "is a folder"); an empty --path or --dir is a usage error, not the current folder.
 */
let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-file-save-folder-"));
  await openPersistentIndexedDb(join(dir, "db"));
  await fileStore.put({
    id: "chat-one-in-r", linkId: "chat-one", blob: new Blob(["report"]), createdAt: 1, direction: "in",
    metadata: { name: "report.txt", size: 6, mime: "text/plain", timestamp: 1 },
    transfer: { state: "done", transferred: 6, size: 6 },
  } as never);
});

const node = { getState: () => ({ links: [], groups: [], settings: {}, transport: {}, transfers: {} }) as unknown as EngineState };
const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;

describe("file save to a folder", () => {
  it("is a bad_request that points at --dir, with or without --force", async () => {
    const folder = join(dir, "folder");
    mkdirSync(folder);
    const message = `${folder} is a folder: name a file, or use dir (--dir ${folder})`;
    await expect(callApi(ctx, "file.save", { file: "chat-one-in-r", path: folder })).rejects.toMatchObject({ code: "bad_request", message });
    await expect(callApi(ctx, "file.save", { file: "chat-one-in-r", path: folder, force: true })).rejects.toMatchObject({ code: "bad_request", message });
    await expect(callApi(ctx, "file.save", { file: "chat-one-in-r", path: "/" })).rejects.toMatchObject({ code: "bad_request", message: "/ is a folder: name a file, or use dir (--dir /)" });
    // --dir saves into it; a file there is still a confirm.
    expect(await callApi(ctx, "file.save", { file: "chat-one-in-r", dir: folder })).toMatchObject({ path: join(folder, "report.txt"), size: 6 });
    expect(readFileSync(join(folder, "report.txt"), "utf8")).toBe("report");
    await expect(callApi(ctx, "file.save", { file: "chat-one-in-r", path: join(folder, "report.txt") })).rejects.toMatchObject({ code: "confirm" });
  });

  it("an empty --path or --dir is a usage error", () => {
    const params = (argv: string[]) => {
      const command = COMMANDS["file save"];
      const parsed = parseArgs(argv, command.options ?? {});
      return command.params!(parsed, positionals(command, parsed.positionals));
    };
    expect(() => params(["chat-one-in-r", "--path", ""])).toThrow(expect.objectContaining({ code: "usage", message: "--path needs a file" }));
    expect(() => params(["chat-one-in-r", "--dir", ""])).toThrow(expect.objectContaining({ code: "usage", message: "--dir needs a folder" }));
    expect(params(["chat-one-in-r", "--path", "out.txt"])).toMatchObject({ path: join(process.cwd(), "out.txt") });
  });
});
