import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { voiceDownloadName } from "@ghostly/core";
import { fileStore } from "@ghostly/browser/shared/idb";
import type { EngineState } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { parseArgs } from "../src/args";
import { COMMANDS, positionals } from "../src/commands";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.files

/**
 * `file save --path` naming a folder: a bad_request that says to name a file or use --dir, never a hint to --force over
 * it (which then failed "is a folder"); an empty --path or --dir is a usage error, not the current folder. A voice message
 * goes into --dir under the name Ghostly makes for it, as the apps' Download does, its row looked for among the chat's
 * newest first: the whole history of a 20,000-message chat costs a quarter of a second to read.
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
  await fileStore.put({
    id: "chat-one-in-v", linkId: "chat-one", blob: new Blob(["MZ"]), createdAt: 1, direction: "in",
    metadata: { name: "Setup.exe", size: 2, mime: "audio/webm", timestamp: 1_700_000_000_000, voice: { duration: 4_200, peaks: [] } },
    transfer: { state: "done", transferred: 2, size: 2 },
  } as never);
  // Its sender claims a time past Date's end: files/3 takes any safe integer.
  await fileStore.put({
    id: "chat-one-in-far", linkId: "chat-one", blob: new Blob(["far"]), createdAt: 1_700_000_200_000, direction: "in",
    metadata: { name: "far.webm", size: 3, mime: "audio/webm", timestamp: 8_700_000_000_000_000, voice: { duration: 1_000, peaks: [] } },
    transfer: { state: "done", transferred: 3, size: 3 },
  } as never);
});

// The rows the chat shows: each at the place it came, the sender's claim kept beside it.
const rows = [
  { id: "peer_v", sender: "peer", timestamp: 1_700_000_005_000, sentAt: 1_700_000_000_000, file: { id: "chat-one-in-v" } },
  { id: "peer_far", sender: "peer", timestamp: 1_700_000_100_000, file: { id: "chat-one-in-far" } },
];
// Past the newest 200: only in the whole history.
const older = { id: "peer_old", sender: "peer", timestamp: 1_600_000_005_000, file: { id: "chat-one-in-old" } };
const node = {
  getState: () => ({ links: [], groups: [], settings: {}, transport: {}, transfers: {} }) as unknown as EngineState,
  messagePage: vi.fn(async ({ linkId }: { linkId: string }) => ({ messages: linkId === "chat-one" ? rows : [], more: true })),
  getMessages: vi.fn(async (linkId: string) => linkId === "chat-one" ? [older, ...rows] : []),
};
beforeEach(() => { node.messagePage.mockClear(); node.getMessages.mockClear(); });
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

  it("a folder that is not there, or is a file, is named alone: the received file is all here", async () => {
    const missing = join(dir, "nofolder");
    await expect(callApi(ctx, "file.save", { file: "chat-one-in-r", dir: missing })).rejects.toMatchObject({ code: "not_found", message: `No such file or folder: ${missing}` });
    await expect(callApi(ctx, "file.save", { file: "chat-one-in-r", path: join(missing, "x.txt") })).rejects.toMatchObject({ code: "not_found", message: `No such file or folder: ${missing}` });
    const file = join(dir, "plain.txt");
    writeFileSync(file, "x");
    await expect(callApi(ctx, "file.save", { file: "chat-one-in-r", dir: file })).rejects.toMatchObject({ code: "not_found", message: `${file} is a file, not a folder` });
  });

  it("a voice message goes into --dir under the name Ghostly makes for it, never the sender's", async () => {
    const folder = join(dir, "voice");
    mkdirSync(folder);
    // Named from its row's time, as the apps' Download names it, not the time its sender says.
    const name = voiceDownloadName("audio/webm", 1_700_000_005_000);
    expect(await callApi(ctx, "file.save", { file: "chat-one-in-v", dir: folder })).toMatchObject({ path: join(folder, name) });
    expect(readdirSync(folder)).toEqual([name]);
    // Found among the chat's newest: its whole history is not read.
    expect(node.messagePage).toHaveBeenCalledWith({ linkId: "chat-one", limit: 200 });
    expect(node.getMessages).not.toHaveBeenCalled();
  });

  it("a voice message older than the chat's newest is named from its row all the same", async () => {
    await fileStore.put({
      id: "chat-one-in-old", linkId: "chat-one", blob: new Blob(["old"]), createdAt: 1, direction: "in",
      metadata: { name: "old.webm", size: 3, mime: "audio/webm", timestamp: 1_600_000_000_000, voice: { duration: 1_000, peaks: [] } },
      transfer: { state: "done", transferred: 3, size: 3 },
    } as never);
    const folder = join(dir, "old");
    mkdirSync(folder);
    const name = voiceDownloadName("audio/webm", 1_600_000_005_000);
    expect(await callApi(ctx, "file.save", { file: "chat-one-in-old", dir: folder })).toMatchObject({ path: join(folder, name) });
    expect(node.getMessages).toHaveBeenCalledWith("chat-one");
  });

  it("two voice messages of one second both go into --dir: the second under a free name, as a browser's Download picks", async () => {
    const folder = join(dir, "same-second");
    mkdirSync(folder);
    for (const [id, at] of [["chat-one-in-va", 1_760_000_000_100], ["chat-one-in-vb", 1_760_000_000_900], ["chat-one-in-vc", 1_760_000_000_500]] as const) {
      await fileStore.put({
        id, linkId: "chat-one", blob: new Blob([id]), createdAt: 1, direction: "in",
        metadata: { name: `${id}.webm`, size: id.length, mime: "audio/webm", timestamp: at, voice: { duration: 4_200, peaks: [] } },
        transfer: { state: "done", transferred: id.length, size: id.length },
      } as never);
    }
    const name = voiceDownloadName("audio/webm", 1_760_000_000_100), stem = name.slice(0, -".webm".length);
    expect(await callApi(ctx, "file.save", { file: "chat-one-in-va", dir: folder })).toMatchObject({ path: join(folder, name) });
    expect(await callApi(ctx, "file.save", { file: "chat-one-in-vb", dir: folder })).toMatchObject({ path: join(folder, `${stem} (2).webm`) });
    expect(await callApi(ctx, "file.save", { file: "chat-one-in-vc", dir: folder })).toMatchObject({ path: join(folder, `${stem} (3).webm`) });
    expect(readFileSync(join(folder, name), "utf8")).toBe("chat-one-in-va");
    expect(readFileSync(join(folder, `${stem} (2).webm`), "utf8")).toBe("chat-one-in-vb");
    expect(readFileSync(join(folder, `${stem} (3).webm`), "utf8")).toBe("chat-one-in-vc");
    // A --path the user named is never renamed: there it is still a confirm.
    await expect(callApi(ctx, "file.save", { file: "chat-one-in-vb", path: join(folder, name) })).rejects.toMatchObject({ code: "confirm" });
  });

  it("a voice message whose sender claims a time no date can hold is named from its row's time, never NaN", async () => {
    const folder = join(dir, "far");
    mkdirSync(folder);
    const name = voiceDownloadName("audio/webm", 1_700_000_100_000);
    expect(await callApi(ctx, "file.save", { file: "chat-one-in-far", dir: folder })).toMatchObject({ path: join(folder, name) });
    expect(readdirSync(folder)).toEqual([name]);
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
