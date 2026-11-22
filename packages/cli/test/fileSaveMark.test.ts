import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { copyForForward } from "@ghostly/browser/engine/forwards";
import { registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import { fileStore } from "@ghostly/browser/shared/idb";
import type { EngineState, LinkView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { NodeFileBytes } from "../src/runtime/fileBytes";
import { openPersistentIndexedDb } from "../src/runtime/storage";
import { chatViewOf } from "./support/chatView";
// covers: headless.files

/** What `xattr` was run with, and whether the saved file was already there with its bytes when it ran. */
const xattr = vi.hoisted(() => [] as { args: string[]; bytes?: string }[]);
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const { existsSync: there, readFileSync: read } = await import("node:fs");
  return {
    ...real,
    execFile: (file: string, args: string[], _options: unknown, done: (error: Error | null) => void) => {
      const path = args[args.length - 1];
      xattr.push({ args: [file, ...args], bytes: there(path) ? read(path, "utf8") : undefined });
      done(null);
    },
  };
});

/** `file save` marks a saved file as downloaded, as a browser and Ghostly Desktop do: a contact's, forwarded or not, and so every one. */
const link = { id: "chat-one", label: "Alice", peerPubKeyZ32: "palice", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", dataLink: "idle",
  capabilities: { files: true }, pairing: { status: "ready" } } as unknown as LinkView;

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-file-save-mark-"));
  await openPersistentIndexedDb(join(dir, "db"));
  registerFileBytes("native", async () => new NodeFileBytes(join(dir, "files")), true);
  await fileStore.put({ id: "chat-one-in-cmd", linkId: "chat-one", createdAt: 1, direction: "in", blob: new Blob(["#!/bin/sh\necho boo\n"]),
    metadata: { name: "run me.command", size: 19, mime: "application/octet-stream", timestamp: 1 } } as never);
});

const platform = process.platform;
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
  xattr.length = 0;
});

function world() {
  const node = {
    chatView: chatViewOf,
    getState: () => ({ links: [link], groups: [], settings: {}, transport: {}, transfers: {} }) as unknown as EngineState,
    getMessages: vi.fn(async () => []),
    getMessage: vi.fn(async () => undefined),
    sendFile: vi.fn(async () => {}),
  };
  return { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
}

describe("file save marks a received file as downloaded", () => {
  it("on macOS: com.apple.quarantine on the saved copy, once its bytes are in place", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const folder = mkdtempSync(join(dir, "mac-"));
    const saved = await callApi(world(), "file.save", { file: "chat-one-in-cmd", dir: folder }) as { path: string };
    expect(saved.path).toBe(join(folder, "run me.command"));
    expect(xattr).toHaveLength(1);
    const [file, flag, name, value, path] = xattr[0].args;
    expect([file, flag, name, path]).toEqual(["/usr/bin/xattr", "-w", "com.apple.quarantine", saved.path]);
    expect(value).toMatch(/^0081;[0-9a-f]{8};Ghostly;$/u);
    expect(Math.abs(parseInt(value.split(";")[1], 16) - Date.now() / 1000)).toBeLessThan(60);
    expect(xattr[0].bytes).toBe("#!/bin/sh\necho boo\n");
  });

  it("on Windows: the Zone.Identifier stream of the internet zone", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const folder = mkdtempSync(join(dir, "win-"));
    const saved = await callApi(world(), "file.save", { file: "chat-one-in-cmd", path: join(folder, "run me.cmd") }) as { path: string };
    // Off NTFS (this test's Linux) the stream is a file named after it: what was written is still what Windows reads.
    expect(readFileSync(`${saved.path}:Zone.Identifier`, "utf8")).toBe("[ZoneTransfer]\r\nZoneId=3\r\n");
    expect(readFileSync(saved.path, "utf8")).toBe("#!/bin/sh\necho boo\n");
  });

  it("a file sent from here is marked too, as Desktop marks every save", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const ctx = world();
    const source = join(dir, "report.txt");
    writeFileSync(source, "quarterly data");
    const sent = await callApi(ctx, "file.send", { chat: "Alice", path: source }) as { file: { id: string } };
    const copy = join(mkdtempSync(join(dir, "sent-")), "copy.txt");
    await callApi(ctx, "file.save", { file: sent.file.id, path: copy });
    expect(readFileSync(copy, "utf8")).toBe("quarterly data");
    expect(readFileSync(`${copy}:Zone.Identifier`, "utf8")).toBe("[ZoneTransfer]\r\nZoneId=3\r\n");
    Object.defineProperty(process, "platform", { value: "darwin" });
    await callApi(ctx, "file.save", { file: sent.file.id, path: `${copy}.2` });
    expect(xattr.map((call) => call.args[4])).toEqual([`${copy}.2`]);
  });

  it("a contact's file forwarded to another chat is marked: its copy is sent from here, its bytes and name are the contact's", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const file = { id: "chat-two-out-fwd", name: "run me.command", size: 19, mime: "application/octet-stream" };
    await copyForForward("chat-one-in-cmd", { linkId: "chat-two", wireId: "fwd", timestamp: 2, file });
    expect((await fileStore.get(file.id))?.direction).toBe("out");
    const saved = await callApi(world(), "file.save", { file: file.id, dir: mkdtempSync(join(dir, "fwd-")) }) as { path: string };
    expect(xattr.map((call) => call.args.slice(1, 3).concat(call.args[4]))).toEqual([["-w", "com.apple.quarantine", saved.path]]);
    expect(xattr[0].bytes).toBe("#!/bin/sh\necho boo\n");
  });

  it("a file system that takes no mark still gets the file", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const folder = mkdtempSync(join(dir, "nomark-"));
    const target = join(folder, "a.txt");
    // A folder where the stream would go: the mark cannot be written, the save still succeeds.
    mkdirSync(`${target}:Zone.Identifier`);
    expect(await callApi(world(), "file.save", { file: "chat-one-in-cmd", path: target })).toMatchObject({ path: target, size: 19 });
    expect(readFileSync(target, "utf8")).toBe("#!/bin/sh\necho boo\n");
  });
});
