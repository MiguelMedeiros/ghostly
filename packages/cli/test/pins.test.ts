import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView, PinView } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { parseArgs } from "../src/args";
import { COMMANDS, idSlot, positionals } from "../src/commands";
import { EventHub, type GhostlyEvent } from "../src/events";
import { openPersistentIndexedDb } from "../src/runtime/storage";
import { chatViewOf, groupViewOf } from "./support/chatView";
// covers: headless.pins

/** `pin`, and the stream's `chat.pinned` / `group.pinned`. */
const link = (id: string, fields: Partial<LinkView> = {}) => ({ id, peerPubKeyZ32: "p" + id, createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" }, ...fields }) as unknown as LinkView;
const group = (fields: Partial<GroupView> = {}) => ({ id: "g1", name: "Crew", createdAt: 1, profile: "mesh", isAdmin: false, canSend: true, lastMessageAt: 0, invited: [], memberLinks: {},
  members: [{ key: "mekey", role: "member", me: true, online: true, missing: 0 }, { key: "anakey", role: "admin", me: false, online: true, missing: 0 }], ...fields }) as unknown as GroupView;

/** `out.pin`: the number of my pin the contact has not confirmed; a 1:1 pin made takes the next one. `chat`: Alice's chat fields. */
function fake(result: { error: string | null; refused?: boolean } = { error: null }, mode: "daemon" | "one-shot" = "daemon", chat: Partial<LinkView> = {}, dir?: string) {
  const out = { pin: null as number | null, n: 0 };
  const node = {
    chatView: chatViewOf, groupView: groupViewOf, getState: () => ({ links: [link("chat-one", { label: "Alice", ...chat })], groups: [group()], settings: {}, transport: {} }) as unknown as EngineState,
    pinMessage: vi.fn(async ({ linkId }: { linkId: string }) => { if (!result.error && !linkId.startsWith("group:")) out.pin = ++out.n; return result; }),
    chatUnconfirmed: vi.fn(() => ({ reactions: [], pin: out.pin })),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default", ...(dir && { dir }) } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode, version: "test" } as unknown as ApiContext;
  return { ctx, node, out };
}

describe("pin", () => {
  /** The command line as `ghostly pin …` reads it: the words and options parsed, then the method's parameters. */
  const line = (...argv: string[]) => {
    const parsed = parseArgs(argv, COMMANDS.pin.options ?? {}, idSlot(COMMANDS.pin));
    return COMMANDS.pin.params!(parsed, positionals(COMMANDS.pin, parsed.positionals));
  };

  it("takes a chat or a group and a message, or --remove", () => {
    expect(COMMANDS.pin.usage).toBe("pin <chat|group> <message> | --remove [--wait none|confirmed|sent] [--timeout s]");
    expect(line("alice", "peer_x")).toEqual({ chat: "alice", message: "peer_x", remove: false, wait: undefined, timeout: undefined });
    expect(line("alice", "peer_x", "--wait", "none", "--timeout", "5")).toEqual({ chat: "alice", message: "peer_x", remove: false, wait: "none", timeout: 5 });
    expect(() => line("alice")).toThrow(/Missing <message>: ghostly pin <chat\|group> <message> \| --remove/);
    expect(() => line()).toThrow(/Missing <chat\|group>/);
    expect(() => line("alice", "peer_x", "peer_y")).toThrow(/Too many arguments/);
    // A group's id may start with a dash: it is still the message.
    expect(line("crew", "-k:0:1")).toMatchObject({ chat: "crew", message: "-k:0:1", remove: false });
  });

  it("unpins with --remove alone: no message is named, and one given beside it is refused before anything goes", async () => {
    expect(line("alice", "--remove")).toMatchObject({ chat: "alice", message: undefined, remove: true });
    expect(line("--remove", "alice")).toMatchObject({ chat: "alice", message: undefined, remove: true });
    // A message beside --remove was taken and not read: a script that meant "unpin peer_x" unpinned whatever was pinned.
    expect(() => line("alice", "peer_x", "--remove")).toThrow("--remove names no message, it unpins whatever is pinned: ghostly pin <chat|group> --remove");
    expect(() => line("alice", "--remove", "peer_x")).toThrow(/--remove names no message/);
    expect(() => line("alice", "peer_x", "peer_y", "--remove")).toThrow(/Too many arguments/);
    // "" (an unset variable in a script) names none.
    expect(line("alice", "", "--remove")).toMatchObject({ chat: "alice", remove: true });
    // The daemon's own call refuses it too (a bot on the socket API), and nothing is unpinned.
    const { ctx, node } = fake();
    await expect(callApi(ctx, "chat.pin", { chat: "Alice", message: "peer_x", remove: true })).rejects.toMatchObject({ code: "bad_request", message: "remove names no message: it unpins whatever is pinned (give no message)" });
    await expect(callApi(ctx, "chat.pin", { chat: "Crew", message: "k:0:1", remove: true })).rejects.toMatchObject({ code: "bad_request" });
    expect(node.pinMessage).not.toHaveBeenCalled();
  });

  it("goes to the engine for a chat or a group; --remove unpins; what the engine refuses is said", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "chat.pin", { chat: "Alice", message: "peer_x" })).toEqual({ chat: "chat-one", messageId: "peer_x", removed: false, confirmed: false });
    expect(node.pinMessage).toHaveBeenLastCalledWith({ linkId: "chat-one", messageId: "peer_x", remove: false });
    expect(await callApi(ctx, "chat.pin", { chat: "Crew", message: "k:0:1" })).toEqual({ group: "g1", messageId: "k:0:1", removed: false, sent: false, edges: 0 });
    expect(node.pinMessage).toHaveBeenLastCalledWith({ linkId: "group:g1", messageId: "k:0:1", remove: false });
    expect(await callApi(ctx, "chat.pin", { chat: "Alice", remove: true })).toEqual({ chat: "chat-one", messageId: null, removed: true, confirmed: false });
    expect(node.pinMessage).toHaveBeenLastCalledWith({ linkId: "chat-one", remove: true });
    await expect(callApi(ctx, "chat.pin", { chat: "Alice" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(callApi(fake({ error: "Only the admin pins in a community" }).ctx, "chat.pin", { chat: "Crew", message: "k:0:1" })).rejects.toMatchObject({ code: "refused" });
    // Not a member any more (removed, say): refused with the group's reason, as group send and group react are.
    await expect(callApi(fake({ error: "You were removed from this group", refused: true }).ctx, "chat.pin", { chat: "Crew", message: "k:0:1" })).rejects.toMatchObject({ code: "refused", message: "You were removed from this group" });
    await expect(callApi(fake({ error: "That message is not in this chat, or cannot be pinned" }).ctx, "chat.pin", { chat: "Alice", message: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(callApi(fake({ error: "Nothing is pinned in this chat" }).ctx, "chat.pin", { chat: "Alice", remove: true })).rejects.toMatchObject({ code: "not_found" });
    // A group's say the group.
    await expect(callApi(fake({ error: "That message is not in this group, or cannot be pinned" }).ctx, "chat.pin", { chat: "Crew", message: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(callApi(fake({ error: "Nothing is pinned in this group" }).ctx, "chat.pin", { chat: "Crew", remove: true })).rejects.toMatchObject({ code: "not_found", message: "Nothing is pinned in this group" });
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

  it("a timeout's details name the message, as edit's and message delete's do: a bot that retries has it there", async () => {
    const pin = await callApi(fake(undefined, "one-shot").ctx, "chat.pin", { chat: "Alice", message: "peer_x", timeout: 1 }).catch((e: unknown) => e);
    expect(pin).toMatchObject({ code: "timeout", details: { chat: "chat-one", messageId: "peer_x", removed: false } });
    expect((pin as { details: Record<string, unknown> }).details).not.toHaveProperty("note");
    const unpin = await callApi(fake(undefined, "one-shot").ctx, "chat.pin", { chat: "Alice", remove: true, timeout: 1 }).catch((e: unknown) => e);
    expect((unpin as { details: unknown }).details).toEqual({ chat: "chat-one", messageId: null, removed: true });
  });

  it("--wait confirmed on a group, or sent on a chat, is refused before anything goes", async () => {
    const { ctx, node } = fake(undefined, "one-shot");
    await expect(callApi(ctx, "chat.pin", { chat: "Crew", message: "k:0:1", wait: "confirmed" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(callApi(ctx, "chat.pin", { chat: "Alice", message: "peer_x", wait: "sent" })).rejects.toMatchObject({ code: "bad_request" });
    expect(node.pinMessage).not.toHaveBeenCalled();
  });
});

describe("pin in a 1:1 chat on the DHT only (either side's choice): it waits for a live session, and says so", () => {
  const theirs = { dhtDelivery: { peerMode: "dht" } } as unknown as Partial<LinkView>;
  const mine = { deliveryMode: "dht" } as unknown as Partial<LinkView>;
  const chosen = "this chat is on the DHT only: it goes once you choose a live transport (ghostly chat transport Alice auto)";

  it("a daemon's answer says it in a note: whose choice it is and what ends it", async () => {
    expect(await callApi(fake(undefined, "daemon", mine).ctx, "chat.pin", { chat: "Alice", message: "peer_x" })).toEqual({
      chat: "chat-one", messageId: "peer_x", removed: false, confirmed: false, note: `A pin goes only on a live session, and ${chosen}`,
    });
    expect(await callApi(fake(undefined, "daemon", theirs).ctx, "chat.pin", { chat: "Alice", remove: true })).toEqual({
      chat: "chat-one", messageId: null, removed: true, confirmed: false,
      note: "An unpin goes only on a live session, and the contact keeps this chat on the DHT only: it goes once they choose a live transport",
    });
    expect(await callApi(fake(undefined, "daemon", { ...mine, ...theirs }).ctx, "chat.pin", { chat: "Alice", message: "peer_x" })).toMatchObject({
      note: "A pin goes only on a live session, and you and the contact keep this chat on the DHT only: it goes once both choose a live transport (ghostly chat transport Alice auto)",
    });
    // This side's hold ends by itself: said with when, and the command that ends it now.
    const dir = mkdtempSync(join(tmpdir(), "ghostly-pin-hold-"));
    writeFileSync(join(dir, "holds.json"), JSON.stringify({ "chat-one": { until: Date.now() + 3_600_000, since: Date.now() } }));
    expect(await callApi(fake(undefined, "daemon", mine, dir).ctx, "chat.pin", { chat: "Alice", message: "peer_x" })).toMatchObject({
      note: expect.stringMatching(/^A pin goes only on a live session, and this chat is held on the DHT only until .*\d\d:\d\d: it goes then, or now with ghostly chat connect Alice$/),
    });
  });

  it("a --wait confirmed timeout says it in place of \"still goes by itself\", and in details.note", async () => {
    for (const mode of ["daemon", "one-shot"] as const) {
      const error = await callApi(fake(undefined, mode, mine).ctx, "chat.pin", { chat: "Alice", message: "peer_x", wait: "confirmed", timeout: 1 }).catch((e: unknown) => e) as { code: string; message: string; details: Record<string, unknown> };
      const note = `A pin goes only on a live session, and ${chosen}`;
      expect(error.code).toBe("timeout");
      expect(error.message).not.toMatch(/goes by itself|next command|daemon --detach/);
      expect(error.message).toBe(`Timed out after 1 s: the contact has not confirmed the pin yet. It is kept here. ${note}`);
      expect(error.details).toEqual({ chat: "chat-one", messageId: "peer_x", removed: false, note });
    }
    await expect(callApi(fake(undefined, "one-shot", theirs).ctx, "chat.pin", { chat: "Alice", remove: true, timeout: 1 })).rejects.toMatchObject({
      code: "timeout", message: "Timed out after 1 s: the contact has not confirmed the pin yet. It is kept here. An unpin goes only on a live session, and the contact keeps this chat on the DHT only: it goes once they choose a live transport",
      details: { messageId: null, removed: true, note: expect.stringContaining("An unpin goes only on a live session") },
    });
  });
});

describe("pin in a group waits for an edge, as group react does", () => {
  /** My pin numbered 7 in Crew; `took` says how many edges took it at each look. */
  function inGroup(mode: "one-shot" | "daemon", took: () => number) {
    const { ctx, node } = fake(undefined, mode);
    node.pinMessage.mockResolvedValue({ error: null, n: 7 } as { error: null });
    const groupTaken = vi.fn(took);
    Object.assign(node, { groupTaken });
    return { ctx, node, groupTaken };
  }

  it("a one-shot stays until an edge took it (the process leaving took it along unsaid), and says how many did", async () => {
    let looks = 0;
    const { ctx, groupTaken } = inGroup("one-shot", () => (++looks > 2 ? 1 : 0));
    expect(await callApi(ctx, "chat.pin", { chat: "Crew", message: "k:0:1" })).toEqual({ group: "g1", messageId: "k:0:1", removed: false, sent: true, edges: 1 });
    expect(groupTaken).toHaveBeenLastCalledWith({ groupId: "g1", messageId: "k:0:1", pin: 7 });
    expect(looks).toBe(3);
  });

  it("a one-shot no edge took in time: a timeout (exit 4) that says it goes with a later command; --wait none answers at once", async () => {
    await expect(callApi(inGroup("one-shot", () => 0).ctx, "chat.pin", { chat: "Crew", remove: true, timeout: 1 })).rejects.toMatchObject({
      code: "timeout", message: expect.stringMatching(/no member's edge took it yet .*next command/), details: { pin: 7 },
    });
    expect(await callApi(inGroup("one-shot", () => 0).ctx, "chat.pin", { chat: "Crew", message: "k:0:1", wait: "none" })).toEqual({ group: "g1", messageId: "k:0:1", removed: false, sent: false, edges: 0 });
  });

  it("the message pinned already (someone else's pin: the engine sends nothing, so no number) answers at once that nothing went", async () => {
    const { ctx, node, groupTaken } = inGroup("one-shot", () => 1);
    node.pinMessage.mockResolvedValue({ error: null });
    expect(await callApi(ctx, "chat.pin", { chat: "Crew", message: "k:0:1", timeout: 1 })).toEqual({ group: "g1", messageId: "k:0:1", removed: false, sent: false, edges: 0 });
    expect(groupTaken).not.toHaveBeenCalled();
  });

  it("a daemon answers at once (it goes on saying it), unless asked to wait", async () => {
    const { ctx, groupTaken } = inGroup("daemon", () => 0);
    expect(await callApi(ctx, "chat.pin", { chat: "Crew", message: "k:0:1" })).toEqual({ group: "g1", messageId: "k:0:1", removed: false, sent: false, edges: 0 });
    expect(groupTaken).toHaveBeenCalledOnce();
    await expect(callApi(ctx, "chat.pin", { chat: "Crew", message: "k:0:1", wait: "sent", timeout: 1 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("takes --wait sent", () => {
    const parsed = parseArgs(["Crew", "k:0:1", "--wait", "sent"], COMMANDS.pin.options ?? {}, idSlot(COMMANDS.pin));
    expect(COMMANDS.pin.params!(parsed, positionals(COMMANDS.pin, parsed.positionals))).toMatchObject({ chat: "Crew", message: "k:0:1", wait: "sent" });
  });
});

describe("chat show and group show say the pin", () => {
  const ctxOf = (chatPin?: PinView, groupPin?: PinView) => ({
    runtime: { server: { node: { chatView: chatViewOf, groupView: groupViewOf, getState: () => ({ links: [link("chat-one", { label: "Alice", ...(chatPin && { pin: chatPin }) })], groups: [group(groupPin && { pin: groupPin })], settings: {}, transport: {} }) as unknown as EngineState } }, paths: { name: "default" } },
    hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, groupAuto: { get: () => ({ on: false, from: [] }) }, mode: "daemon", version: "test",
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
