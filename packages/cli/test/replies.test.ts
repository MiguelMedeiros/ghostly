import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { parseArgs } from "../src/args";
import { TEXT_COMMANDS } from "../src/commands";
import { EventHub, type GhostlyEvent } from "../src/events";
import { openPersistentIndexedDb } from "../src/runtime/storage";
import { messageJson } from "../src/views";
// covers: headless.replies

/** `--reply` on send and group send, and `replyTo` on what the stream says about a message. */
const link = (id: string, fields: Partial<LinkView> = {}) => ({ id, peerPubKeyZ32: "p" + id, createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" }, ...fields }) as unknown as LinkView;
const group = { id: "g1", name: "Crew", createdAt: 1, profile: "community", isAdmin: true, canSend: true, lastMessageAt: 0, invited: [], memberLinks: {},
  members: [{ key: "mekey", role: "admin", me: true, online: true, missing: 0 }] } as unknown as GroupView;
const WIRE = "-".concat("A".repeat(21));

function fake(sendResult: { error: string | null; refused?: boolean; messageId?: string } = { error: null, messageId: "me_2" }) {
  const node = {
    getState: () => ({ links: [link("chat-one", { label: "Alice" })], groups: [group], settings: {}, transport: {} }) as unknown as EngineState,
    getMessages: vi.fn(async () => []),
    sendMessage: vi.fn(async () => sendResult),
    sendGroupMessage: vi.fn(async () => ({ error: sendResult.error })),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

describe("--reply", () => {
  it("is an option of send and group send, even for an id that starts with a dash", () => {
    expect(parseArgs(["alice", "yes", "--reply", WIRE], TEXT_COMMANDS.send.options).options.reply).toBe(WIRE);
    expect(parseArgs(["Crew", "on it", `--reply=peer_x`], TEXT_COMMANDS["group send"].options).options.reply).toBe("peer_x");
    expect(TEXT_COMMANDS.send.usage).toContain("--reply <message>");
  });

  it("goes to the engine as replyTo; one the chat does not have is refused", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "chat.send", { chat: "Alice", text: "yes", reply: "peer_abc" })).toMatchObject({ messageId: "me_2" });
    expect(node.sendMessage).toHaveBeenCalledWith({ linkId: "chat-one", text: "yes", replyTo: "peer_abc" });
    await callApi(ctx, "chat.send", { chat: "Alice", text: "plain" });
    expect(node.sendMessage).toHaveBeenLastCalledWith({ linkId: "chat-one", text: "plain" });
    await callApi(ctx, "group.send", { group: "Crew", text: "on it", reply: "k:0:1" });
    expect(node.sendGroupMessage).toHaveBeenCalledWith({ groupId: "g1", text: "on it", replyTo: "k:0:1" });
    const refused = fake({ error: "That message is not in this chat, or cannot be replied to", refused: true });
    await expect(callApi(refused.ctx, "chat.send", { chat: "Alice", text: "yes", reply: "nope" })).rejects.toMatchObject({ code: "refused" });
  });
});

describe("replyTo on a message", () => {
  const message = (fields: Partial<StoredMessage>): StoredMessage => ({ linkId: "c1", id: "peer_r", text: "yes", sender: "peer", timestamp: 1, via: "datalink", ...fields });

  it("names the original by its id here when it is here, else by the id the reply named", () => {
    expect(messageJson(message({ replyTo: { id: "W".repeat(22), snippet: "lunch?", from: "me", messageId: "me_W" } })).replyTo)
      .toEqual({ id: "me_W", snippet: "lunch?", from: "me", found: true });
    expect(messageJson(message({ replyTo: { id: "W".repeat(22), snippet: "" } })).replyTo)
      .toEqual({ id: "W".repeat(22), snippet: "", from: null, found: false });
    expect(messageJson(message({ linkId: "group:g", replyTo: { id: "k:0:1", snippet: "hi", from: "peer", member: "k" } })).replyTo)
      .toEqual({ id: "k:0:1", snippet: "hi", from: "peer", member: "k", found: false });
    expect(messageJson(message({}))).not.toHaveProperty("replyTo");
  });

  let dir: string;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), "ghostly-replies-")); await openPersistentIndexedDb(join(dir, "db")); });

  it("rides on message.received", async () => {
    const hub = new EventHub(join(dir, "r.jsonl"), () => 1000, "r.jsonl");
    await hub.open();
    const events: GhostlyEvent[] = [];
    hub.onEvent((e) => events.push(e));
    const state = { links: [link("c1")], groups: [], settings: {}, transport: {} } as unknown as EngineState;
    hub.baseline(state, new Map([["c1", []]]));
    hub.sink.post({ kind: "messages", linkId: "c1", messages: [message({ replyTo: { id: "W".repeat(22), snippet: "lunch?", from: "me", messageId: "me_W" } })] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "message.received", chat: "c1", message: { id: "peer_r", replyTo: { id: "me_W", snippet: "lunch?", from: "me", found: true } } });
  });
});
