import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { EngineState, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { parseArgs } from "../src/args";
import { idSlot, TEXT_COMMANDS } from "../src/commands";
import { EventHub, type GhostlyEvent } from "../src/events";
import { openPersistentIndexedDb } from "../src/runtime/storage";
import { messageJson } from "../src/views";
// covers: headless.edit

/** `ghostly edit`, and what the stream and the history say about an edited message (WISP 400 § Edits). */
const link = (id: string, fields: Partial<LinkView> = {}) => ({ id, peerPubKeyZ32: "p" + id, createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" }, ...fields }) as unknown as LinkView;
const row = (fields: Partial<StoredMessage> = {}): StoredMessage => ({ linkId: "c1", id: "me_w", wireId: "W".repeat(22), text: "Working", sender: "me", timestamp: 1, via: "datalink", delivery: "delivered", ...fields });

function fake(result: { error: string | null; refused?: boolean; messageId?: string } = { error: null, messageId: "me_w" }, messages: StoredMessage[] = [row({ text: "Done", edit: { seq: 1, at: 5, history: [{ at: 1, text: "Working" }] } })]) {
  const node = {
    getState: () => ({ links: [link("chat-one", { label: "Alice" })], groups: [], settings: {}, transport: {} }) as unknown as EngineState,
    getMessages: vi.fn(async () => messages),
    editMessage: vi.fn(async () => result),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

describe("ghostly edit", () => {
  it("names the message before the text, and takes the text from stdin too", () => {
    const parsed = parseArgs(["alice", "me_w", "Done", "--stdin", "--wait", "confirmed"], TEXT_COMMANDS.edit.options);
    expect(parsed.positionals).toEqual(["alice", "me_w", "Done"]);
    expect(parsed.options).toMatchObject({ stdin: true, wait: "confirmed" });
    expect(TEXT_COMMANDS.edit).toMatchObject({ method: "chat.edit", message: true });
    expect(TEXT_COMMANDS.edit.usage).toBe("edit <chat> <message> [text... | --text <text> | --stdin] [--force] [--wait none|confirmed]");
    expect(parseArgs(["alice", "me_w", "--text", "-starts with a dash"], TEXT_COMMANDS.edit.options).options.text).toBe("-starts with a dash");
    // A wire id may start with a dash: in the message's place it is an id, not an option.
    const dashed = "-" + "A".repeat(21);
    expect(parseArgs(["alice", dashed, "Done"], TEXT_COMMANDS.edit.options, idSlot(TEXT_COMMANDS.edit)).positionals).toEqual(["alice", dashed, "Done"]);
  });

  it("goes to the engine, and says how many edits the message has and whether the contact confirmed the last", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "chat.edit", { chat: "Alice", message: "me_w", text: "Done" })).toEqual({ chat: "chat-one", messageId: "me_w", edits: 1, confirmed: true });
    expect(node.editMessage).toHaveBeenCalledWith({ linkId: "chat-one", messageId: "me_w", text: "Done" });
    const refused = fake({ error: "Only your own text messages can be edited", refused: true });
    await expect(callApi(refused.ctx, "chat.edit", { chat: "Alice", message: "peer_x", text: "x" })).rejects.toMatchObject({ code: "refused" });
    // The secret guard, as on send.
    await expect(callApi(ctx, "chat.edit", { chat: "Alice", message: "me_w", text: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" })).rejects.toMatchObject({ code: "confirm" });
  });

  it("--wait confirmed times out while the contact has not confirmed", async () => {
    const { ctx } = fake(undefined, [row({ text: "Done", edit: { seq: 2, at: 5, history: [], pending: true } })]);
    await expect(callApi(ctx, "chat.edit", { chat: "Alice", message: "me_w", text: "Done", wait: "confirmed", timeout: 1 })).rejects.toMatchObject({ code: "timeout" });
    expect(await callApi(ctx, "chat.edit", { chat: "Alice", message: "me_w", text: "Done" })).toMatchObject({ edits: 2, confirmed: false });
  });
});

describe("an edited message in the stream and the history", () => {
  it("carries its edit number and when it was made", () => {
    expect(messageJson(row({ edit: { seq: 3, at: 99, history: [] } }))).toMatchObject({ text: "Working", edits: 3, editedAt: 99 });
    expect(messageJson(row({ edit: { seq: 1, at: 9, history: [], pending: true } }))).toMatchObject({ editPending: true });
    expect(messageJson(row())).not.toHaveProperty("edits");
  });

  let dir: string;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), "ghostly-edits-")); await openPersistentIndexedDb(join(dir, "db")); });

  it("says message.edited once per edit number, for the contact's messages and mine, and delivery apart", async () => {
    const hub = new EventHub(join(dir, "e.jsonl"), () => 1000, "e.jsonl");
    await hub.open();
    const events: GhostlyEvent[] = [];
    hub.onEvent((e) => events.push(e));
    hub.baseline({ links: [link("c1")], groups: [], settings: {}, transport: {} } as unknown as EngineState, new Map([["c1", []]]));
    const peer = (fields: Partial<StoredMessage>) => row({ id: "peer_p", wireId: undefined, sender: "peer", delivery: undefined, text: "v0", ...fields });
    const post = (messages: StoredMessage[]) => hub.sink.post({ kind: "messages", linkId: "c1", messages });
    post([peer({})]);
    post([peer({ text: "v1", edit: { seq: 1, at: 2, history: [] } })]);
    post([peer({ text: "v1", edit: { seq: 1, at: 2, history: [] } })]);
    post([peer({ text: "v3", edit: { seq: 3, at: 4, history: [] } })]);
    expect(events.map((e) => [e.type, e.edits ?? null])).toEqual([["message.received", null], ["message.edited", 1], ["message.edited", 3]]);
    expect(events[2]).toMatchObject({ id: "message.edited:c1:peer_p:3", chat: "c1", messageId: "peer_p", message: { text: "v3", edits: 3 } });
    events.length = 0;
    post([peer({ text: "v3", edit: { seq: 3, at: 4, history: [] } }), row({ delivery: "sending" })]);
    post([peer({ text: "v3", edit: { seq: 3, at: 4, history: [] } }), row({ delivery: "delivered" })]);
    post([peer({ text: "v3", edit: { seq: 3, at: 4, history: [] } }), row({ text: "Done", delivery: "delivered", edit: { seq: 1, at: 5, history: [], pending: true } })]);
    post([peer({ text: "v3", edit: { seq: 3, at: 4, history: [] } }), row({ text: "Done", delivery: "delivered", edit: { seq: 1, at: 5, history: [] } })]);
    expect(events.map((e) => [e.type, e.delivery ?? e.edits ?? null])).toEqual([["message.sent", null], ["message.delivery", "delivered"], ["message.edited", 1]]);
  });
});
