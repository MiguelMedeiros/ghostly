import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { registerFileBytes } from "@ghostly/browser/shared/fileBytes";
import type { EngineState, LinkView, MessageFile } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { CliError } from "../src/errors";
import { NodeFileBytes } from "../src/runtime/fileBytes";
import { openPersistentIndexedDb } from "../src/runtime/storage";
import { dhtOnlyChat, dhtOnlyNotice, waitNotice } from "../src/waitNotice";
import { chatViewOf } from "./support/chatView";
// covers: headless.files, chat.dht.delivery

/**
 * A file in a chat on the DHT only (this side's choice, the contact's, or a hold): it goes on a live session only, which
 * neither side's app tries while either keeps the chat there. `file send --wait sent`'s timeout said it "still goes by
 * itself", `file wait`'s said it waited "for a connection to the contact", and the notice and Ctrl-C on a terminal
 * said it still went: a person waited for good. Each says what ends the wait. A chat that holds items for the contact
 * (WISP 404) sends the file without a live session, and says nothing of one.
 */
const chatOf = (deliveryMode: string, peerMode?: string) => ({ id: "chat-dht", label: "Bob", peerPubKeyZ32: "pbob", createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", dataLink: "closed",
  capabilities: { files: true }, pairing: { status: "ready" }, deliveryMode, ...(peerMode ? { dhtDelivery: { peerMode } } : {}) }) as unknown as LinkView;

const mine = "A file goes only on a live session, and this chat is on the DHT only: it goes once you choose a live transport (ghostly chat transport Bob auto)";
const theirs = "A file goes only on a live session, and the contact keeps this chat on the DHT only: it goes once they choose a live transport";

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ghostly-file-dht-"));
  await openPersistentIndexedDb(join(dir, "db"));
  registerFileBytes("native", async () => new NodeFileBytes(join(dir, "files")), true);
});

function contextFor(link: LinkView, transfers: Record<string, unknown> = {}) {
  const files: { id: string; file: MessageFile; sender: string; timestamp: number; via?: string; delivery?: string }[] = [];
  // A chat that holds (WISP 404) takes the file as node.ts `sendFile` does: held, on its way without a live session.
  const held = link.textDelivery === "hold";
  const node = {
    chatView: chatViewOf,
    getState: () => ({ links: [link], groups: [], settings: {}, transport: {}, transfers }) as unknown as EngineState,
    getMessages: vi.fn(async () => []),
    getMessage: vi.fn(async () => undefined),
    fileMessages: vi.fn(async () => files),
    sendFile: vi.fn(async ({ file, timestamp }: { file: MessageFile; timestamp: number }) => {
      if (held) transfers[file.id] = { state: "transferring", transferred: 0, size: file.size, direction: "out" };
      files.push({ id: `me_${timestamp}`, file, sender: "me", timestamp, ...(held && { via: "hold", delivery: "sending" }) });
    }),
  };
  return { runtime: { server: { node }, paths: { name: "default", dir } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
}

async function send(ctx: ApiContext, name: string, params: Record<string, unknown> = {}) {
  const path = join(dir, name);
  writeFileSync(path, "notes");
  return callApi(ctx, "file.send", { chat: "Bob", path, ...params }) as Promise<Record<string, unknown>>;
}

describe("a file in a chat on the DHT only", () => {
  it("a --wait sent timeout says the note, not that it goes by itself", async () => {
    const error = await send(contextFor(chatOf("dht")), "wait.txt", { wait: "sent", timeout: 1 }).then(() => null, (e: unknown) => e) as CliError;
    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe("timeout");
    expect(error.message).not.toMatch(/goes by itself|connection to the contact/);
    expect(error.message).toContain(`It is kept here. ${mine}`);
    expect(error.details).toMatchObject({ chat: "chat-dht" });
    const contacts = await send(contextFor(chatOf("auto", "dht")), "theirs.txt", { wait: "sent", timeout: 1 }).then(() => null, (e: unknown) => e) as CliError;
    expect(contacts.message).toContain(`It is kept here. ${theirs}`);
    // A chat that can be live: the file goes once it is.
    const live = await send(contextFor(chatOf("auto")), "live.txt", { wait: "sent", timeout: 1 }).then(() => null, (e: unknown) => e) as CliError;
    expect(live.message).not.toMatch(/only on a live session/);
  });

  it("a chat that holds the file for the contact says nothing of a live session: the file goes without one", async () => {
    const held = { ...chatOf("dht"), textDelivery: "hold" } as LinkView;
    const error = await send(contextFor(held), "held.txt", { wait: "sent", timeout: 1 }).then(() => null, (e: unknown) => e) as CliError;
    expect(error.code).toBe("timeout");
    expect(error.message).not.toMatch(/only on a live session/);
  });

  it("file wait on a waiting transfer says the note, not a connection to the contact", async () => {
    const id = "chat-dht-out-moving";
    const ctx = contextFor(chatOf("dht"), { [id]: { transferred: 8_650_752, size: 18_000_000, direction: "out", state: "transferring", stage: "waiting" } });
    const error = await callApi(ctx, "file.wait", { chat: "Bob", file: id, timeout: 1 }).then(() => null, (e: unknown) => e) as CliError;
    expect(error.code).toBe("timeout");
    expect(error.message).toContain(`(8650752 of 18000000 bytes, ${mine})`);
    expect(error.details).toMatchObject({ stage: "waiting" });
    // Without the chat, the command names it by its id, which always finds it.
    const byId = await callApi(ctx, "file.wait", { file: id, timeout: 1 }).then(() => null, (e: unknown) => e) as CliError;
    expect(byId.message).toContain("(ghostly chat transport chat-dht auto)");
  });

  it("a file send's notice and Ctrl-C on a terminal say the note", () => {
    const params = { chat: "Bob", path: "/f", name: "notes.txt", wait: "sent", timeout: 20 };
    expect(dhtOnlyChat("file.send", params)).toBe("Bob");
    expect(dhtOnlyChat("file.send", { chat: "group:crew", path: "/f" })).toBeUndefined();
    const notice = waitNotice("file.send", params, "daemon")!;
    expect(dhtOnlyNotice(notice, "file.send", params, { deliveryMode: "dht", peerDeliveryMode: null }, "daemon")).toEqual({
      waiting: `copying notes.txt into the profile, then waiting for it to go out to Bob (up to 20 s; Ctrl-C stops the send while it is copied in, then only the waiting). ${mine}`,
      stopped: `notes.txt was not sent to Bob if it was still being copied in; if it was in the chat or group, it is kept here (ghostly file list Bob says which). ${mine}`,
    });
    expect(dhtOnlyNotice(notice, "file.send", params, { deliveryMode: "auto", peerDeliveryMode: null }, "daemon")).toBe(notice);
    // A chat that holds it for the contact: it goes without a live session, as the notice already says.
    expect(dhtOnlyNotice(notice, "file.send", params, { deliveryMode: "dht", peerDeliveryMode: null, text: "hold" }, "daemon")).toBe(notice);
  });
});
