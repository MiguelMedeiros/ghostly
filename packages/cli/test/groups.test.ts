import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { parseArgs } from "../src/args";
import { COMMANDS, TEXT_COMMANDS } from "../src/commands";
import { EventHub, type GhostlyEvent } from "../src/events";
import { openPersistentIndexedDb } from "../src/runtime/storage";
import { pageOf } from "./support/messagePage";
import { groupJson, groupMessageJson } from "../src/views";
// covers: headless.groups, headless.group-admin, groups.rename

/**
 * What a bot in a group reads: who wrote a message (the roster names mesh and community senders), the id of what it
 * sent (to reply to it or react to it later), and a group that never prints its entry link unless asked.
 */
const LINK = "https://ghostly.tools/g#secret";
const group = {
  id: "g1", name: "Crew", createdAt: 1, profile: "mesh", isAdmin: true, canSend: true, lastMessageAt: 0, invited: [], memberLinks: {}, entryLink: LINK,
  members: [
    { key: "mekey", role: "admin", me: true, online: true, missing: 0 },
    { key: "anakey", role: "member", me: false, online: true, missing: 0, nick: "Ana" },
    { key: "bokey", role: "member", me: false, online: true, missing: 0 },
  ],
} as unknown as GroupView;
beforeAll(async () => { await openPersistentIndexedDb(join(mkdtempSync(join(tmpdir(), "ghostly-groups-")), "db")); });

const message = (id: string, fields: Partial<StoredMessage> = {}): StoredMessage => ({ linkId: "group:g1", id, text: "t " + id, sender: "peer", timestamp: 1, via: "datalink", ...fields });

function fake(messages: StoredMessage[] = []) {
  const node = {
    getState: () => ({ links: [], groups: [group], settings: {}, transport: {} }) as unknown as EngineState,
    groupMessages: vi.fn(async () => messages),
    messagePage: vi.fn(async (params: { limit?: number; before?: string | number }) => pageOf(messages, params)),
    sendGroupMessage: vi.fn(async () => ({ error: null, messageId: "mekey:0:7" })),
    groupTaken: vi.fn(() => 0),
    removeGroupMember: vi.fn(async () => undefined),
    rotateGroup: vi.fn(async () => undefined),
    renameGroup: vi.fn(async () => undefined),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

describe("a group message names its author", () => {
  it("from the roster when the message came with the member's key only", () => {
    expect(groupMessageJson(message("a", { member: "anakey" }), group)).toMatchObject({ nick: "Ana", member: "anakey" });
    // A name the message carries wins; a member the roster has no name for stays null.
    expect(groupMessageJson(message("b", { member: "anakey", nick: "Ana B" }), group).nick).toBe("Ana B");
    expect(groupMessageJson(message("c", { member: "bokey" }), group)).toMatchObject({ nick: null, member: "bokey" });
    expect(groupMessageJson(message("d", { member: "gone" }), undefined).nick).toBeNull();
  });

  it("by the name the group knew them by, once they are out of the roster (removed, or back with a new key)", () => {
    const after = { ...group, formerNames: { oldkey: "Carol" } } as GroupView;
    expect(groupMessageJson(message("e", { member: "oldkey" }), after)).toMatchObject({ nick: "Carol", member: "oldkey" });
    expect(groupMessageJson(message("f", { member: "gone" }), after).nick).toBeNull();
  });

  it("in group history", async () => {
    const { ctx } = fake([message("a", { member: "anakey" }), message("b", { member: "bokey", timestamp: 2 })]);
    const page = await callApi(ctx, "group.history", { group: "Crew" }) as { messages: { id: string; nick: string | null; member: string }[] };
    expect(page.messages.map((m) => [m.id, m.member, m.nick])).toEqual([["a", "anakey", "Ana"], ["b", "bokey", null]]);
  });

  it("in the group.message event", async () => {
    const h = new EventHub(join(mkdtempSync(join(tmpdir(), "ghostly-groups-")), "events.jsonl"), () => 1000, "groups-events");
    await h.open();
    const events: GhostlyEvent[] = [];
    h.onEvent((e) => events.push(e));
    h.baseline({ links: [], groups: [group], settings: {}, transport: {} } as unknown as EngineState, new Map([["group:g1", []]]));
    h.sink.post({ kind: "messages", linkId: "group:g1", messages: [message("x", { member: "anakey" })] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "group.message", group: "g1", message: { id: "x", member: "anakey", nick: "Ana" } });
  });
});

describe("group send", () => {
  it("answers with the id the message is kept under", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "group.send", { group: "Crew", text: "status: busy", reply: "anakey:0:1" })).toEqual({ group: "g1", messageId: "mekey:0:7", sent: true, edges: 0 });
    expect(node.sendGroupMessage).toHaveBeenCalledWith({ groupId: "g1", text: "status: busy", replyTo: "anakey:0:1" });
    expect(TEXT_COMMANDS["group send"].usage).toContain("--reply <message>");
  });

  it("--wait sent: until an edge took it, or a timeout (exit 4) that says it still goes", async () => {
    expect(TEXT_COMMANDS["group send"].usage).toContain("[--wait none|sent] [--timeout s]");
    const { ctx, node } = fake();
    await expect(callApi(ctx, "group.send", { group: "Crew", text: "anyone?", wait: "sent", timeout: 1 })).rejects.toMatchObject({ code: "timeout", message: expect.stringMatching(/goes when one opens/) });
    node.groupTaken.mockImplementation(() => 2);
    expect(await callApi(ctx, "group.send", { group: "Crew", text: "anyone?", wait: "sent" })).toMatchObject({ messageId: "mekey:0:7", edges: 2 });
    expect(node.groupTaken).toHaveBeenLastCalledWith({ groupId: "g1", messageId: "mekey:0:7" });
    await expect(callApi(ctx, "group.send", { group: "Crew", text: "x", wait: "delivered" })).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("group create", () => {
  it("gives the engine the name a group can have, and refuses one it cannot before anything is made", async () => {
    const { ctx, node } = fake();
    const createGroup = vi.fn(async () => ({ groupId: "g2" }));
    Object.assign(node, { createGroup, enableGroupLink: vi.fn(async () => ({ link: LINK })) });
    expect(await callApi(ctx, "group.create", { name: " Book\nclub ", profile: "mesh" })).toEqual({ group: "g2", link: null });
    expect(createGroup).toHaveBeenLastCalledWith({ name: "Book club", profile: "mesh" });
    for (const name of ["x".repeat(65), "   ", "\n"]) {
      await expect(callApi(ctx, "group.create", { name, profile: "mesh" }), JSON.stringify(name)).rejects.toMatchObject({ code: "bad_request" });
    }
    expect(createGroup).toHaveBeenCalledTimes(1);
  });
});

describe("group rename", () => {
  it("sends one clean line to the engine and refuses a name no member would see", async () => {
    const { ctx, node } = fake();
    await callApi(ctx, "group.rename", { group: "Crew", name: " Book\nclub " });
    expect(node.renameGroup).toHaveBeenCalledWith({ groupId: "g1", name: "Book club" });
    for (const name of ["", " \n ", "‮", "x".repeat(65)])
      await expect(callApi(ctx, "group.rename", { group: "Crew", name }), JSON.stringify(name)).rejects.toMatchObject({ code: "bad_request" });
    expect(node.renameGroup).toHaveBeenCalledTimes(1);
    expect(COMMANDS["group rename"].params!(parseArgs(["Crew", "Book", "club"], {}), { group: "Crew", name: "Book club" })).toEqual({ group: "Crew", name: "Book club" });
  });
});

describe("the entry link is a join secret", () => {
  it("is hidden in show, list and the admin commands unless asked for", async () => {
    const { ctx } = fake();
    expect(groupJson(group, true).link).toBe(LINK);
    expect(groupJson({ ...group, entryLink: undefined }).link).toBeNull();
    for (const [method, params] of [["group.get", {}], ["group.remove", { member: "Ana" }], ["group.rotate", {}], ["group.rename", { name: "Crew 2" }]] as const) {
      const hidden = await callApi(ctx, method, { group: "Crew", ...params });
      expect(JSON.stringify(hidden), method).not.toContain(LINK);
      expect(hidden, method).toMatchObject({ link: "<hidden>" });
      expect(await callApi(ctx, method, { group: "Crew", ...params, showSecret: true }), method).toMatchObject({ link: LINK });
    }
    expect(JSON.stringify(await callApi(ctx, "group.list", {}))).not.toContain(LINK);
    expect(await callApi(ctx, "group.list", { showSecret: true })).toMatchObject({ groups: [{ link: LINK }] });
  });

  it("--show-secret on the commands that print a group", () => {
    const params = (name: string, argv: string[], args: Record<string, string>) => {
      const spec = COMMANDS[name];
      return spec.params!(parseArgs(argv, spec.options ?? {}), args);
    };
    for (const name of ["group show", "group list", "group invite", "group remove", "group admin", "group rotate", "group rename"]) {
      expect(COMMANDS[name].usage, name).toContain("[--show-secret]");
      expect(params(name, ["x", "--show-secret"], { group: "Crew" }), name).toMatchObject({ showSecret: true });
      expect(params(name, ["x"], { group: "Crew" }), name).not.toHaveProperty("showSecret");
    }
  });

  it("is not in the group.created event", async () => {
    const h = new EventHub(join(mkdtempSync(join(tmpdir(), "ghostly-groups-")), "events.jsonl"), () => 1000, "groups-created");
    await h.open();
    const events: GhostlyEvent[] = [];
    h.onEvent((e) => events.push(e));
    h.baseline({ links: [], groups: [], settings: {}, transport: {} } as unknown as EngineState, new Map());
    h.sink.post({ kind: "state", state: { links: [], groups: [group], settings: {}, transport: {} } as unknown as EngineState });
    expect(events.map((e) => e.type)).toEqual(["group.created"]);
    expect(JSON.stringify(events[0])).not.toContain(LINK);
  });
});
