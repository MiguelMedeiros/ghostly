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

/** `out.pin`: the number of my pin the contact has not confirmed; a 1:1 pin made takes the next one. */
function fake(result: { error: string | null; refused?: boolean } = { error: null }, mode: "daemon" | "one-shot" = "daemon") {
  const out = { pin: null as number | null, n: 0 };
  const node = {
    getState: () => ({ links: [link("chat-one", { label: "Alice" })], groups: [group()], settings: {}, transport: {} }) as unknown as EngineState,
    pinMessage: vi.fn(async ({ linkId }: { linkId: string }) => { if (!result.error && !linkId.startsWith("group:")) out.pin = ++out.n; return result; }),
    chatUnconfirmed: vi.fn(() => ({ reactions: [], pin: out.pin })),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode, version: "test" } as unknown as ApiContext;
  return { ctx, node, out };
}

describe("pin", () => {
  /** The command line as `ghostly pin …` reads it: the words and options parsed, then the method's parameters. */
  const line = (...argv: string[]) => {
    const parsed = parseArgs(argv, COMMANDS.pin.options ?? {}, idSlot(COMMANDS.pin));
    return COMMANDS.pin.params!(parsed, positionals(COMMANDS.pin, parsed.positionals));
  };

  it("takes a chat or a group and a message, or --remove", () => {
    expect(COMMANDS.pin.usage).toBe("pin <chat|group> <message> | --remove [--wait none|confirmed] [--timeout s]");
    expect(line("alice", "peer_x")).toEqual({ chat: "alice", message: "peer_x", remove: false, wait: undefined, timeout: undefined });
    expect(line("alice", "peer_x", "--wait", "none", "--timeout", "5")).toEqual({ chat: "alice", message: "peer_x", remove: false, wait: "none", timeout: 5 });
    expect(() => line("alice")).toThrow(/Missing <message>: ghostly pin <chat\|group> <message> \| --remove/);
    expect(() => line()).toThrow(/Missing <chat\|group>/);
    expect(() => line("alice", "peer_x", "peer_y")).toThrow(/Too many arguments/);
    // A group's id may start with a dash: it is still the message.
    expect(line("crew", "-k:0:1")).toMatchObject({ chat: "crew", message: "-k:0:1", remove: false });
  });

  it("unpins with --remove alone: no message is named, and one given is not asked for", () => {
    expect(line("alice", "--remove")).toMatchObject({ chat: "alice", message: undefined, remove: true });
    expect(line("--remove", "alice")).toMatchObject({ chat: "alice", message: undefined, remove: true });
    // A script that named the pinned message beside --remove goes on working.
    expect(line("alice", "peer_x", "--remove")).toMatchObject({ chat: "alice", message: "peer_x", remove: true });
    expect(() => line("alice", "peer_x", "peer_y", "--remove")).toThrow(/Too many arguments/);
  });

  it("goes to the engine for a chat or a group; --remove unpins; what the engine refuses is said", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "chat.pin", { chat: "Alice", message: "peer_x" })).toEqual({ chat: "chat-one", messageId: "peer_x", removed: false, confirmed: false });
    expect(node.pinMessage).toHaveBeenLastCalledWith({ linkId: "chat-one", messageId: "peer_x", remove: false });
    expect(await callApi(ctx, "chat.pin", { chat: "Crew", message: "k:0:1" })).toEqual({ group: "g1", messageId: "k:0:1", removed: false });
    expect(node.pinMessage).toHaveBeenLastCalledWith({ linkId: "group:g1", messageId: "k:0:1", remove: false });
    expect(await callApi(ctx, "chat.pin", { chat: "Alice", message: "peer_x", remove: true })).toEqual({ chat: "chat-one", messageId: null, removed: true, confirmed: false });
    expect(node.pinMessage).toHaveBeenLastCalledWith({ linkId: "chat-one", messageId: "peer_x", remove: true });
    await expect(callApi(ctx, "chat.pin", { chat: "Alice" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(callApi(fake({ error: "Only the admin pins in a community" }).ctx, "chat.pin", { chat: "Crew", message: "k:0:1" })).rejects.toMatchObject({ code: "refused" });
    // Not a member any more (removed, say): refused with the group's reason, as group send and group react are.
    await expect(callApi(fake({ error: "You were removed from this group", refused: true }).ctx, "chat.pin", { chat: "Crew", message: "k:0:1" })).rejects.toMatchObject({ code: "refused", message: "You were removed from this group" });
    await expect(callApi(fake({ error: "That message is not in this chat, or cannot be pinned" }).ctx, "chat.pin", { chat: "Alice", message: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(callApi(fake({ error: "Nothing is pinned in this chat" }).ctx, "chat.pin", { chat: "Alice", remove: true })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("pin in a 1:1 chat, without a daemon", () => {
  it("stays until the contact confirmed it: the process leaving took it along unsaid", async () => {
    const { ctx, out } = fake(undefined, "one-shot");
    setTimeout(() => { out.pin = null; }, 300);
    const started = Date.now();
    expect(await callApi(ctx, "chat.pin", { chat: "Alice", message: "peer_x" })).toEqual({ chat: "chat-one", messageId: "peer_x", removed: false, confirmed: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("times out saying it is kept and what carries it; --wait none answers at once", async () => {
    await expect(callApi(fake(undefined, "one-shot").ctx, "chat.pin", { chat: "Alice", remove: true, timeout: 1 })).rejects.toMatchObject({
      code: "timeout", message: "Timed out after 1 s: the contact has not confirmed the pin yet. It is kept here and goes with this profile's next command, or keep it online with `ghostly daemon --detach`",
    });
    expect(await callApi(fake(undefined, "one-shot").ctx, "chat.pin", { chat: "Alice", message: "peer_x", wait: "none" })).toMatchObject({ confirmed: false });
  });

  it("in a group answers at once (no receipts there); --wait confirmed on a group is refused before anything goes", async () => {
    const { ctx, node } = fake(undefined, "one-shot");
    expect(await callApi(ctx, "chat.pin", { chat: "Crew", message: "k:0:1" })).toEqual({ group: "g1", messageId: "k:0:1", removed: false });
    await expect(callApi(ctx, "chat.pin", { chat: "Crew", message: "k:0:1", wait: "confirmed" })).rejects.toMatchObject({ code: "bad_request" });
    expect(node.pinMessage).toHaveBeenCalledOnce();
  });
});

describe("chat show and group show say the pin", () => {
  const ctxOf = (chatPin?: PinView, groupPin?: PinView) => ({
    runtime: { server: { node: { getState: () => ({ links: [link("chat-one", { label: "Alice", ...(chatPin && { pin: chatPin }) })], groups: [group(groupPin && { pin: groupPin })], settings: {}, transport: {} }) as unknown as EngineState } }, paths: { name: "default" } },
    hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test",
  }) as unknown as ApiContext;

  it("with the fields chat.pinned and group.pinned carry, or null when nothing is pinned", async () => {
    const none = ctxOf();
    expect(await callApi(none, "chat.get", { chat: "Alice" })).toMatchObject({ pin: null });
    expect(await callApi(none, "group.get", { group: "Crew" })).toMatchObject({ pin: null });
    const pinned = ctxOf({ id: "abc", by: "peer", at: 5, messageId: "me_abc" }, { id: "k:0:1", by: "k", at: 8 });
    expect(await callApi(pinned, "chat.get", { chat: "Alice" })).toMatchObject({ pin: { messageId: "me_abc", ref: "abc", by: "peer", at: 5 } });
    // Not here (yet): the id both sides know, and no row.
    expect(await callApi(pinned, "group.get", { group: "Crew" })).toMatchObject({ pin: { messageId: null, ref: "k:0:1", by: "k", at: 8 } });
    expect(await callApi(pinned, "group.list", {})).toMatchObject({ groups: [{ pin: { ref: "k:0:1" } }] });
    // Unpinned: the engine keeps an empty id.
    const unpinned = ctxOf({ id: "", by: "peer", at: 7 }, { id: "", by: "me", at: 9 });
    expect(await callApi(unpinned, "chat.get", { chat: "Alice" })).toMatchObject({ pin: null });
    expect(await callApi(unpinned, "group.get", { group: "Crew" })).toMatchObject({ pin: null });
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
