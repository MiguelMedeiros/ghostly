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
import { groupViewOf } from "./support/chatView";
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
    groupView: groupViewOf,
    getSettings: () => ({}),
    groupMessages: vi.fn(async () => messages),
    messagePage: vi.fn(async (params: { limit?: number; before?: string | number }) => pageOf(messages, params)),
    sendGroupMessage: vi.fn(async () => ({ error: null, messageId: "mekey:0:7" })),
    groupTaken: vi.fn(() => 0),
    removeGroupMember: vi.fn(async () => undefined),
    rotateGroup: vi.fn(async () => undefined),
    renameGroup: vi.fn(async () => undefined),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, groupAuto: { get: () => ({ on: false, from: [] }) }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node };
}

describe("group join", () => {
  it("a word that is no group link is bad_request, as invite join answers a non-invite; the engine's other errors pass", async () => {
    const answer = (error: Error) => ({ getState: () => ({ links: [], groups: [], settings: {}, transport: {} }) as unknown as EngineState, joinGroupByLink: vi.fn(async () => { throw error; }) });
    const ctx = (node: ReturnType<typeof answer>) => ({ runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" }) as unknown as ApiContext;
    await expect(callApi(ctx(answer(new Error("This is not a link to a group"))), "group.join", { link: "hello" })).rejects.toMatchObject({ code: "bad_request", message: "This is not a link to a group" });
    await expect(callApi(ctx(answer(new Error("Go online to join a group"))), "group.join", { link: LINK })).rejects.toThrow("Go online to join a group");
    await expect(callApi(ctx(answer(new Error("Go online to join a group"))), "group.join", { link: LINK })).rejects.not.toMatchObject({ code: "bad_request" });
  });
});

describe("a one-shot group join", () => {
  // Found in a bug hunt: with no daemon it left at once with {"group": id} and exit 0; the knock ends with the
  // command, so nobody let it in, even with the community's admin online, and nothing said so.
  const knocking = (stage: string) => ({ id: "g9", name: "", createdAt: 1, profile: "community", isAdmin: false, canSend: false, lastMessageAt: 0, invited: [], memberLinks: {}, members: [],
    invitation: { linkId: "c1", contact: "", admin: "", members: 0, accepted: true, viaLink: true, stage } }) as unknown as GroupView;
  function oneShot(mode: "one-shot" | "daemon" = "one-shot", joined = knocking("knocking")) {
    let groups: GroupView[] = [];
    const listeners = new Set<(s: EngineState) => void>();
    const getState = () => ({ links: [], groups, settings: {}, transport: {} }) as unknown as EngineState;
    const node = { getState, joinGroupByLink: vi.fn(async () => { groups = [joined]; return { groupId: "g9" }; }) };
    const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: (l: (s: EngineState) => void) => { listeners.add(l); return () => listeners.delete(l); }, lastSeq: 0, replay: () => [] }, mode, version: "test" } as unknown as ApiContext;
    const set = (g: GroupView[]) => { groups = g; for (const l of listeners) l(getState()); };
    return { ctx, set };
  }

  it("waits until a member's app lets it in, and says it is in", async () => {
    const { ctx, set } = oneShot();
    const answer = callApi(ctx, "group.join", { link: LINK });
    setTimeout(() => set([knocking("admitted")]), 5);
    setTimeout(() => set([{ ...knocking("admitted"), status: "active", invitation: undefined } as GroupView]), 10);
    expect(await answer).toEqual({ group: "g9", joined: true, stage: null });
  });

  it("after 60 s not in, says so and the next step; the knock is kept for a daemon", async () => {
    vi.useFakeTimers();
    try {
      const { ctx } = oneShot();
      const answer = callApi(ctx, "group.join", { link: LINK });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await answer).toEqual({ group: "g9", joined: false, stage: "knocking",
        warning: "Not in yet: no member's app has let you in. A member's app lets you in only while this profile is running: keep it running (ghostly daemon --detach), then ghostly group show g9" });
    } finally { vi.useRealTimers(); }
  });

  // Found in a bug hunt: a contact's invitation to the group, not accepted, keeps its place and the link is only noted
  // beside it; nothing knocks, so it waited the full 60 s and then said to keep a daemon running, which never gets in.
  it("a contact's invitation to the group, not accepted yet: answers at once with group accept", async () => {
    vi.useFakeTimers();
    try {
      const invited = { ...knocking("knocking"), invitation: { linkId: "c1", contact: "Alice", admin: "ak", members: 3, accepted: false } } as unknown as GroupView;
      const answer = callApi(oneShot("one-shot", invited).ctx, "group.join", { link: LINK });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await Promise.race([answer, Promise.resolve("still waiting")])).toEqual({ group: "g9", joined: false, stage: null,
        warning: "Not in yet: Alice invited you to this group and the invitation waits for your answer. Accept it: ghostly group accept g9" });
    } finally { vi.useRealTimers(); }
  });

  it("let in but no welcome after 60 s: says it was let in, not that nobody did", async () => {
    vi.useFakeTimers();
    try {
      const answer = callApi(oneShot("one-shot", knocking("admitted")).ctx, "group.join", { link: LINK });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await answer).toEqual({ group: "g9", joined: false, stage: "admitted",
        warning: "Not in yet: a member's app let you in, and the group's welcome has not finished arriving. It arrives only while this profile is running: keep it running (ghostly daemon --detach), then ghostly group show g9" });
    } finally { vi.useRealTimers(); }
  });

  it("stops at a stage waiting does not change, with no daemon's note", async () => {
    for (const stage of ["full", "blocked", "replaced"]) {
      const { ctx, set } = oneShot();
      const answer = callApi(ctx, "group.join", { link: LINK });
      setTimeout(() => set([knocking(stage)]), 5);
      expect(await answer).toEqual({ group: "g9", joined: false, stage });
    }
  });

  it("through a daemon, answers at once as before", async () => {
    expect(await callApi(oneShot("daemon").ctx, "group.join", { link: LINK })).toEqual({ group: "g9" });
  });
});

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

  it("a line of the group's own (created, joined, renamed…) is from system, not peer, even with my own key on it", () => {
    for (const event of ["created", "joined", "renamed"] as const) {
      const line = groupMessageJson(message(`event:1:${event}:1`, { event, member: "mekey" }), group);
      expect(line).toMatchObject({ from: "system", event, member: "mekey", delivery: null });
    }
    expect(groupMessageJson(message("g", { member: "anakey" }), group).from).toBe("peer");
    expect(groupMessageJson(message("h", { sender: "me", member: "mekey" }), group).from).toBe("me");
  });

  it("a membership line written before the member's name came says the name known now, as the app shows it", () => {
    const key = "a4w9nb5yqx";
    const roster = { ...group, members: [...group.members, { key, role: "member", me: false, online: true, missing: 0, nick: "Bob" }], formerNames: { oldkey12: "Carol" } } as GroupView;
    const line = (event: StoredMessage["event"], text: string, member: string, fields: Partial<StoredMessage> = {}) =>
      groupMessageJson(message(`event:1:${event}:1`, { event, text, member, ...fields }), roster).text;
    expect(line("joined", "Member a4w9nb5y joined", key)).toBe("Bob joined");
    expect(line("left", "Member a4w9nb5y left", key)).toBe("Bob left");
    expect(line("gone", "Member oldkey12 is no longer a member", "oldkey12")).toBe("Carol is no longer a member");
    // The row's own name wins, as for `nick`; a line already named, or a member nobody has named, stays as stored.
    expect(line("joined", "Member bokey joined", "bokey", { nick: "Bo" })).toBe("Bo joined");
    expect(line("joined", "Ana joined", "anakey")).toBe("Ana joined");
    expect(line("joined", "Member bokey joined", "bokey")).toBe("Member bokey joined");
    // A text that only happens to start like a placeholder is no event line: kept.
    expect(groupMessageJson(message("i", { text: "Member a4w9nb5y joined", member: key }), roster).text).toBe("Member a4w9nb5y joined");
  });

  it("in group history", async () => {
    const { ctx } = fake([message("a", { member: "anakey" }), message("b", { member: "bokey", timestamp: 2 })]);
    const page = await callApi(ctx, "group.history", { group: "Crew" }) as { messages: { id: string; nick: string | null; member: string }[] };
    expect(page.messages.map((m) => [m.id, m.member, m.nick])).toEqual([["a", "anakey", "Ana"], ["b", "bokey", null]]);
    await expect(callApi(ctx, "group.history", { group: "Crew", limit: 1.5 })).rejects.toMatchObject({ code: "bad_request", message: "limit must be a whole number from 1 to 10000" });
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
    expect(await callApi(ctx, "group.send", { group: "Crew", text: "status: busy", reply: "anakey:0:1" })).toEqual({ group: "g1", messageId: "mekey:0:7", sent: false, edges: 0 });
    expect(node.sendGroupMessage).toHaveBeenCalledWith({ groupId: "g1", text: "status: busy", replyTo: "anakey:0:1" });
    expect(TEXT_COMMANDS["group send"].usage).toContain("--reply <message>");
  });

  it("sent says whether an edge took it; a send the engine refuses (not a member) is refused, not sent", async () => {
    const { ctx, node } = fake();
    node.groupTaken.mockImplementation(() => 1);
    expect(await callApi(ctx, "group.send", { group: "Crew", text: "hi" })).toMatchObject({ sent: true, edges: 1 });
    node.sendGroupMessage.mockImplementation(async () => ({ error: "You were removed from this group", refused: true }) as never);
    await expect(callApi(ctx, "group.send", { group: "Crew", text: "anyone?" })).rejects.toMatchObject({ code: "refused", message: "You were removed from this group" });
    await expect(callApi(ctx, "group.send", { group: "Crew", text: "anyone?", wait: "sent", timeout: 1 })).rejects.toMatchObject({ code: "refused" });
    node.sendGroupMessage.mockImplementation(async () => ({ error: "This epoch's key has not arrived yet. Wait for a member to catch you up." }) as never);
    await expect(callApi(ctx, "group.send", { group: "Crew", text: "anyone?" })).rejects.toMatchObject({ code: "unavailable" });
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

describe("group link", () => {
  it("turns the link on only for a real true (or on left out), and refuses an on that is no boolean", async () => {
    const { ctx, node } = fake();
    const enableGroupLink = vi.fn(async () => ({ link: LINK })), disableGroupLink = vi.fn(async () => undefined);
    Object.assign(node, { enableGroupLink, disableGroupLink });
    // A word or a number read as "not false" turned the link on and answered it: whoever holds it joins.
    for (const on of ["false", "off", 0, 1, "true", {}]) {
      await expect(callApi(ctx, "group.link", { group: "Crew", on }), JSON.stringify(on)).rejects.toMatchObject({ code: "bad_request", message: "on must be true or false" });
    }
    // Off with a new link is no request at all, as `group link --off --reset` is refused.
    await expect(callApi(ctx, "group.link", { group: "Crew", on: false, reset: true })).rejects.toMatchObject({ code: "bad_request" });
    expect(enableGroupLink).not.toHaveBeenCalled();
    expect(disableGroupLink).not.toHaveBeenCalled();
    // null reads as false, as every other boolean parameter reads it.
    expect(await callApi(ctx, "group.link", { group: "Crew", on: false })).toEqual({ group: "g1", link: null });
    expect(await callApi(ctx, "group.link", { group: "Crew", on: null })).toEqual({ group: "g1", link: null });
    expect(disableGroupLink).toHaveBeenCalledTimes(2);
    expect(await callApi(ctx, "group.link", { group: "Crew" })).toEqual({ group: "g1", link: LINK, url: expect.stringMatching(/#\/join\//) });
    expect(await callApi(ctx, "group.link", { group: "Crew", on: true, reset: true })).toEqual({ group: "g1", link: LINK, url: expect.stringMatching(/#\/join\//) });
    expect(enableGroupLink.mock.calls).toEqual([[{ groupId: "g1" }], [{ groupId: "g1", reset: true }]]);
  });
});

describe("group remove", () => {
  it("says on stderr, as the app's Remove dialog does, that the link still lets the member back while it is on", async () => {
    const { ctx, node } = fake();
    const remove = async (member: string) => await callApi(ctx, "group.remove", { group: "Crew", member }) as Record<string, unknown>;
    const removed = await remove("Ana");
    expect(node.removeGroupMember).toHaveBeenCalledWith({ groupId: "g1", key: "anakey" });
    expect(removed.warning).toBe("Ana can still join again with the group's link: ghostly group link g1 --reset gives it a new one and keeps them out");
    // A warning names no secret, and the answer is the group as before.
    expect(JSON.stringify(removed)).not.toContain(LINK);
    expect(removed).toMatchObject({ id: "g1", link: "<hidden>" });
    // No link on: nothing to say. A member the roster has no name for is "They".
    const noLink = { ...group, entryLink: undefined } as GroupView;
    node.getState = () => ({ links: [], groups: [noLink], settings: {}, transport: {} }) as unknown as EngineState;
    expect(await remove("Ana")).not.toHaveProperty("warning");
    node.getState = () => ({ links: [], groups: [group], settings: {}, transport: {} }) as unknown as EngineState;
    expect((await remove("bokey")).warning).toMatch(/^They can still join again/);
  });
});

describe("an invitation not yet joined", () => {
  it("is refused by the admin commands, saying so, never sent to the engine as a group it has not", async () => {
    // Before: rename, picture, link, rotate and invite answered the engine's "Group not found" (exit 1) while `group
    // show` listed the group; remove and admin said "No member" of a roster that had not come yet.
    const invited = (accepted: boolean) => ({ id: "g2", name: "Lab group", createdAt: 1, profile: "mesh", isAdmin: false, canSend: false, lastMessageAt: 0, invited: [], memberLinks: {}, members: [],
      invitation: { linkId: "chat-ana", contact: "anakey", admin: "anakey", members: 2, accepted } }) as unknown as GroupView;
    const { ctx, node } = fake();
    const calls = [["group.rename", { name: "Mine" }], ["group.picture", { clear: true }], ["group.link", {}], ["group.link", { on: false }], ["group.rotate", {}],
      ["group.invite", { chat: "ana" }], ["group.remove", { member: "Ana" }], ["group.admin", { member: "Ana" }], ["group.hub", { member: "Ana" }]] as const;
    for (const [accepted, message] of [
      [false, "You are not in Lab group yet: ghostly group accept 'Lab group' joins it"],
      [true, "You are not in Lab group yet: you accepted its invitation, and its admin has not let you in"],
    ] as const) {
      node.getState = () => ({ links: [], groups: [group, invited(accepted)], settings: {}, transport: {} }) as unknown as EngineState;
      for (const [method, params] of calls) await expect(callApi(ctx, method, { group: "Lab group", ...params }), method).rejects.toMatchObject({ code: "refused", message });
    }
    expect(node.renameGroup).not.toHaveBeenCalled();
    expect(node.rotateGroup).not.toHaveBeenCalled();
    expect(node.removeGroupMember).not.toHaveBeenCalled();
    // A group joined is as before.
    await callApi(ctx, "group.rename", { group: "Crew", name: "Crew 2" });
    expect(node.renameGroup).toHaveBeenCalledWith({ groupId: "g1", name: "Crew 2" });
  });
});

describe("an invitation that will not go on by itself", () => {
  it("says a link join nobody answered and an invitation taken back, which read as a live invitation", () => {
    const invited = (invitation: Record<string, unknown>) => ({ ...group, status: undefined, isAdmin: false, members: [], canSend: false, entryLink: undefined,
      invitation: { linkId: "l1", contact: "", admin: "anakey", members: 2, accepted: false, ...invitation } }) as unknown as GroupView;
    expect(groupJson(invited({ accepted: true, viaLink: true, stage: "knocked", unanswered: true })).invitation)
      .toEqual({ chat: "l1", accepted: true, viaLink: true, stage: "knocked", unanswered: true });
    expect(groupJson(invited({ linkId: "chat-ana", takenBack: true })).invitation)
      .toEqual({ chat: "chat-ana", accepted: false, viaLink: false, stage: null, takenBack: true });
    // One still going on is as before, with neither.
    expect(groupJson(invited({ linkId: "chat-ana" })).invitation).toEqual({ chat: "chat-ana", accepted: false, viaLink: false, stage: null });
  });
});

describe("other groups under the same id", () => {
  it("are shown beside the group held, a link hidden unless asked for", () => {
    expect(groupJson(group)).not.toHaveProperty("others");
    const view = { ...group, others: [{ linkId: "chat-zed", contact: "zed-key", name: "Crew", members: 3 }, { link: LINK }] };
    expect(groupJson(view).others).toEqual([{ chat: "chat-zed", name: "Crew", members: 3 }, { link: "<hidden>" }]);
    expect(groupJson(view, true).others).toEqual([{ chat: "chat-zed", name: "Crew", members: 3 }, { link: LINK }]);
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
