import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView, PinView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { parseArgs } from "../src/args";
import { COMMANDS, idSlot, positionals } from "../src/commands";
import { EventHub, type GhostlyEvent } from "../src/events";
import { openPersistentIndexedDb } from "../src/runtime/storage";
// covers: headless.pins

/** `pin`, and the stream's `chat.pinned` / `group.pinned`. */
const link = (id: string, fields: Partial<LinkView> = {}) => ({ id, peerPubKeyZ32: "p" + id, createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" }, ...fields }) as unknown as LinkView;
const group = (fields: Partial<GroupView> = {}) => ({ id: "g1", name: "Crew", createdAt: 1, profile: "mesh", isAdmin: false, canSend: true, lastMessageAt: 0, invited: [], memberLinks: {},
  members: [{ key: "mekey", role: "member", me: true, online: true, missing: 0 }], ...fields }) as unknown as GroupView;

function fake(result: { error: string | null } = { error: null }) {
  const node = {
    getState: () => ({ links: [link("chat-one", { label: "Alice" })], groups: [group()], settings: {}, transport: {} }) as unknown as EngineState,
    pinMessage: vi.fn(async () => result),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

describe("pin", () => {
  /** The command line as `ghostly pin …` reads it: the words and options parsed, then the method's parameters. */
  const line = (...argv: string[]) => {
    const parsed = parseArgs(argv, COMMANDS.pin.options ?? {}, idSlot(COMMANDS.pin));
    return COMMANDS.pin.params!(parsed, positionals(COMMANDS.pin, parsed.positionals));
  };

  it("takes a chat or a group and a message, or --remove", () => {
    expect(COMMANDS.pin.usage).toBe("pin <chat|group> <message> | --remove");
    expect(line("alice", "peer_x")).toEqual({ chat: "alice", message: "peer_x", remove: false });
    expect(() => line("alice")).toThrow(/Missing <message>: ghostly pin <chat\|group> <message> \| --remove/);
    expect(() => line()).toThrow(/Missing <chat\|group>/);
    expect(() => line("alice", "peer_x", "peer_y")).toThrow(/Too many arguments/);
    // A group's id may start with a dash: it is still the message.
    expect(line("crew", "-k:0:1")).toEqual({ chat: "crew", message: "-k:0:1", remove: false });
  });

  it("unpins with --remove alone: no message is named, and one given is not asked for", () => {
    expect(line("alice", "--remove")).toEqual({ chat: "alice", message: undefined, remove: true });
    expect(line("--remove", "alice")).toEqual({ chat: "alice", message: undefined, remove: true });
    // A script that named the pinned message beside --remove goes on working.
    expect(line("alice", "peer_x", "--remove")).toEqual({ chat: "alice", message: "peer_x", remove: true });
    expect(() => line("alice", "peer_x", "peer_y", "--remove")).toThrow(/Too many arguments/);
  });

  it("goes to the engine for a chat or a group; --remove unpins; what the engine refuses is said", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "chat.pin", { chat: "Alice", message: "peer_x" })).toEqual({ chat: "chat-one", messageId: "peer_x", removed: false });
    expect(node.pinMessage).toHaveBeenLastCalledWith({ linkId: "chat-one", messageId: "peer_x", remove: false });
    expect(await callApi(ctx, "chat.pin", { chat: "Crew", message: "k:0:1" })).toEqual({ group: "g1", messageId: "k:0:1", removed: false });
    expect(node.pinMessage).toHaveBeenLastCalledWith({ linkId: "group:g1", messageId: "k:0:1", remove: false });
    expect(await callApi(ctx, "chat.pin", { chat: "Alice", message: "peer_x", remove: true })).toEqual({ chat: "chat-one", messageId: null, removed: true });
    expect(node.pinMessage).toHaveBeenLastCalledWith({ linkId: "chat-one", messageId: "peer_x", remove: true });
    await expect(callApi(ctx, "chat.pin", { chat: "Alice" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(callApi(fake({ error: "Only the admin pins in a community" }).ctx, "chat.pin", { chat: "Crew", message: "k:0:1" })).rejects.toMatchObject({ code: "refused" });
    await expect(callApi(fake({ error: "That message is not in this chat, or cannot be pinned" }).ctx, "chat.pin", { chat: "Alice", message: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(callApi(fake({ error: "Nothing is pinned in this chat" }).ctx, "chat.pin", { chat: "Alice", remove: true })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("the stream's pins", () => {
  let dir: string;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), "ghostly-pins-")); await openPersistentIndexedDb(join(dir, "db")); });

  it("says once when someone else pins or unpins, never what this profile pinned", async () => {
    const hub = new EventHub(join(dir, "p.jsonl"), () => 1000, "pins-hub");
    await hub.open();
    const events: GhostlyEvent[] = [];
    hub.onEvent((e) => events.push(e));
    const state = (chatPin?: PinView, groupPin?: PinView) =>
      ({ links: [link("c1", chatPin && { pin: chatPin })], groups: [group(groupPin && { pin: groupPin })], settings: {}, transport: {} }) as unknown as EngineState;
    hub.baseline(state(), new Map());
    const post = (s: EngineState) => hub.sink.post({ kind: "state", state: s });
    post(state({ id: "abc", by: "peer", at: 5, messageId: "me_abc" }));
    post(state({ id: "abc", by: "peer", at: 5, messageId: "me_abc" }));
    post(state({ id: "def", by: "me", at: 6 }));
    post(state({ id: "", by: "peer", at: 7 }));
    const pins = events.filter((e) => e.type === "chat.pinned");
    expect(pins.map((e) => [e.messageId, e.ref, e.by, e.removed])).toEqual([["me_abc", "abc", "peer", false], [null, null, "peer", true]]);
    expect(pins[0]).toMatchObject({ chat: "c1", id: "chat.pinned:c1:abc:5" });
    post(state(undefined, { id: "k:0:1", by: "k", at: 8, messageId: "k:0:1" }));
    expect(events.find((e) => e.type === "group.pinned")).toMatchObject({ group: "g1", messageId: "k:0:1", ref: "k:0:1", by: "k", removed: false });
  });
});
