import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { parseArgs } from "../src/args";
import { COMMANDS, idSlot, positionals } from "../src/commands";
import { EventHub, type GhostlyEvent } from "../src/events";
import { openPersistentIndexedDb } from "../src/runtime/storage";
import { messageJson } from "../src/views";
// covers: headless.reactions

/** `react` and `group react`, reactions in history, and the stream's `message.reaction` / `group.reaction`. */
const link = (id: string, fields: Partial<LinkView> = {}) => ({ id, peerPubKeyZ32: "p" + id, createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" }, ...fields }) as unknown as LinkView;
const group = { id: "g1", name: "Crew", createdAt: 1, profile: "community", isAdmin: true, canSend: true, lastMessageAt: 0, invited: [], memberLinks: {},
  members: [{ key: "mekey", role: "admin", me: true, online: true, missing: 0 }] } as unknown as GroupView;

/** `unconfirmed`: the numbers of my reactions the contact has not confirmed; a reaction made adds the next one. */
function fake(result: { error: string | null; refused?: boolean } = { error: null }, mode: "daemon" | "one-shot" = "daemon", unconfirmed: number[] = []) {
  const node = {
    getState: () => ({ links: [link("chat-one", { label: "Alice" })], groups: [group], settings: {}, transport: {} }) as unknown as EngineState,
    react: vi.fn(async () => { if (!result.error) unconfirmed.push(Math.max(0, ...unconfirmed) + 1); return result; }),
    chatUnconfirmed: vi.fn(() => ({ reactions: [...unconfirmed], pin: null })),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode, version: "test" } as unknown as ApiContext;
  return { ctx, node, unconfirmed };
}

describe("react", () => {
  it("takes a chat, a message and an emoji, or --remove", () => {
    expect(positionals(COMMANDS.react, ["alice", "peer_x", "👍"])).toEqual({ chat: "alice", message: "peer_x", emoji: "👍" });
    expect(positionals(COMMANDS.react, ["alice", "peer_x"])).toEqual({ chat: "alice", message: "peer_x", emoji: undefined });
    expect(() => positionals(COMMANDS.react, ["alice"])).toThrow(/Missing <message>/);
    expect(COMMANDS["group react"].usage).toBe("group react <group> <message> <emoji> [--remove]");
  });

  it("goes to the engine; --remove is the empty emoji; what the engine refuses is said", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "chat.react", { chat: "Alice", message: "peer_x", emoji: "👍" })).toEqual({ chat: "chat-one", messageId: "peer_x", emoji: "👍", removed: false, confirmed: false });
    expect(node.react).toHaveBeenLastCalledWith({ linkId: "chat-one", messageId: "peer_x", emoji: "👍" });
    expect(await callApi(ctx, "chat.react", { chat: "Alice", message: "peer_x", remove: true })).toMatchObject({ emoji: null, removed: true });
    expect(node.react).toHaveBeenLastCalledWith({ linkId: "chat-one", messageId: "peer_x", emoji: "" });
    await callApi(ctx, "group.react", { group: "Crew", message: "k:0:1", emoji: "🙏" });
    expect(node.react).toHaveBeenLastCalledWith({ linkId: "group:g1", messageId: "k:0:1", emoji: "🙏" });
    await expect(callApi(ctx, "chat.react", { chat: "Alice", message: "peer_x" })).rejects.toMatchObject({ code: "usage" });
    await expect(callApi(fake({ error: "A reaction is one emoji" }).ctx, "chat.react", { chat: "Alice", message: "peer_x", emoji: "ok" })).rejects.toMatchObject({ code: "bad_request" });
    // Not a member of the group any more: refused, with the reason the group shows.
    await expect(callApi(fake({ error: "You were removed from this group", refused: true }).ctx, "group.react", { group: "Crew", message: "k:0:1", emoji: "👍" })).rejects.toMatchObject({ code: "refused", message: "You were removed from this group" });
    await expect(callApi(fake({ error: "That message is not in this chat, or takes no reaction" }).ctx, "chat.react", { chat: "Alice", message: "x", emoji: "👍" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("react in a 1:1 chat, without a daemon", () => {
  it("stays until the contact confirmed it: the process leaving took it along unsaid", async () => {
    const { ctx, unconfirmed } = fake(undefined, "one-shot", [4]);
    // The contact confirms everything up to the new one after a moment (a DHT receipt says up to).
    setTimeout(() => unconfirmed.splice(0), 300);
    const started = Date.now();
    expect(await callApi(ctx, "chat.react", { chat: "Alice", message: "peer_x", emoji: "👍" })).toEqual({ chat: "chat-one", messageId: "peer_x", emoji: "👍", removed: false, confirmed: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("an older reaction still waiting is not this one: confirmed once the new one is", async () => {
    const { ctx, unconfirmed } = fake(undefined, "one-shot", [4]);
    setTimeout(() => unconfirmed.splice(1), 300);
    expect(await callApi(ctx, "chat.react", { chat: "Alice", message: "peer_x", emoji: "👍" })).toMatchObject({ confirmed: true });
    expect(unconfirmed).toEqual([4]);
  });

  it("times out saying it is kept and what carries it; --wait none answers at once", async () => {
    await expect(callApi(fake(undefined, "one-shot").ctx, "chat.react", { chat: "Alice", message: "peer_x", emoji: "👍", timeout: 1 })).rejects.toMatchObject({
      code: "timeout", message: "Timed out after 1 s: the contact has not confirmed the reaction yet. It is kept here and goes with this profile's next command, or keep it online with `ghostly daemon --detach`",
    });
    expect(await callApi(fake(undefined, "one-shot").ctx, "chat.react", { chat: "Alice", message: "peer_x", emoji: "👍", wait: "none" })).toMatchObject({ confirmed: false });
    // A daemon goes on saying it: it waits only when asked.
    await expect(callApi(fake().ctx, "chat.react", { chat: "Alice", message: "peer_x", emoji: "👍", wait: "confirmed", timeout: 1 })).rejects.toMatchObject({ code: "timeout", message: /still goes by itself while this profile is online/ });
  });

  it("takes --wait and --timeout, checked before anything is sent", async () => {
    const parsed = parseArgs(["alice", "peer_x", "👍", "--wait", "none", "--timeout", "5"], COMMANDS.react.options ?? {}, idSlot(COMMANDS.react));
    expect(COMMANDS.react.params!(parsed, positionals(COMMANDS.react, parsed.positionals))).toEqual({ chat: "alice", message: "peer_x", emoji: "👍", remove: false, wait: "none", timeout: 5 });
    const { ctx, node } = fake(undefined, "one-shot");
    await expect(callApi(ctx, "chat.react", { chat: "Alice", message: "peer_x", emoji: "👍", wait: "sent" })).rejects.toMatchObject({ code: "bad_request" });
    expect(node.react).not.toHaveBeenCalled();
  });
});

describe("react on a group", () => {
  it("says it is a group and how to react there; a name nothing has is still no chat", async () => {
    const { ctx, node } = fake();
    for (const ref of ["Crew", "g1", "crew"]) {
      await expect(callApi(ctx, "chat.react", { chat: ref, message: "k:0:1", emoji: "👍" })).rejects.toMatchObject({
        code: "not_found", message: `${JSON.stringify(ref)} is a group, not a chat: ghostly group react ${ref} <message> <emoji>`, details: { group: "g1" },
      });
    }
    expect(node.react).not.toHaveBeenCalled();
    await expect(callApi(ctx, "chat.react", { chat: "Nobody", message: "x", emoji: "👍" })).rejects.toMatchObject({ code: "not_found", message: 'No chat "Nobody"' });
  });

  it.each([
    ["chat.send", { text: "hi" }, "group send Crew [text...]"],
    ["chat.edit", { message: "m1", text: "x" }, "group edit Crew <message> <text...>"],
    ["chat.typing", {}, "group typing Crew"],
    ["chat.history", {}, "group history Crew"],
    ["chat.get", {}, "group show Crew"],
    ["chat.rename", { name: "x" }, "group rename Crew <name...>"],
    ["chat.remove", { yes: true }, "group forget Crew --yes"],
  ] as const)("%s on a group says so too, with the group command", async (method, params, command) => {
    const { ctx } = fake();
    await expect(callApi(ctx, method, { chat: "Crew", ...params })).rejects.toMatchObject({
      code: "not_found", message: `"Crew" is a group, not a chat: ghostly ${command}`, details: { group: "g1" },
    });
    await expect(callApi(ctx, method, { chat: "Nobody", ...params })).rejects.toMatchObject({ code: "not_found", message: 'No chat "Nobody"' });
  });
});

describe("reactions on a message", () => {
  const message = (fields: Partial<StoredMessage> = {}): StoredMessage => ({ linkId: "c1", id: "me_r", text: "ship it", sender: "me", timestamp: 1, via: "datalink", ...fields });

  it("history lists those shown, oldest first", () => {
    expect(messageJson(message({ reactions: { peer: { e: "👍", n: 2, at: 20 }, me: { e: "", n: 3, at: 30 }, k: { e: "😂", n: 1, at: 10 } } })).reactions)
      .toEqual([{ by: "k", emoji: "😂", at: 10 }, { by: "peer", emoji: "👍", at: 20 }]);
    expect(messageJson(message({ reactions: { me: { e: "", n: 1, at: 1 } } }))).not.toHaveProperty("reactions");
  });

  let dir: string;
  beforeAll(async () => { dir = mkdtempSync(join(tmpdir(), "ghostly-reactions-")); await openPersistentIndexedDb(join(dir, "db")); });

  it("the stream says each change once: added, replaced, taken back; in a group too", async () => {
    const hub = new EventHub(join(dir, "r.jsonl"), () => 1000, "reactions-hub");
    await hub.open();
    const events: GhostlyEvent[] = [];
    hub.onEvent((e) => events.push(e));
    const state = { links: [link("c1")], groups: [group], settings: {}, transport: {} } as unknown as EngineState;
    hub.baseline(state, new Map([["c1", [message()]]]));
    const post = (chat: string, messages: StoredMessage[]) => hub.sink.post({ kind: "messages", linkId: chat, messages });
    post("c1", [message({ reactions: { peer: { e: "👍", n: 5, at: 1 } } })]);
    post("c1", [message({ reactions: { peer: { e: "👍", n: 5, at: 1 } } })]);
    post("c1", [message({ reactions: { peer: { e: "❤️", n: 6, at: 2 } } })]);
    post("c1", [message({ reactions: { peer: { e: "", n: 7, at: 3 } } })]);
    const reactions = events.filter((e) => e.type === "message.reaction");
    expect(reactions.map((e) => [e.emoji, e.removed])).toEqual([["👍", false], ["❤️", false], ["", true]]);
    expect(reactions[0]).toMatchObject({ chat: "c1", messageId: "me_r", by: "peer", mine: true, id: "message.reaction:c1:me_r:peer:5" });
    // The message itself is not news again.
    expect(events.filter((e) => e.type === "message.sent" || e.type === "message.delivery")).toEqual([]);
    post("group:g1", [message({ linkId: "group:g1", id: "k:0:1", sender: "peer", member: "k", reactions: { mekey: { e: "🙏", n: 1, at: 1 } } })]);
    expect(events.find((e) => e.type === "group.reaction")).toMatchObject({ group: "g1", messageId: "k:0:1", by: "mekey", emoji: "🙏", mine: false });
  });
});
