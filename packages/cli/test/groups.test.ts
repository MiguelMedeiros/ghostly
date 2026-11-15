import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createIdentity, encodeGroupEntryLink } from "@ghostly/core";
import type { EngineState, GroupView, StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, type ApiContext } from "../src/api";
import { parseArgs } from "../src/args";
import { COMMANDS, TEXT_COMMANDS, idSlot, positionals } from "../src/commands";
import { EventHub, type GhostlyEvent } from "../src/events";
import { openPersistentIndexedDb } from "../src/runtime/storage";
import { pageOf } from "./support/messagePage";
import { groupViewOf } from "./support/chatView";
import { groupJson, groupMessageJson } from "../src/views";
// covers: headless.groups, headless.group-admin, headless.group-call, groups.rename

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

  // Found in a bug hunt: at "replaced" it said nothing, exit 0, though knocking again does not get in: the next step is
  // the current link, and no daemon helps.
  it("stops at a replaced link, and says to ask for the current one", async () => {
    const { ctx, set } = oneShot();
    const answer = callApi(ctx, "group.join", { link: LINK });
    setTimeout(() => set([knocking("replaced")]), 5);
    expect(await answer).toEqual({ group: "g9", joined: false, stage: "replaced",
      warning: "This link was replaced or turned off: ask someone in the group for the current link, then ghostly group join <link>" });
  });

  it("at a full group, says how many members it holds of how many", async () => {
    const { ctx, set } = oneShot();
    const answer = callApi(ctx, "group.join", { link: LINK });
    const full = knocking("full");
    Object.assign(full.invitation!, { full: { n: 8, max: 8 } });
    setTimeout(() => set([full]), 5);
    expect(await answer).toEqual({ group: "g9", joined: false, stage: "full",
      warning: "No room yet: the group is full (8 of 8 members). Your app goes on knocking only while this profile is running, and gets in when there is room: keep it running (ghostly daemon --detach), then ghostly group show g9" });
  });

  // Found in a bug hunt: at "full" or "blocked" it left at once with no note, as if the join were over, though the
  // engine goes on knocking (the room comes back) and the knock ends with the one-shot.
  it("at a group with no room yet, answers at once and says the knock goes on only while the profile runs", async () => {
    const said = {
      full: "No room yet: the group is full",
      blocked: "No room yet: the group waits for every member's app to take more than eight members",
    };
    for (const stage of ["full", "blocked"] as const) {
      const { ctx, set } = oneShot();
      const answer = callApi(ctx, "group.join", { link: LINK });
      setTimeout(() => set([knocking(stage)]), 5);
      expect(await answer).toEqual({ group: "g9", joined: false, stage,
        warning: `${said[stage]}. Your app goes on knocking only while this profile is running, and gets in when there is room: keep it running (ghostly daemon --detach), then ghostly group show g9` });
    }
  });

  // Found in a bug hunt: through a daemon it answered {"group": id} only, so a script could not tell in from knocking
  // without a second `group show`. The daemon goes on knocking: it answers at once, with the stage it is at now.
  it("through a daemon, answers at once with whether it is in and at what stage", async () => {
    vi.useFakeTimers();
    try {
      const answer = callApi(oneShot("daemon").ctx, "group.join", { link: LINK });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await Promise.race([answer, Promise.resolve("still waiting")])).toEqual({ group: "g9", joined: false, stage: "knocking" });
      const active = { ...knocking("knocking"), status: "active", invitation: undefined } as unknown as GroupView;
      expect(await callApi(oneShot("daemon", active).ctx, "group.join", { link: LINK })).toEqual({ group: "g9", joined: true, stage: null });
    } finally { vi.useRealTimers(); }
  });

  // Found in a bug hunt: an accepted contact's invitation to the group, still waiting for its welcome, keeps its place
  // and the link is only noted beside it; nothing knocks, so it waited the full 60 s and said nobody had let it in.
  it("a contact's invitation to the group, accepted, its welcome not in: answers at once that the welcome comes with the profile running", async () => {
    vi.useFakeTimers();
    try {
      const accepted = { ...knocking("knocking"), invitation: { linkId: "c1", contact: "Alice", admin: "ak", members: 3, accepted: true } } as unknown as GroupView;
      const answer = callApi(oneShot("one-shot", accepted).ctx, "group.join", { link: LINK });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await Promise.race([answer, Promise.resolve("still waiting")])).toEqual({ group: "g9", joined: false, stage: null,
        warning: "Not in yet: you accepted Alice's invitation to this group, and its welcome has not arrived; the link was kept beside it, and knocks nowhere. The welcome arrives only while this profile is running: keep it running (ghostly daemon --detach), then ghostly group show g9" });
    } finally { vi.useRealTimers(); }
  });
});

describe("a one-shot group join of a link for a group id already held", () => {
  // Found in a bug hunt: in a group under the link's id already, the engine only keeps the link beside it (unless it is
  // my own group's link) and knocks nowhere, yet the one-shot answered `"joined": true` at once, no warning, and a
  // second group waited under the id that only `group show`'s `others` said.
  const id = "AbCdEfGhIjKlMnOpQrStUv";
  const host = createIdentity().pubKeyZ32;
  const code = encodeGroupEntryLink({ g: id, host });
  const url = `https://ghostly.tools/#/join/${code}`;
  const inGroup = { id, name: "Crew", createdAt: 1, profile: "mesh", status: "active", isAdmin: false, canSend: true, lastMessageAt: 0, invited: [], memberLinks: {}, members: [] } as unknown as GroupView;
  function held(before: GroupView, after: GroupView, mode: "one-shot" | "daemon" = "one-shot") {
    let groups = [before];
    const getState = () => ({ links: [], groups, settings: {}, transport: {} }) as unknown as EngineState;
    const node = { getState, joinGroupByLink: vi.fn(async () => { groups = [after]; return { groupId: id }; }) };
    return { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode, version: "test" } as unknown as ApiContext;
  }
  const pick = `keep the one you are in (ghostly engine keepGroup '{"groupId":"${id}"}') or take the link's instead (ghostly engine switchGroup '{"groupId":"${id}","to":"<its link, from group show --show-secret>"}')`;

  it("another's link, kept beside the group held: joined false at once, and says how to pick between them", async () => {
    const answer = await callApi(held(inGroup, { ...inGroup, others: [{ link: code }] }), "group.join", { link: url });
    expect(answer).toMatchObject({ group: id, joined: false, stage: null });
    expect(answer).toEqual({ group: id, joined: false, stage: null,
      warning: `Not joined: you are in a group under this link's id already, and only a group's welcome says whose a link is, so the link was kept beside that group and knocks nowhere. ghostly group show ${id} lists it under "others": ${pick}` });
  });

  // Found in a bug hunt: through a daemon it answered {"group": id} only, and nothing said the link was only kept.
  it("through a daemon, another's link kept beside the group held: says so, as the one-shot does", async () => {
    expect(await callApi(held(inGroup, { ...inGroup, others: [{ link: code }] }, "daemon"), "group.join", { link: url })).toEqual({ group: id, joined: false, stage: null,
      warning: `Not joined: you are in a group under this link's id already, and only a group's welcome says whose a link is, so the link was kept beside that group and knocks nowhere. ghostly group show ${id} lists it under "others": ${pick}` });
  });

  it("another's link with no room left beside it: joined false, and says it was not kept", async () => {
    const full = { ...inGroup, others: [1, 2, 3, 4].map((n) => ({ linkId: `c${n}`, contact: "", name: "Other", members: 2 })) } as GroupView;
    const answer = await callApi(held(full, full), "group.join", { link: code });
    expect(answer).toMatchObject({ group: id, joined: false, stage: null });
    expect((answer as { warning: string }).warning).toBe(`Not joined: you are in a group under this link's id already, and as many other groups as are kept already wait beside it to be picked, so the link was not kept. ghostly group show ${id} lists them under "others": ${pick}, then open the link again`);
  });

  it("my own group's link, as its admin: in, as before", async () => {
    const mine = { ...inGroup, isAdmin: true, entryLink: code } as GroupView;
    expect(await callApi(held(mine, mine), "group.join", { link: url })).toEqual({ group: id, joined: true, stage: null });
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

  it("is refused to a member removed from the group, as group send is, never the link it held when it was removed", async () => {
    // Before: the old link with exit 0, while `group show` said removed and link null; it may have been reset since.
    const { ctx, node } = fake();
    const enableGroupLink = vi.fn(async () => ({ link: LINK })), disableGroupLink = vi.fn(async () => undefined);
    Object.assign(node, { enableGroupLink, disableGroupLink });
    const out = (status: string, statusReason?: string) => {
      node.getState = () => ({ links: [], groups: [{ ...group, profile: "community", isAdmin: false, canSend: false, status, statusReason }], settings: {}, transport: {} }) as unknown as EngineState;
    };
    out("removed", "You were removed from this group");
    for (const params of [{}, { reset: true }, { on: false }])
      await expect(callApi(ctx, "group.link", { group: "Crew", ...params }), JSON.stringify(params)).rejects.toMatchObject({ code: "refused", message: "You were removed from this group" });
    out("left");
    await expect(callApi(ctx, "group.link", { group: "Crew" })).rejects.toMatchObject({ code: "refused", message: "You are not in this group" });
    expect(enableGroupLink).not.toHaveBeenCalled();
    expect(disableGroupLink).not.toHaveBeenCalled();
    // A community member who lost its hubs is still in it: it asks to be let in again by itself.
    out("lost");
    expect(await callApi(ctx, "group.link", { group: "Crew" })).toEqual({ group: "g1", link: LINK, url: expect.stringMatching(/#\/join\//) });
  });
});

describe("group accept", () => {
  // Found in a bug hunt: a community with nothing to accept (one this profile is in, or was removed from) answered
  // {"group": id}, exit 0, as if accepted: the engine's knock again does nothing there. A private group said "No
  // invitation to accept", without why.
  const as = (node: ReturnType<typeof fake>["node"], view: Partial<GroupView>) => {
    node.getState = () => ({ links: [], groups: [{ ...group, ...view }], settings: {}, transport: {} }) as unknown as EngineState;
  };
  const knock = { linkId: "c1", contact: "", admin: "", members: 0, accepted: true, viaLink: true, stage: "knocking" } as unknown as GroupView["invitation"];

  it("is refused for a group with no invitation, saying why, and never reaches the engine", async () => {
    const { ctx, node } = fake();
    const acceptGroupInvitation = vi.fn(async () => undefined);
    Object.assign(node, { acceptGroupInvitation });
    for (const profile of ["community", "mesh"] as const) {
      as(node, { profile, status: "active" });
      await expect(callApi(ctx, "group.accept", { group: "Crew" }), profile).rejects.toMatchObject({ code: "refused", message: "You are in Crew already: there is no invitation to accept" });
      as(node, { profile, status: "removed", statusReason: "You were removed from this group", isAdmin: false, canSend: false });
      await expect(callApi(ctx, "group.accept", { group: "Crew" }), profile).rejects.toMatchObject({ code: "refused", message: "You were removed from this group: there is no invitation to accept" });
    }
    as(node, { profile: "community", status: "left", isAdmin: false, canSend: false });
    await expect(callApi(ctx, "group.accept", { group: "Crew" })).rejects.toMatchObject({ code: "refused", message: "You are not in this group: there is no invitation to accept" });
    expect(acceptGroupInvitation).not.toHaveBeenCalled();
  });

  it("goes to the engine for an invitation or a knock, a removed member's knock to get back in too", async () => {
    const { ctx, node } = fake();
    const acceptGroupInvitation = vi.fn(async () => undefined);
    Object.assign(node, { acceptGroupInvitation });
    for (const view of [{ profile: "community", invitation: knock }, { profile: "community", status: "removed", invitation: knock }, { profile: "mesh", members: [], invitation: { linkId: "c1", contact: "Ana", admin: "anakey", members: 2 } }] as Partial<GroupView>[]) {
      as(node, view);
      expect(await callApi(ctx, "group.accept", { group: "Crew" })).toEqual({ group: "g1" });
    }
    expect(acceptGroupInvitation).toHaveBeenCalledTimes(3);
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

describe("group call", () => {
  const SFU = "https://call.example.com";
  const thursday = { ...group, id: "g7", name: "Thursday", profile: "community", entryLink: undefined } as unknown as GroupView;
  /** A community whose view names the node the last `setGroupCall` set, as the engine's does once the statement is signed. */
  function community(admin = true) {
    const { ctx, node } = fake();
    let call: { sfu: string; e2ee?: 1 } | undefined;
    // Left out, `e2ee` stays as it was, as the engine's `setCall` keeps it.
    const setGroupCall = vi.fn(async ({ sfu, e2ee }: { groupId: string; sfu: string | null; e2ee?: boolean }) => {
      const sealed = e2ee ?? call?.e2ee === 1;
      call = sfu === null ? undefined : sealed ? { sfu, e2ee: 1 } : { sfu };
    });
    Object.assign(node, { setGroupCall, getState: () => ({ links: [], groups: [{ ...thursday, isAdmin: admin, ...(call && { call }) }, group], settings: {}, transport: {} }) as unknown as EngineState });
    return { ctx, setGroupCall };
  }
  const show = async (ctx: ApiContext) => await callApi(ctx, "group.get", { group: "Thursday" }) as Record<string, unknown>;

  it("the admin sets it and group show prints call.sfu; --clear removes it", async () => {
    const { ctx, setGroupCall } = community();
    expect((await show(ctx)).call).toBeNull();
    expect(await callApi(ctx, "group.call", { group: "Thursday", sfu: SFU })).toMatchObject({ id: "g7", call: { sfu: SFU } });
    expect(setGroupCall).toHaveBeenLastCalledWith({ groupId: "g7", sfu: SFU });
    expect((await show(ctx)).call).toEqual({ sfu: SFU, e2ee: false });
    expect(await callApi(ctx, "group.call", { group: "Thursday", clear: true })).toMatchObject({ id: "g7", call: null });
    expect(setGroupCall).toHaveBeenLastCalledWith({ groupId: "g7", sfu: null });
    expect((await show(ctx)).call).toBeNull();
  });

  it("--e2ee turns sealed call media on with the node or alone, --no-e2ee off, and group show prints call.e2ee", async () => {
    const { ctx, setGroupCall } = community();
    await expect(callApi(ctx, "group.call", { group: "Thursday", e2ee: true })).rejects.toMatchObject({ code: "refused", message: "Thursday has no call node: ghostly group call Thursday --sfu <https origin> --e2ee" });
    expect(setGroupCall).not.toHaveBeenCalled();
    expect(await callApi(ctx, "group.call", { group: "Thursday", sfu: SFU, e2ee: true })).toMatchObject({ call: { sfu: SFU, e2ee: true } });
    expect(setGroupCall).toHaveBeenLastCalledWith({ groupId: "g7", sfu: SFU, e2ee: true });
    // The node named again without a word on e2ee: the engine keeps it on.
    await callApi(ctx, "group.call", { group: "Thursday", sfu: SFU });
    expect(setGroupCall).toHaveBeenLastCalledWith({ groupId: "g7", sfu: SFU });
    expect((await show(ctx)).call).toEqual({ sfu: SFU, e2ee: true });
    expect(await callApi(ctx, "group.call", { group: "Thursday", e2ee: false })).toMatchObject({ call: { sfu: SFU, e2ee: false } });
    expect(setGroupCall).toHaveBeenLastCalledWith({ groupId: "g7", sfu: SFU, e2ee: false });
    await callApi(ctx, "group.call", { group: "Thursday", e2ee: true });
    expect(setGroupCall).toHaveBeenLastCalledWith({ groupId: "g7", sfu: SFU, e2ee: true });
    await expect(callApi(ctx, "group.call", { group: "Thursday", e2ee: "yes" })).rejects.toMatchObject({ code: "bad_request", message: "e2ee must be true or false" });
  });

  it("refuses a member who is not the admin, and a private group, before the engine signs anything", async () => {
    const { ctx, setGroupCall } = community(false);
    await expect(callApi(ctx, "group.call", { group: "Thursday", sfu: SFU })).rejects.toMatchObject({ code: "refused", message: "Only the admin of Thursday sets its call node" });
    await expect(callApi(ctx, "group.call", { group: "Thursday", clear: true })).rejects.toMatchObject({ code: "refused" });
    await expect(callApi(ctx, "group.call", { group: "Crew", sfu: SFU })).rejects.toMatchObject({ code: "refused", message: "Crew is a private group: only a community group has calls through a node" });
    expect(setGroupCall).not.toHaveBeenCalled();
  });

  it("refuses a profile out of the community with why, as rename and picture do, not as one who is not its admin", async () => {
    // Before: "Only the admin of Thursday sets its call node" to a member removed, and to the admin who left it.
    const { ctx, node } = fake();
    for (const [status, statusReason, message] of [
      ["removed", "You were removed from this group", "You were removed from this group"],
      ["left", undefined, "You are not in this group"],
    ] as const) {
      node.getState = () => ({ links: [], groups: [{ ...thursday, isAdmin: false, status, statusReason }, group], settings: {}, transport: {} }) as unknown as EngineState;
      for (const params of [{ sfu: SFU }, { clear: true }]) {
        await expect(callApi(ctx, "group.call", { group: "Thursday", ...params }), status).rejects.toMatchObject({ code: "refused", message });
      }
    }
  });

  it("refuses anything but an https origin in its one spelling before signing, naming the origin when there is one", async () => {
    const { ctx, setGroupCall } = community();
    for (const [sfu, message] of [
      ["http://call.example.com", "\"http://call.example.com\" is not an https origin: a call node is like https://call.example.com"],
      ["wss://call.example.com", "\"wss://call.example.com\" is not an https origin: a call node is like https://call.example.com"],
      ["call.example.com", "\"call.example.com\" is not an https origin: a call node is like https://call.example.com"],
      [`https://${"a".repeat(200)}.com`, `"https://${"a".repeat(200)}.com" is not an https origin: a call node is like https://call.example.com`],
      ["https://call.example.com/sfu", "\"https://call.example.com/sfu\" is not an origin (no path, query or trailing /): ghostly group call Thursday --sfu https://call.example.com"],
      ["https://call.example.com/", "\"https://call.example.com/\" is not an origin (no path, query or trailing /): ghostly group call Thursday --sfu https://call.example.com"],
      ["https://Call.Example.com:443", "\"https://Call.Example.com:443\" is not an origin (no path, query or trailing /): ghostly group call Thursday --sfu https://call.example.com"],
      ["https://call.example.com?x=1", "\"https://call.example.com?x=1\" is not an origin (no path, query or trailing /): ghostly group call Thursday --sfu https://call.example.com"],
    ] as const) await expect(callApi(ctx, "group.call", { group: "Thursday", sfu }), sfu).rejects.toMatchObject({ code: "bad_request", message });
    expect(setGroupCall).not.toHaveBeenCalled();
    // A port that is not the default one is part of the origin.
    await callApi(ctx, "group.call", { group: "Thursday", sfu: "https://call.example.com:8443" });
    expect(setGroupCall).toHaveBeenLastCalledWith({ groupId: "g7", sfu: "https://call.example.com:8443" });
  });

  it("refuses sfu with clear on the socket, as the command line refuses --sfu with --clear, before anything is signed", async () => {
    // Before: `clear` won, the node was cleared and `call: null` came back, exit 0.
    const { ctx, setGroupCall } = community();
    await callApi(ctx, "group.call", { group: "Thursday", sfu: SFU });
    setGroupCall.mockClear();
    await expect(callApi(ctx, "group.call", { group: "Thursday", sfu: SFU, clear: true })).rejects.toMatchObject({ code: "bad_request", message: "clear removes the call node: not with sfu" });
    await expect(callApi(ctx, "group.call", { group: "Thursday", e2ee: false, clear: true })).rejects.toMatchObject({ code: "bad_request", message: "clear removes the call node: not with e2ee" });
    expect(setGroupCall).not.toHaveBeenCalled();
    expect((await show(ctx)).call).toEqual({ sfu: SFU, e2ee: false });
  });

  it("takes --sfu or --clear, one of them, and --e2ee or --no-e2ee with --sfu or alone", () => {
    const command = COMMANDS["group call"];
    const params = (argv: string[]) => { const parsed = parseArgs(argv, command.options ?? {}, idSlot(command)); return command.params!(parsed, positionals(command, parsed.positionals)); };
    expect(params(["Thursday", "--sfu", SFU])).toEqual({ group: "Thursday", sfu: SFU });
    expect(params(["Thursday", "--clear"])).toEqual({ group: "Thursday", clear: true });
    // Every form the usage line takes, `--e2ee` or `--no-e2ee` alone too: before, only --sfu and --clear (agents#6029).
    expect(() => params(["Thursday"])).toThrow("Missing --sfu, --e2ee, --no-e2ee or --clear: ghostly group call <group> --sfu <https origin> [--e2ee | --no-e2ee] | --e2ee | --no-e2ee | --clear");
    expect(() => params(["Thursday", "--sfu", SFU, "--clear"])).toThrow("--clear removes the call node: not with --sfu");
    expect(params(["Thursday", "--sfu", SFU, "--e2ee"])).toEqual({ group: "Thursday", sfu: SFU, e2ee: true });
    expect(params(["Thursday", "--no-e2ee"])).toEqual({ group: "Thursday", e2ee: false });
    expect(() => params(["Thursday", "--clear", "--e2ee"])).toThrow("--clear removes the call node: not with --e2ee or --no-e2ee");
    expect(() => params(["Thursday", "--e2ee", "--no-e2ee"])).toThrow("--e2ee or --no-e2ee, not both");
  });
});

describe("a picture", () => {
  it("refuses path with clear on the socket, as the command line refuses a <jpeg> with --clear, before the engine is asked", async () => {
    // Before: `clear` won and the picture was removed, exit 0.
    const { ctx, node } = fake();
    const setGroupPicture = vi.fn(async () => undefined), updateSettings = vi.fn(async () => undefined);
    Object.assign(node, { setGroupPicture, updateSettings });
    for (const [method, params] of [["group.picture", { group: "Crew" }], ["profile.picture", {}]] as const) {
      await expect(callApi(ctx, method, { ...params, path: "/tmp/me.jpg", clear: true }), method).rejects.toMatchObject({ code: "bad_request", message: "clear removes the picture: not with path" });
    }
    expect(setGroupPicture).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
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
