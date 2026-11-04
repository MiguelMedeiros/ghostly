import { describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView, SavedMessage, StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { parseArgs } from "../src/args";
import { COMMANDS, idSlot, positionals } from "../src/commands";
import { readOnly } from "../src/main";
// covers: chat.saved

/** `saved add|remove|list`: saved messages, kept for the profile on this device. */
const link = (id: string, fields: Partial<LinkView> = {}) => ({ id, peerPubKeyZ32: "p" + id, createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" }, ...fields }) as unknown as LinkView;
const group = (fields: Partial<GroupView> = {}) => ({ id: "g1", name: "Crew", createdAt: 1, profile: "mesh", isAdmin: false, canSend: true, lastMessageAt: 0, invited: [], memberLinks: {},
  members: [{ key: "mekey", role: "member", me: true, online: true, missing: 0 }, { key: "hermes", role: "member", nick: "Hermes", online: true, missing: 0 }], ...fields }) as unknown as GroupView;
const row = (linkId: string, id: string, patch: Partial<StoredMessage> = {}): StoredMessage => ({ linkId, id, text: `text of ${id}`, sender: "peer", timestamp: 1000, via: "datalink", ...patch });

function fake(result: { error: string | null } = { error: null }, saved: SavedMessage[] = [], rows: StoredMessage[] = saved.map((s) => s.message)) {
  const node = {
    getState: () => ({ links: [link("chat-one", { label: "Alice", peerNick: "Alice" })], groups: [group()], settings: {}, transport: {} }) as unknown as EngineState,
    saveMessage: vi.fn(async () => result),
    savedMessages: vi.fn(async () => saved),
    getMessage: vi.fn(async (linkId: string, id: string) => rows.find((m) => m.linkId === linkId && m.id === id)),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

const line = (command: "saved add" | "saved remove", ...argv: string[]) => {
  const spec = COMMANDS[command], parsed = parseArgs(argv, spec.options ?? {}, idSlot(spec));
  return spec.params!(parsed, positionals(spec, parsed.positionals));
};

describe("saved", () => {
  it("takes a chat or a group and a message", () => {
    expect(COMMANDS["saved add"].usage).toBe("saved add <chat|group> <message>");
    expect(line("saved add", "alice", "peer_x")).toEqual({ chat: "alice", message: "peer_x" });
    expect(line("saved remove", "crew", "-k:0:1")).toEqual({ chat: "crew", message: "-k:0:1" });
    expect(() => line("saved add", "alice")).toThrow(/Missing <message>/);
  });

  it("saves and unsaves through the engine, in a chat or a group; a message not there is not_found", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "saved.add", { chat: "Alice", message: "peer_x" })).toEqual({ chat: "chat-one", messageId: "peer_x", saved: true });
    expect(node.saveMessage).toHaveBeenLastCalledWith({ linkId: "chat-one", messageId: "peer_x", remove: false });
    expect(await callApi(ctx, "saved.remove", { chat: "Crew", message: "k:0:1" })).toEqual({ group: "g1", messageId: "k:0:1", saved: false });
    expect(node.saveMessage).toHaveBeenLastCalledWith({ linkId: "group:g1", messageId: "k:0:1", remove: true });
    await expect(callApi(ctx, "saved.add", { chat: "Alice" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(callApi(fake({ error: "That message is not in this chat" }).ctx, "saved.add", { chat: "Alice", message: "x" })).rejects.toMatchObject({ code: "not_found" });
    // agents#1580: an unsave of an id that is neither saved nor in the chat (a typo) is not_found, with where the ids are.
    await expect(callApi(fake({ error: "That message is not in this chat" }).ctx, "saved.remove", { chat: "Alice", message: "no-such-id" }))
      .rejects.toMatchObject({ code: "not_found", message: expect.stringMatching(/^No saved message "no-such-id" in this chat \(ghostly saved list/) });
  });

  it("lists the saved messages with their chat or group and who wrote them", async () => {
    const saved = [
      { savedAt: 30, message: row("group:g1", "k:0:1", { member: "hermes" }) },
      { savedAt: 20, message: row("chat-one", "peer_y") },
    ];
    const list = await callApi(fake(undefined, saved).ctx, "saved.list", {}) as { chat?: string; group?: string; savedAt: number; message: { id: string; text: string; nick?: string } }[];
    expect(list.map((s) => [s.chat ?? s.group, s.savedAt, s.message.id, s.message.text, s.message.nick])).toEqual([
      ["g1", 30, "k:0:1", "text of k:0:1", "Hermes"],
      ["chat-one", 20, "peer_y", "text of peer_y", "Alice"],
    ]);
  });

  it("gives a saved reply whose original is gone as history does: not found, none of its text", async () => {
    const quoting = (to: string, snippet: string) => ({ sender: "me" as const, replyTo: { id: "wire-" + to, snippet, from: "me" as const, messageId: to } });
    const saved = [
      { savedAt: 40, message: row("group:g1", "mine:1:1", quoting("mine:1:0", "group original secret")) },
      { savedAt: 30, message: row("chat-one", "me_y", quoting("me_x", "the original secret text")) },
      { savedAt: 20, message: row("chat-one", "me_z", quoting("peer_kept", "kept")) },
    ];
    const { ctx, node } = fake(undefined, saved, [...saved.map((s) => s.message), row("chat-one", "peer_kept")]);
    const list = await callApi(ctx, "saved.list", {}) as { message: { id: string; replyTo?: Record<string, unknown> } }[];
    const quote = (id: string) => list.find((s) => s.message.id === id)?.message.replyTo;
    expect(quote("me_y")).toEqual({ id: "me_x", snippet: "", from: "me", found: false, deleted: true });
    expect(quote("mine:1:1")).toMatchObject({ snippet: "", found: false, deleted: true });
    expect(quote("me_z")).toMatchObject({ snippet: "kept", found: true });
    // One row read per quoted original, in its own chat or group.
    expect(node.getMessage.mock.calls.sort()).toEqual([["chat-one", "me_x"], ["chat-one", "peer_kept"], ["group:g1", "mine:1:0"]]);
  });

  it("opens the profile offline: nothing of it goes to a contact or a relay", () => {
    expect(readOnly("saved.list", {})).toBe(true);
  });
});
