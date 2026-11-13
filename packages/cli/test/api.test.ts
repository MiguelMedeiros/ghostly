import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AWAITING_PEER_MS, OwnInviteError, type PairingProgress } from "@ghostly/core";
import type { EngineState, GroupView, LinkView, Settings, StoredMessage } from "@ghostly/browser/shared/types";
import { callApi, findChat, findGroup, hideStateSecrets, mentionsFor, redactSettings, type ApiContext } from "../src/api";
import { chatOrGroup, findChatOrGroup, findOwnNamedChat } from "../src/apiKit";
import { parseArgs } from "../src/args";
import { COMMANDS } from "../src/commands";
import { ENGINE_PARAMS } from "../src/engineMethods";
import { asCliError } from "../src/errors";
import type { GhostlyEvent } from "../src/events";
import { allowlist } from "../src/listen";
import { chatDetailsJson, chatJson, isLive } from "../src/views";
import { pageOf } from "./support/messagePage";
import { ONE_SHOT_RECEIPT_MS } from "../src/waits";
// covers: headless.api, headless.engine-passthrough, headless.secret-guard, headless.typing, chat.order

/** The API over a fake engine: what it checks before the engine is asked, and what it makes of the answers. */
const link = (id: string, fields: Partial<LinkView> = {}) => ({ id, peerPubKeyZ32: "p" + id, createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", ...fields }) as unknown as LinkView;
const group: GroupView = {
  id: "g1", name: "Crew", createdAt: 1, profile: "community", isAdmin: true, canSend: true, lastMessageAt: 0, invited: [], memberLinks: {},
  members: [
    { key: "mekey", role: "admin", me: true, online: true, missing: 0 },
    { key: "abcd1234zz", role: "member", me: false, online: true, missing: 0, nick: "Ana" },
    { key: "abce9999yy", role: "member", me: false, online: true, missing: 0, nick: "Bo" },
  ],
} as unknown as GroupView;

function fake(messages: StoredMessage[] = []) {
  const listeners = new Set<(e: GhostlyEvent) => void>();
  const node = {
    getState: () => ({ links: [link("chat-one", { label: "Alice" }), link("chat-two", { peerNick: "Bob" })], groups: [group], settings: { online: true, nick: "Bot", relays: ["r"], holdStorage: { s3: { accessKeyId: "AK", secretAccessKey: "SK" } }, avatar: "data:x" } as unknown as Settings, transport: { protocol: "p", relays: [] } }) as unknown as EngineState,
    getMessages: vi.fn(async () => messages),
    getMessage: vi.fn(async (_linkId: string, id: string) => messages.find((m) => m.id === id)),
    messagePage: vi.fn(async (params: { limit?: number; before?: string | number }) => pageOf(messages, params)),
    sendMessage: vi.fn(async () => ({ error: null, messageId: "me_1" })),
    sendGroupMessage: vi.fn(async () => ({ error: null })),
    walletCreate: vi.fn(async () => ({ id: "w" })),
    payRequest: vi.fn(async () => undefined),
    storeMessage: vi.fn(),
    updateSettings: vi.fn(async () => undefined),
    setChatTransport: vi.fn(async () => undefined),
    setTyping: vi.fn(),
    setGroupTyping: vi.fn(),
  };
  const ctx = {
    runtime: { server: { node }, paths: { name: "default" } },
    hub: { onEvent: (l: (e: GhostlyEvent) => void) => { listeners.add(l); return () => listeners.delete(l); }, onState: () => () => {}, lastSeq: 0, replay: () => [] },
    calls: { list: () => [], forgetChat: vi.fn() },
    groupAuto: { get: () => ({ on: false, from: [] }), forgetChat: vi.fn() },
    mode: "daemon", version: "test",
  } as unknown as ApiContext;
  return { ctx, node, emit: (e: GhostlyEvent) => { for (const l of listeners) l(e); } };
}

const msg = (id: string, timestamp: number, fields: Partial<StoredMessage> = {}): StoredMessage => ({ linkId: "chat-one", id, text: id, sender: "peer", timestamp, via: "datalink", ...fields });

describe("chats", () => {
  it("are found by id, unique prefix or name, never by a guess", () => {
    const links = [link("abc1", { label: "Alice" }), link("abc2", { peerNick: "Bob" })];
    expect(findChat(links, "abc1").id).toBe("abc1");
    expect(findChat(links, "bob").id).toBe("abc2");
    expect(() => findChat(links, "abc")).toThrow(/more than one/);
    expect(() => findChat(links, "zed")).toThrow(/No chat/);
  });

  // A chat's name was taken whatever it held and cut by the engine at 48 UTF-16 units: half an emoji stayed as a lone
  // surrogate, a newline was kept, and the invite was made before its name was cut.
  it("a chat's name is what the engine keeps whole, refused before anything is made", async () => {
    const { ctx, node } = fake();
    const calls = Object.assign(node, { renameLink: vi.fn(), createLink: vi.fn(), joinLink: vi.fn() });
    const long = { code: "bad_request", message: "A chat's name is up to 48 characters as stored (this one is 49)", details: { length: 49, max: 48 } };
    const unseen = { code: "bad_request", message: "A chat's name needs a character that shows (an empty name gives back the contact's own)" };
    for (const [name, rule] of [["y".repeat(49), long], [`${"x".repeat(48)}👻`, long], ["\u200b", unseen], ["\u0301\u0301", unseen], ["\u200e \u2066", unseen]] as const) {
      await expect(callApi(ctx, "chat.rename", { chat: "chat-one", name }), JSON.stringify(name)).rejects.toMatchObject(rule);
      await expect(callApi(ctx, "invite.create", { label: name }), JSON.stringify(name)).rejects.toMatchObject(rule);
      await expect(callApi(ctx, "invite.join", { invite: "ghostly1abc", label: name }), JSON.stringify(name)).rejects.toMatchObject(rule);
    }
    for (const made of [calls.renameLink, calls.createLink, calls.joinLink]) expect(made).not.toHaveBeenCalled();
    // What the engine keeps whole is taken, cleaned as it stores it: an emoji is one character, as the engine counts.
    await callApi(ctx, "chat.rename", { chat: "chat-one", name: ` ${"x".repeat(47)}👻 ` });
    expect(calls.renameLink).toHaveBeenLastCalledWith({ linkId: "chat-one", label: `${"x".repeat(47)}👻` });
  });

  // One rule for every name this side writes (a chat's, the profile's, a group's): cleaned as the engine stores it, then
  // counted. A tab was refused as a second line for a chat or the profile and taken as a space for a group, a name 48
  // long once stored was refused at its raw length, and an invisible-only name cleared a chat's name with exit 0 (the
  // profile kept it as its name).
  it("a chat's and the profile's name are cleaned first, then counted; nothing that shows is refused", async () => {
    const { ctx, node } = fake();
    const calls = Object.assign(node, { renameLink: vi.fn() });
    const label = async (name: string) => { await callApi(ctx, "chat.rename", { chat: "chat-one", name }); return calls.renameLink.mock.lastCall?.[0].label; };
    expect(await label("tab\tbot")).toBe("tab bot");
    expect(await label("two\nlines")).toBe("two lines");
    expect(await label(`${"x".repeat(48)}   `)).toBe("x".repeat(48));
    expect(await label(`${"a".repeat(47)}\u200b\u200b\u200bb`)).toBe(`${"a".repeat(47)}b`);
    // NFC, as a ref is compared (`nameKey`): a decomposed é is one character.
    expect(await label(`${"e\u0301".repeat(48)}`)).toBe("é".repeat(48));
    // The documented empty name: back to the contact's own.
    expect(await label("")).toBe("");
    expect(await label("  ")).toBe("");
    // The answer is the chat's, as before.
    expect(Object.keys(await callApi(ctx, "chat.rename", { chat: "chat-one", name: "tab\tbot" }) as object)).toEqual(Object.keys(await callApi(ctx, "chat.rename", { chat: "chat-one", name: "bot" }) as object));

    const nick = async (method: string, params: Record<string, unknown>) => { await callApi(ctx, method, params); return (calls.updateSettings.mock.lastCall as unknown as [{ settings: Settings }])[0].settings.nick; };
    expect(await nick("profile.set", { name: "tab\tname" })).toBe("tab name");
    expect(await nick("settings.set", { nick: "tab\tnick" })).toBe("tab nick");
    expect(await nick("profile.set", { name: `${"p".repeat(63)}\u200b\u200b\u200bq` })).toBe(`${"p".repeat(63)}q`);
    expect(await nick("profile.set", { name: `${"p".repeat(64)}  ` })).toBe("p".repeat(64));
    expect(await nick("profile.set", { name: "" })).toBe("");
    expect(Object.keys(await callApi(ctx, "profile.set", { name: "tab\tname" }) as object)).toEqual(["profile", "name", "shareProfile", "picture", "online"]);
    calls.updateSettings.mockClear();
    for (const name of ["\u200b", "\u0301\u0301", "\u2800"]) {
      await expect(callApi(ctx, "profile.set", { name }), JSON.stringify(name)).rejects.toMatchObject({ code: "bad_request", message: "name needs a character that shows (an empty one is no name)" });
      await expect(callApi(ctx, "settings.set", { nick: name }), JSON.stringify(name)).rejects.toMatchObject({ code: "bad_request", message: "nick needs a character that shows (an empty one is no name)" });
    }
    await expect(callApi(ctx, "profile.set", { name: "p".repeat(65) })).rejects.toMatchObject({ code: "bad_request", message: "name is up to 64 characters as stored (this one is 65)", details: { length: 65, max: 64 } });
    expect(calls.updateSettings).not.toHaveBeenCalled();
  });

  // A group's name has the same refusals: it said "1 to 64 characters on one line" to a name of two invisible ones.
  it("a group's name is cleaned first, then counted, and nothing that shows is refused as a chat's name is", async () => {
    const { ctx, node } = fake();
    const calls = Object.assign(node, { createGroup: vi.fn(async () => ({ groupId: "g2" })), renameGroup: vi.fn(async () => undefined) });
    const groupUnseen = { code: "bad_request", message: "A group's name needs a character that shows" };
    const groupLong = { code: "bad_request", message: "A group's name is up to 64 characters as stored (this one is 65)", details: { length: 65, max: 64 } };
    expect(await callApi(ctx, "group.create", { name: "tab\tcrew", profile: "mesh" })).toEqual({ group: "g2", link: null });
    expect(calls.createGroup).toHaveBeenLastCalledWith({ name: "tab crew", profile: "mesh" });
    await callApi(ctx, "group.create", { name: `${"g".repeat(63)}\u200b\u200b\u200bh`, profile: "mesh" });
    expect(calls.createGroup).toHaveBeenLastCalledWith({ name: `${"g".repeat(63)}h`, profile: "mesh" });
    await callApi(ctx, "group.rename", { group: "Crew", name: "tab\tcrew" });
    expect(calls.renameGroup).toHaveBeenLastCalledWith({ groupId: "g1", name: "tab crew" });
    for (const [name, rule] of [["\u200b\u200b", groupUnseen], ["\u0301\u0301", groupUnseen], ["g".repeat(65), groupLong]] as const) {
      await expect(callApi(ctx, "group.create", { name, profile: "mesh" }), JSON.stringify(name)).rejects.toMatchObject(rule);
      await expect(callApi(ctx, "group.rename", { group: "Crew", name }), JSON.stringify(name)).rejects.toMatchObject(rule);
    }
    expect(calls.createGroup).toHaveBeenCalledTimes(2);
    expect(calls.renameGroup).toHaveBeenCalledTimes(1);
  });

  // A name is counted in code points, as the engine keeps it, so a joined emoji counts as several (a family of four is
  // 7, a flag or a skin tone 2). The refusal said "up to 48 characters on one line" to 7 emoji on one line, with no
  // count: it now says the count as stored and what counts as several, and gives both numbers as details.
  it("a name too long says its count as stored and the emoji that counts as several, for a chat, the profile and a group", async () => {
    const { ctx, node } = fake();
    const calls = Object.assign(node, { renameLink: vi.fn(), createLink: vi.fn(), createGroup: vi.fn(async () => ({ groupId: "g2" })), renameGroup: vi.fn(async () => undefined) });
    const family = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}";
    const flag = "\u{1F1E7}\u{1F1F7}";
    const chatRules = [
      [family.repeat(7), `A chat's name is up to 48 characters as stored (this one is 49: ${family} counts as 7)`, 49],
      [flag.repeat(25), `A chat's name is up to 48 characters as stored (this one is 50: ${flag} counts as 2)`, 50],
      [`${"x".repeat(46)}\u{1F44D}${flag}`, `A chat's name is up to 48 characters as stored (this one is 49: ${flag} counts as 2)`, 49],
    ] as const;
    for (const [name, message, length] of chatRules) {
      await expect(callApi(ctx, "chat.rename", { chat: "chat-one", name }), message).rejects.toMatchObject({ code: "bad_request", message, details: { length, max: 48 } });
      await expect(callApi(ctx, "invite.create", { label: name }), message).rejects.toMatchObject({ code: "bad_request", message, details: { length, max: 48 } });
    }
    expect(calls.renameLink).not.toHaveBeenCalled();
    expect(calls.createLink).not.toHaveBeenCalled();
    // At the limit as stored: taken, single emoji or a skin tone included.
    for (const name of ["\u{1F44D}".repeat(48), `${"x".repeat(46)}\u{1F44D}\u{1F3FD}`, family.repeat(6) + "x".repeat(6)]) {
      await callApi(ctx, "chat.rename", { chat: "chat-one", name });
      expect(calls.renameLink).toHaveBeenLastCalledWith({ linkId: "chat-one", label: name });
    }

    const tenFamilies = family.repeat(10);
    const profileRule = (field: string) => ({ code: "bad_request", message: `${field} is up to 64 characters as stored (this one is 70: ${family} counts as 7)`, details: { length: 70, max: 64 } });
    await expect(callApi(ctx, "profile.set", { name: tenFamilies })).rejects.toMatchObject(profileRule("name"));
    await expect(callApi(ctx, "settings.set", { nick: tenFamilies })).rejects.toMatchObject(profileRule("nick"));
    expect(calls.updateSettings).not.toHaveBeenCalled();

    const groupRule = { code: "bad_request", message: `A group's name is up to 64 characters as stored (this one is 70: ${family} counts as 7)`, details: { length: 70, max: 64 } };
    await expect(callApi(ctx, "group.create", { name: tenFamilies, profile: "mesh" })).rejects.toMatchObject(groupRule);
    await expect(callApi(ctx, "group.rename", { group: "Crew", name: tenFamilies })).rejects.toMatchObject(groupRule);
    expect(calls.createGroup).not.toHaveBeenCalled();
    expect(calls.renameGroup).not.toHaveBeenCalled();
    await callApi(ctx, "group.create", { name: "\u{1F44D}".repeat(64), profile: "mesh" });
    expect(calls.createGroup).toHaveBeenLastCalledWith({ name: "\u{1F44D}".repeat(64), profile: "mesh" });
  });

  // `invite join <your own invite>` said the engine's tag for its RPC clients: "own-invite <chat id>: This is your own…".
  it("joining your own invite is refused in a sentence alone, with the chat that owns it as its own field", async () => {
    const { ctx, node } = fake();
    const said = "This is your own invite. Share it with a contact; they join with it.";
    for (const thrown of [new OwnInviteError("chat-one"), new Error(new OwnInviteError("chat-one").message)]) {
      Object.assign(node, { joinLink: vi.fn(async () => { throw thrown; }) });
      await expect(callApi(ctx, "invite.join", { invite: "ghostly1abc" })).rejects.toMatchObject({ code: "refused", message: said, details: { chat: "chat-one" } });
    }
  });

  it("a contact's own name never stands for someone else: a key finds only its chat, a label wins over a name", () => {
    const KEY = "ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1o";
    const alice = link("chatAlice", { label: "Alice", peerNick: "Alice", peerPubKeyZ32: KEY });
    const mallory = link("chatMallory", { peerNick: KEY });
    const impostor = link("chatImpostor", { peerNick: "alice" });
    expect(findChat([mallory, alice], KEY).id).toBe("chatAlice");
    expect(() => findChat([mallory], KEY)).toThrow(/No chat/);
    expect(findChat([impostor, alice], "Alice").id).toBe("chatAlice");
    expect(findChat([impostor], "alice").id).toBe("chatImpostor");
    // What a script or a paste leaves on a key (a line break, a space, an invisible character, capitals) keeps it a key.
    for (const ref of [`${KEY}\n`, ` ${KEY}`, `${KEY}${String.fromCodePoint(0x200b)}`, KEY.toUpperCase()]) {
      expect(findChat([mallory, alice], ref).id).toBe("chatAlice");
      expect(() => findChat([mallory], ref)).toThrow(expect.objectContaining({ code: "not_found", message: expect.stringMatching(/^No chat with/) }));
    }
  });

  it("a contact's key with no chat is no group either, whatever a group's admin named it", () => {
    const KEY = "ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1o";
    const named = { id: "g".repeat(22), name: KEY, members: [], status: "joined" } as unknown as GroupView;
    for (const ref of [KEY, `${KEY}\n`, ` ${KEY}`, `${KEY}${String.fromCodePoint(0x200b)}`, KEY.toUpperCase()]) {
      expect(() => findChatOrGroup([], [named], ref)).toThrow(expect.objectContaining({ code: "not_found", message: expect.stringMatching(/^No chat with/) }));
    }
    expect(findChatOrGroup([], [named], `group:${KEY}`)).toEqual({ group: named });
  });

  it("a name is found by the string that set it: cleaned as the engine cleans a name it stores (agents#2907)", () => {
    // `chat rename X "bot "` stores "bot", `group create "Team  "` stores "Team": the same string given back finds it.
    // Trailing and doubled spaces, a zero-width space, a bidi mark, and a decomposed "é" (e + U+0301) against the
    // precomposed one (and back), for a label, a contact's own name and a group's name.
    const refs: [stored: string, typed: string][] = [
      ["bot", "bot "], ["bot", " bot "], ["my bot", "my  bot"], ["my bot", "my\tbot"], ["bot", "b\u200bot"],
      ["rtl", "rtl\u202e"], ["rtl", "\u200frtl"], ["Jos\u00e9", "Jose\u0301"], ["Jose\u0301", "jos\u00e9"],
    ];
    for (const [stored, typed] of refs) {
      expect(findChat([link("chatOther", { label: "other" }), link("chatLabel", { label: stored })], typed).id).toBe("chatLabel");
      expect(findChat([link("chatOther", { label: "other" }), link("chatNick", { peerNick: stored })], typed).id).toBe("chatNick");
      const named = { ...group, id: "n".repeat(22), name: stored, status: "active" } as unknown as GroupView;
      const other = { ...group, id: "o".repeat(22), name: "other", status: "active" } as unknown as GroupView;
      expect(findGroup([other, named], typed).id).toBe(named.id);
      expect(findChatOrGroup([link("chatOther", { label: "other" })], [other, named], typed)).toEqual({ group: named });
      // A contact's own name still never takes a group's name, however it was typed.
      expect(() => findChatOrGroup([link("chatNick", { peerNick: stored })], [named], typed)).toThrow(/and a group/);
    }
    // Two chats whose names clean to one stay ambiguous; a ref with nothing visible left names nothing.
    expect(() => findChat([link("chatA", { label: "my bot" }), link("chatB", { label: "My  Bot" })], "my bot ")).toThrow(expect.objectContaining({ code: "bad_request", details: { matches: ["chatA", "chatB"] } }));
    expect(() => findChat([link("chatA", { label: "bot" })], "\u200b")).toThrow(/No chat/);
    expect(() => findGroup([{ ...group, id: "n".repeat(22), name: "bot" } as unknown as GroupView], "\u202e")).toThrow(/No group/);
    // Ids, keys and prefixes stay exact: nothing is cleaned off them.
    const chat = link("chatExact", { label: "bot" });
    expect(findChat([chat], "chatExact").id).toBe("chatExact");
    expect(findChat([chat], "chatEx").id).toBe("chatExact");
    expect(() => findChat([chat], "chatExact ")).toThrow(/No chat/);
    expect(() => findChat([chat], "chat\u200bExact")).toThrow(/No chat/);
    const room = { ...group, id: "r".repeat(22), name: "Team" } as unknown as GroupView;
    expect(findGroup([room], room.id).id).toBe(room.id);
    expect(() => findGroup([room], `${room.id} `)).toThrow(/No group/);
    expect(() => findGroup([room], "rrr\u200b")).toThrow(/No group/);
  });

  it("a contact's own name never takes what names a group: the group's id is the group, its name or a prefix is refused", () => {
    const GROUP = "g".repeat(22);
    const room = { ...group, id: GROUP, name: "Team Room", status: "active" } as unknown as GroupView;
    const asName = link("chatMallory", { peerNick: "Team Room" });
    const asId = link("chatIdName", { peerNick: GROUP });
    const asPrefix = link("chatPrefixName", { peerNick: "gggg" });
    const refused = (links: LinkView[], ref: string) => { try { findChatOrGroup(links, [room], ref); } catch (error) { return (error as { toJSON(): unknown }).toJSON(); } };
    expect(refused([asName], "team room")).toEqual({ code: "bad_request", message: expect.stringMatching(/names a chat .* and a group: use the chat's id or group:<id>/), details: { chat: "chatMallory", groups: [GROUP] } });
    expect(refused([asPrefix], "gggg")).toMatchObject({ code: "bad_request", details: { chat: "chatPrefixName", groups: [GROUP] } });
    expect(findChatOrGroup([asId], [room], GROUP)).toEqual({ group: room });
    // What a command makes of it: never the contact's chat.
    const ctx = { runtime: { server: { node: { getState: () => ({ links: [asName, asId], groups: [room] }) } } } } as unknown as ApiContext;
    expect(() => chatOrGroup(ctx, "Team Room")).toThrow(/and a group/);
    expect(chatOrGroup(ctx, GROUP)).toEqual({ id: GROUP, linkId: `group:${GROUP}`, group: true });
    expect(chatOrGroup(ctx, `group:${GROUP}`)).toEqual({ id: GROUP, linkId: `group:${GROUP}`, group: true });
    // The chat is still reached by its id, and by a label this side gave it.
    expect(chatOrGroup(ctx, "chatMallory")).toEqual({ id: "chatMallory", linkId: "chatMallory", group: false });
    expect(findChatOrGroup([link("chatMine", { label: "Team Room" }), asName], [room], "Team Room")).toEqual({ link: expect.objectContaining({ id: "chatMine" }) });
    // A name no group has is the contact's chat as before; so is one only an invitation has.
    expect(findChatOrGroup([link("chatBob", { peerNick: "Bob" })], [room, { ...room, id: "i".repeat(22), name: "Bob", status: undefined, invitation: {} } as unknown as GroupView], "bob")).toEqual({ link: expect.objectContaining({ id: "chatBob" }) });
    // Neither a chat nor a group: one not_found naming both, and where to look.
    expect(refused([asName], "zed")).toEqual({ code: "not_found", message: 'No chat or group "zed" (ghostly chat list, ghostly group list)' });
    expect(() => chatOrGroup(ctx, "zed")).toThrow('No chat or group "zed" (ghostly chat list, ghostly group list)');
    // An ambiguous name stays what it is, from either side; group:<id> is a group only.
    expect(refused([link("chatA", { label: "Twin" }), link("chatB", { label: "Twin" })], "twin")).toMatchObject({ code: "bad_request", message: expect.stringMatching(/more than one chat/) });
    expect(() => findChatOrGroup([], [room, { ...room, id: "h".repeat(22) } as unknown as GroupView], "team room")).toThrow(/more than one group/);
    expect(refused([asName], "group:zed")).toEqual({ code: "not_found", message: 'No group "group:zed" (ghostly group list)' });
    const KEY = "ybndrfg8ejkmcpqxot1uwisza345h769ybndrfg8ejkmcpqxot1o";
    expect(refused([asName], KEY)).toMatchObject({ code: "not_found", message: `No chat with "${KEY}" (ghostly chat list)` });
    // The same bytes with the last character respelled: no key, and never a name (a contact calling itself that is not found by it).
    const respelled = KEY.slice(0, 51) + "t";
    expect(refused([link("chatMallory", { peerNick: respelled })], respelled)).toMatchObject({ code: "bad_request", message: expect.stringMatching(/not a contact key/) });
    expect(findChatOrGroup([asName], [room], "ggg")).toEqual({ group: room });
  });

  it("a ref shaped as a chat's id is that chat or none: never a contact's own name, a group's name or a group's prefix", () => {
    // The id of a chat removed since, which its contact (and whoever saw its invite) knows.
    const ID = "mkodukaftkmj9cf3";
    const carol = link("jmc8f4ousct61qo8", { label: "c", peerNick: ID });
    const refused = (links: LinkView[], groups: GroupView[], ref: string) => { try { findChatOrGroup(links, groups, ref); } catch (error) { return (error as { toJSON(): unknown }).toJSON(); } };
    for (const ref of [ID, ID.toUpperCase(), ` ${ID}${String.fromCharCode(0x200b)}`]) {
      expect(() => findChat([carol], ref), JSON.stringify(ref)).toThrow(expect.objectContaining({ code: "not_found", message: `No chat ${JSON.stringify(ref)} (ghostly chat list)` }));
      expect(refused([carol], [], ref)).toMatchObject({ code: "not_found", message: `No chat ${JSON.stringify(ref)} (ghostly chat list)` });
      expect(() => findOwnNamedChat([carol], ref)).toThrow(expect.objectContaining({ code: "not_found" }));
    }
    // Nor a group whose admin named it so, or whose id its creator made start so: `group:<ref>` names those.
    const named = { ...group, id: "g".repeat(22), name: ID, status: "active" } as unknown as GroupView;
    const prefixed = { ...group, id: `${ID}gggggg`, name: "Room", status: "active" } as unknown as GroupView;
    expect(refused([], [named], ID)).toMatchObject({ code: "not_found", message: `No chat "${ID}" (ghostly chat list)` });
    expect(refused([], [prefixed], ID)).toMatchObject({ code: "not_found" });
    expect(findChatOrGroup([], [named], `group:${ID}`)).toEqual({ group: named });
    // The chat with that id is that chat; a label given here still names one (only this side chose it).
    const kept = link(ID, { label: "bob" });
    expect(findChat([carol, kept], ID).id).toBe(ID);
    expect(findChatOrGroup([carol, kept], [named], ID)).toEqual({ link: kept });
    const labelled = link("jmc8f4ousct61qo8", { label: ID, peerNick: "Carol" });
    expect(findChat([labelled], ID).id).toBe(labelled.id);
    expect(findChatOrGroup([labelled], [named], ID)).toEqual({ link: labelled });
    // A name of another length, or with a letter no id has (l, v, 0, 2), is a name as before.
    expect(findChat([link("chatNick", { peerNick: "processingqueue" })], "processingqueue").id).toBe("chatNick");
    expect(findChat([link("chatNick", { peerNick: "mkodukaftkmj9cf2" })], "mkodukaftkmj9cf2").id).toBe("chatNick");
  });

  it("an id prefix (the contact may choose it) never takes a label this side gave, nor a group's name", async () => {
    // Mallory's invite code was ground so that the chat this side made from it has an id that starts with Bob's label.
    const bob = link("chatBobxxxxxxxxx", { label: "bob" }), mallory = link("bobpitcapjj8o1wf", { label: "mallory" });
    expect(findChat([mallory, bob], "bob").id).toBe(bob.id);
    expect(findChat([mallory, bob], "BOB").id).toBe(bob.id);
    // A prefix still finds a chat no label names; one that fits a chat and another's own name is refused, with both.
    expect(findChat([mallory, bob], "bobp").id).toBe(mallory.id);
    const nick = link("chatNick", { peerNick: "bobp" });
    expect(() => findChat([mallory, nick], "bobp")).toThrow(expect.objectContaining({ code: "bad_request", details: { matches: [mallory.id, nick.id] } }));
    // A chat or a group (task send, file send...): a group's name beats a chat's prefix, which is refused with both ids.
    const team = { ...group, id: "g".repeat(22), name: "team", status: "active" } as unknown as GroupView;
    const teamChat = link("team9qmhjx8j1equ", { label: "mallory" });
    expect(() => findChatOrGroup([teamChat], [team], "team")).toThrow(expect.objectContaining({ code: "bad_request", details: { chat: teamChat.id, groups: [team.id] } }));
    expect(findChatOrGroup([teamChat, link("chatMine", { label: "team" })], [team], "team")).toEqual({ link: expect.objectContaining({ id: "chatMine" }) });
    // A group's id is its creator's to choose: a prefix never takes a name, among groups this profile is in too; a ref
    // that fits both is refused, with both ids.
    const theirs = { ...team, id: "team" + "x".repeat(18), name: "Mallory's" } as unknown as GroupView;
    expect(() => findGroup([theirs, team], "team")).toThrow(expect.objectContaining({ code: "bad_request", details: { matches: [theirs.id, team.id] } }));
    expect(findGroup([theirs, team], "teamx").id).toBe(theirs.id);
    // listen --from bob: the allowlist holds Bob's chat, never the one whose id starts with "bob"; --group team is refused.
    const ctx = { runtime: { server: { node: { getState: () => ({ links: [mallory, bob], groups: [team, theirs] }) } } } } as unknown as ApiContext;
    await expect(allowlist(["bob"], ["team"], (method, params) => callApi(ctx, method, params), async () => null)).rejects.toMatchObject({ code: "bad_request" });
    const list = await allowlist(["bob"], [team.id], (method, params) => callApi(ctx, method, params), async () => null);
    const event = (chat: string) => ({ seq: 1, id: "e", type: "message.received", at: 1, chat, message: { id: "m", text: "hi", timestamp: 1 } }) as GhostlyEvent;
    expect(await list.allows(event(bob.id))).toBe(true);
    expect(await list.allows(event(mallory.id))).toBe(false);
    expect(await list.allows({ seq: 2, id: "g", type: "group.message", at: 1, group: theirs.id } as GhostlyEvent)).toBe(false);
  });

  it("a group's name (its admin chooses it) never takes another group's id prefix: a ref that fits both is refused", async () => {
    // Mallory, admin of a group this profile is in and a member of Team, renames her group to the start of Team's id.
    const team = { ...group, id: "Tm4q9ZkLx2PdR7sVw0Yb3A", name: "Team", status: "active" } as unknown as GroupView;
    const theirs = { ...group, id: "Qz8uE1hJc5NnFo6Gk2Mt7B", name: "Tm4q9Z", status: "active" } as unknown as GroupView;
    const both = { code: "bad_request", message: expect.stringMatching(/names more than one group: use its id/), details: { matches: expect.arrayContaining([team.id, theirs.id]) } };
    expect(() => findGroup([team, theirs], "Tm4q9Z")).toThrow(expect.objectContaining(both));
    expect(() => findGroup([team, theirs], "tm4q9z")).not.toThrow(/more than one/);
    expect(() => findChatOrGroup([], [team, theirs], "Tm4q9Z")).toThrow(expect.objectContaining(both));
    // Each still by its id, by a ref only one fits, and before the rename the prefix is Team.
    expect(findGroup([team, theirs], team.id).id).toBe(team.id);
    expect(findGroup([team, theirs], theirs.id).id).toBe(theirs.id);
    expect(findGroup([team, theirs], "Tm4q9Zk").id).toBe(team.id);
    expect(findGroup([team, { ...theirs, name: "Book club" } as unknown as GroupView], "Tm4q9Z").id).toBe(team.id);
    // listen --group Tm4q9Z: refused, never Mallory's group in the allowlist.
    const ctx = { runtime: { server: { node: { getState: () => ({ links: [], groups: [team, theirs] }) } } } } as unknown as ApiContext;
    await expect(allowlist([], ["Tm4q9Z"], (method, params) => callApi(ctx, method, params), async () => null)).rejects.toMatchObject(both);
  });

  it("listen --from takes a chat only by its id, its contact's key or a label given here, as call auto on --from", async () => {
    // No chat is labelled "owner" here; Mallory calls herself that. Her chat never wakes the agent.
    const owner = link("chatOwnerxxxxxxx", { peerNick: "Miguel" }), mallory = link("chatMalloryxxxxx", { peerNick: "owner" });
    const ctx = { runtime: { server: { node: { getState: () => ({ links: [owner, mallory], groups: [] }) } } } } as unknown as ApiContext;
    const call = (method: string, params: Record<string, unknown>) => callApi(ctx, method, params);
    await expect(allowlist(["owner"], [], call, async () => null)).rejects.toMatchObject({ code: "bad_request", message: expect.stringMatching(/ghostly chat rename/), details: { chat: mallory.id, name: "owner", contact: mallory.peerPubKeyZ32 } });
    await expect(allowlist(["chatMallory"], [], call, async () => null)).rejects.toMatchObject({ code: "bad_request", details: { chat: mallory.id } });
    // Its id, or the label this side gave it (any case), still names it.
    const event = (chat: string) => ({ seq: 1, id: "e", type: "message.received", at: 1, chat, message: { id: "m", text: "hi", timestamp: 1 } }) as GhostlyEvent;
    expect(await (await allowlist([owner.id], [], call, async () => null)).allows(event(owner.id))).toBe(true);
    const labelled = link(owner.id, { peerNick: "Miguel", label: "Owner" });
    const named = { runtime: { server: { node: { getState: () => ({ links: [labelled, mallory], groups: [] }) } } } } as unknown as ApiContext;
    const list = await allowlist(["owner"], [], (method, params) => callApi(named, method, params), async () => null);
    expect(await list.allows(event(owner.id))).toBe(true);
    expect(await list.allows(event(mallory.id))).toBe(false);
  });

  it("listen --from takes a label given here in every form send and call auto on --from take it (a tab, a trailing space, decomposed accents)", async () => {
    // Stored as `chat rename` stores them: a tab as a space, in NFC. The contact chose no name; Mallory calls herself "owner".
    const ops = link("chatOpsxxxxxxxxx", { label: "ops bot" }), cafe = link("chatCafexxxxxxxx", { label: "Café" }), mallory = link("chatMalloryxxxxx", { peerNick: "owner" });
    const links = [ops, cafe, mallory];
    const ctx = { runtime: { server: { node: { getState: () => ({ links, groups: [] }) } } } } as unknown as ApiContext;
    const call = (method: string, params: Record<string, unknown>) => callApi(ctx, method, params);
    const event = (chat: string) => ({ seq: 1, id: "e", type: "message.received", at: 1, chat, message: { id: "m", text: "hi", timestamp: 1 } }) as GhostlyEvent;
    for (const [ref, chat] of [["ops\tbot", ops], ["Café ", cafe], ["café", cafe]] as const) {
      expect(findChat(links, ref).id).toBe(chat.id);
      expect(findOwnNamedChat(links, ref).id).toBe(chat.id);
      const list = await allowlist([ref], [], call, async () => null);
      expect(await list.allows(event(chat.id))).toBe(true);
      expect(await list.allows(event(mallory.id))).toBe(false);
    }
    // A name only the contact chose is still refused, as before.
    await expect(allowlist(["owner "], [], call, async () => null)).rejects.toMatchObject({ code: "bad_request", message: expect.stringMatching(/ghostly chat rename/), details: { chat: mallory.id, name: "owner", contact: mallory.peerPubKeyZ32 } });
  });

  it("a ref that is one group's name and a prefix of another group's id is refused, with both ids, by every command", async () => {
    // Mine, addressed by a prefix of its id; another member made the second one and named it with that prefix.
    const mine = { ...group, id: "k3x9q2abcdefghijklmnop", name: "Team", status: "active" } as unknown as GroupView;
    const named = { ...group, id: "z".repeat(22), name: "k3x9q2", status: "active" } as unknown as GroupView;
    const groups = [mine, named];
    const refusal = { code: "bad_request", message: '"k3x9q2" names more than one group: use its id', details: { matches: [mine.id, named.id] } };
    const refused = expect.objectContaining(refusal);
    expect(() => findGroup(groups, "k3x9q2")).toThrow(refused);
    expect(() => findChatOrGroup([], groups, "k3x9q2")).toThrow(refused);
    expect(() => findChatOrGroup([], groups, "group:k3x9q2")).toThrow(expect.objectContaining({ ...refusal, message: '"group:k3x9q2" names more than one group: use its id' }));
    // Its id (as is, or group:<id>), a prefix only it fits, and a name only one group has still name it.
    expect(findGroup(groups, mine.id).id).toBe(mine.id);
    expect(findChatOrGroup([], groups, `group:${mine.id}`)).toEqual({ group: mine });
    expect(findGroup(groups, "k3x9q2a").id).toBe(mine.id);
    expect(findGroup(groups, "team").id).toBe(mine.id);
    // What a command makes of it: group send (group.get, as every group command), send, listen --group.
    const node = { getState: () => ({ links: [], groups }), sendGroupMessage: vi.fn(), sendMessage: vi.fn() };
    const ctx = { runtime: { server: { node } } } as unknown as ApiContext;
    const call = (method: string, params: Record<string, unknown>) => callApi(ctx, method, params);
    await expect(call("group.get", { group: "k3x9q2" })).rejects.toMatchObject(refusal);
    expect(() => chatOrGroup(ctx, "k3x9q2")).toThrow(refused);
    await expect(allowlist([], ["k3x9q2"], call, async () => null)).rejects.toMatchObject(refusal);
    const list = await allowlist([], [mine.id], call, async () => null);
    const event = (id: string) => ({ seq: 1, id: "g", type: "group.message", at: 1, group: id } as GhostlyEvent);
    expect(await list.allows(event(mine.id))).toBe(true);
    expect(await list.allows(event(named.id))).toBe(false);
    expect(node.sendGroupMessage).not.toHaveBeenCalled();
  });

  it("\"\" (and \"group:\" alone) names no chat and no group, even where it is a prefix of the only one's id", async () => {
    const bob = link("c7aoaukc3e99dm9c", { peerNick: "Bob" });
    const crew = { ...group, id: "aZT5wUR4UR5s9NsV4KUHZg", status: "active" } as unknown as GroupView;
    for (const ref of ["", " "]) {
      expect(() => findChat([bob], ref)).toThrow(expect.objectContaining({ code: "bad_request", message: `${JSON.stringify(ref)} names no chat` }));
      expect(() => findGroup([crew], ref)).toThrow(expect.objectContaining({ code: "bad_request", message: `${JSON.stringify(ref)} names no group` }));
      expect(() => findChatOrGroup([bob], [crew], ref)).toThrow(expect.objectContaining({ code: "bad_request" }));
    }
    expect(() => findChatOrGroup([bob], [crew], "group:")).toThrow(expect.objectContaining({ code: "bad_request", message: "\"group:\" names no group" }));
    // What a daemon's caller (the API, not the command line) gets: forward never reaches the only chat or group.
    const node = { getState: () => ({ links: [bob], groups: [crew] }), getMessage: vi.fn(async () => msg("m1", 1)), sendMessage: vi.fn(), sendGroupMessage: vi.fn() };
    const ctx = { runtime: { server: { node } }, mode: "daemon" } as unknown as ApiContext;
    for (const to of [[""], ["group:"]]) await expect(callApi(ctx, "chat.forward", { chat: bob.id, messages: ["m1"], to })).rejects.toMatchObject({ code: "bad_request" });
    expect(node.sendMessage).not.toHaveBeenCalled();
    expect(node.sendGroupMessage).not.toHaveBeenCalled();
  });

  it("group:<ref> names a group on every group command and in listen --group, as on the commands that take a chat or a group", async () => {
    const team = { ...group, id: "k3x9q2abcdefghijklmnop", name: "Team", status: "active" } as unknown as GroupView;
    const other = { ...group, id: "z".repeat(22), name: "k3x9q2", status: "active" } as unknown as GroupView;
    const chat = link("chatTeamChat", { label: "Desk" });
    const node = { getState: () => ({ links: [chat], groups: [team, other] }), sendGroupMessage: vi.fn(async () => ({ error: null, messageId: "gm1" })), groupTaken: () => 0, setGroupTyping: vi.fn() };
    const ctx = { runtime: { server: { node } }, mode: "daemon" } as unknown as ApiContext;
    const call = (method: string, params: Record<string, unknown>) => callApi(ctx, method, params);
    // Its id, a prefix only it fits and its name (any case), each as is and after group:, as findChatOrGroup reads them.
    for (const ref of [team.id, "k3x9q2a", "team"]) {
      for (const given of [ref, `group:${ref}`]) {
        expect(findGroup([team, other], given)).toBe(team);
        expect(findChatOrGroup([chat], [team, other], `group:${ref}`)).toEqual({ group: team });
        await expect(call("group.get", { group: given })).resolves.toMatchObject({ id: team.id, name: "Team" });
      }
    }
    // A write: group send goes to that group.
    await expect(call("group.send", { group: `group:${team.id}`, text: "hi" })).resolves.toMatchObject({ group: team.id, messageId: "gm1" });
    expect(node.sendGroupMessage).toHaveBeenCalledWith(expect.objectContaining({ groupId: team.id, text: "hi" }));
    // listen --group: the allowlist lets that group's events through, and only those.
    const event = (id: string) => ({ seq: 1, id: "g", type: "group.message", at: 1, group: id } as GhostlyEvent);
    const list = await allowlist([], [`group:${team.id}`], call, async () => null);
    expect(await list.allows(event(team.id))).toBe(true);
    expect(await list.allows(event(other.id))).toBe(false);
    // What names more than one group, or none, or a chat, is refused as without the prefix (the message echoes the ref as given).
    const both = { code: "bad_request", message: '"group:k3x9q2" names more than one group: use its id', details: { matches: [team.id, other.id] } };
    await expect(call("group.get", { group: "group:k3x9q2" })).rejects.toMatchObject(both);
    await expect(allowlist([], ["group:k3x9q2"], call, async () => null)).rejects.toMatchObject(both);
    await expect(call("group.get", { group: "group:zed" })).rejects.toMatchObject({ code: "not_found", message: 'No group "group:zed" (ghostly group list)' });
    // group:<a chat> is no group: never that chat (without the prefix, the chat's name says it is a chat).
    for (const ref of [chat.id, "desk"]) await expect(call("group.get", { group: `group:${ref}` })).rejects.toMatchObject({ code: "not_found", message: `No group ${JSON.stringify(`group:${ref}`)} (ghostly group list)` });
    await expect(call("group.get", { group: "desk" })).rejects.toMatchObject({ code: "not_found", details: { chat: chat.id } });
    await expect(call("group.get", { group: "group:" })).rejects.toMatchObject({ code: "bad_request", message: '"group:" names no group' });
  });

  it("a command that takes a chat or a group names both when neither has the name", async () => {
    const { ctx } = fake();
    const neither = { code: "not_found", message: 'No chat or group "alcie" (ghostly chat list, ghostly group list)' };
    await expect(callApi(ctx, "chat.pin", { chat: "alcie", message: "m1" })).rejects.toMatchObject(neither);
    await expect(callApi(ctx, "chat.forward", { chat: "alcie", messages: ["m1"], to: ["Alice"] })).rejects.toMatchObject(neither);
    await expect(callApi(ctx, "chat.forward", { chat: "Alice", messages: ["m1"], to: ["alcie"] })).rejects.toMatchObject(neither);
    await expect(callApi(ctx, "task.send", { chat: "alcie", card: { title: "t" } })).rejects.toMatchObject(neither);
  });

  it("a group this profile is in wins over an invitation with its name or id prefix", () => {
    const mine = { ...group, id: "a".repeat(22), name: "Team Room", status: "active" } as unknown as GroupView;
    const invited = (id: string, name: string) => ({ ...group, id, name, status: undefined, invitation: { linkId: "chatMallory" } }) as unknown as GroupView;
    const sameName = invited("c".repeat(22), "Team Room"), samePrefix = invited("aaaa" + "c".repeat(18), "Other");
    expect(findGroup([mine, sameName], "Team Room").id).toBe(mine.id);
    expect(findGroup([sameName, mine, invited("d".repeat(22), "team room")], "team room").id).toBe(mine.id);
    expect(findGroup([mine, samePrefix], "aaaa").id).toBe(mine.id);
    // An invitation is still found: by its id, and by a name or prefix no group of mine has.
    expect(findGroup([mine, sameName], sameName.id).id).toBe(sameName.id);
    expect(findGroup([mine, sameName], "cccc").id).toBe(sameName.id);
    expect(findGroup([mine, samePrefix], "other").id).toBe(samePrefix.id);
    expect(() => findGroup([sameName, invited("d".repeat(22), "Team Room")], "Team Room")).toThrow(/more than one group/);
    expect(() => findGroup([mine, { ...mine, id: "b".repeat(22) } as unknown as GroupView], "Team Room")).toThrow(/more than one group/);
  });

  it("send refuses a seed or ecash unless forced, and reports the message it kept", async () => {
    const { ctx, node } = fake([msg("me_1", 5, { sender: "me", delivery: "sending" })]);
    await expect(callApi(ctx, "chat.send", { chat: "Alice", text: "cashuAeyJ0b2tlbiI6W3sicHJvb2ZzIjpbXX1dfQ" })).rejects.toMatchObject({ code: "confirm" });
    await expect(callApi(ctx, "chat.send", { chat: "Alice", text: "legal winner thank year wave sausage worth useful legal winner thank yellow" })).rejects.toMatchObject({ code: "confirm" });
    // BIP39's Portuguese list, entropy 0x7f repeated: the app's other languages' lists are the guard's too.
    await expect(callApi(ctx, "chat.send", { chat: "Alice", text: "imitador vinheta sogro xerife veleiro pomar volumoso tratador imitador vinheta sogro xingar" })).rejects.toMatchObject({ code: "confirm" });
    // Monero's own Portuguese test seed (tests/unit_tests/mnemonics.cpp): Monero's lists in them too.
    await expect(callApi(ctx, "chat.send", { chat: "Alice", text: "cinzento luxuriante leonardo gnostico digressao cupula fifa broxar iniquo louvor ovario dorsal ideologo besuntar decurso rosto susto lemure unheiro pagodeiro nitroglicerina eclusa mazurca bigorna gnostico" })).rejects.toMatchObject({ code: "confirm" });
    expect(node.sendMessage).not.toHaveBeenCalled();
    expect(await callApi(ctx, "chat.send", { chat: "Alice", text: "hi" })).toEqual({ chat: "chat-one", messageId: "me_1", delivery: "sending" });
    await callApi(ctx, "chat.send", { chat: "Alice", text: "legal winner thank year wave sausage worth useful legal winner thank yellow", force: true });
    expect(node.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("group send says what a refused text looks like, as send does", async () => {
    const { ctx, node } = fake();
    const cashu = "cashuAeyJ0b2tlbiI6W3sicHJvb2ZzIjpbXX1dfQ";
    const seed = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    const cookie = `__cookie__:${"01".repeat(32)}`;
    for (const text of [cashu, seed, cookie]) {
      const said = await callApi(ctx, "chat.send", { chat: "Alice", text }).catch((error: Error) => error.message);
      await expect(callApi(ctx, "group.send", { group: "Crew", text })).rejects.toMatchObject({ code: "confirm", message: said });
    }
    expect(node.sendGroupMessage).not.toHaveBeenCalled();
  });

  it("a text past 16 KiB is a bad request, never handed to the engine, in a chat or a group", async () => {
    const { ctx, node } = fake();
    // 8193 two-byte letters: 16386 bytes. It used to come back as "unavailable", which reads as "try again later".
    const long = "é".repeat(8193);
    await expect(callApi(ctx, "chat.send", { chat: "Alice", text: long })).rejects.toMatchObject({ code: "bad_request", message: expect.stringMatching(/exceeds 16384 UTF-8 bytes/) });
    await expect(callApi(ctx, "group.send", { group: "Crew", text: long })).rejects.toMatchObject({ code: "bad_request" });
    expect(node.sendMessage).not.toHaveBeenCalled();
    expect(node.sendGroupMessage).not.toHaveBeenCalled();
    // Exactly the limit, spaces around it trimmed as the engine does: it goes.
    await callApi(ctx, "chat.send", { chat: "Alice", text: `  ${"é".repeat(8192)}\n` });
    expect(node.sendMessage).toHaveBeenCalledOnce();
  });

  it("an edit past 16 KiB is a bad request as a send is, refused before the secret guard reads it", async () => {
    const { ctx, node } = fake([msg("me_1", 5, { sender: "me" })]);
    const editMessage = vi.fn(async () => ({ error: null, messageId: "me_1" }));
    Object.assign(node, { editMessage });
    // A seed past the limit: the size is said, not the guard's "looks like a secret" (a --force would not send it either).
    const seed = "legal winner thank year wave sausage worth useful legal winner thank yellow ";
    const long = seed + "é".repeat(8193);
    await expect(callApi(ctx, "chat.edit", { chat: "Alice", message: "me_1", text: long })).rejects.toMatchObject({ code: "bad_request", message: expect.stringMatching(/exceeds 16384 UTF-8 bytes/) });
    await expect(callApi(ctx, "group.edit", { group: "Crew", message: "k:0:1", text: long })).rejects.toMatchObject({ code: "bad_request", message: expect.stringMatching(/exceeds 16384 UTF-8 bytes/) });
    // 9 MiB of letters (`edit --stdin`, or the socket): the guard's rune pattern overflowed the stack on it, and the
    // daemon answered `engine` "Maximum call stack size exceeded"; 15 MiB of prose held every other call ~1.7 s.
    const huge = "a".repeat(9 * 1024 * 1024);
    await expect(callApi(ctx, "chat.edit", { chat: "Alice", message: "me_1", text: huge })).rejects.toMatchObject({ code: "bad_request" });
    await expect(callApi(ctx, "group.edit", { group: "Crew", message: "k:0:1", text: huge })).rejects.toMatchObject({ code: "bad_request" });
    expect(editMessage).not.toHaveBeenCalled();
  });

  it("a --timeout out of range is refused before anything is sent, edited or forwarded: a retry never sends it twice", async () => {
    const { ctx, node } = fake([msg("me_1", 5, { sender: "me", delivery: "sending" })]);
    Object.assign(node, { editMessage: vi.fn(async () => ({ error: null, messageId: "me_1" })), forwardMessages: vi.fn(async () => ({ results: [] })) });
    const engine = node as unknown as Record<"sendMessage" | "sendGroupMessage" | "editMessage" | "forwardMessages", ReturnType<typeof vi.fn>>;
    const calls: [string, Record<string, unknown>][] = [
      ["chat.send", { chat: "Alice", text: "hi", wait: "sent" }],
      ["chat.edit", { chat: "Alice", message: "me_1", text: "new", wait: "confirmed" }],
      ["group.send", { group: "Crew", text: "hi", wait: "sent" }],
      ["group.edit", { group: "Crew", message: "k:0:1", text: "new", wait: "sent" }],
      ["chat.forward", { chat: "Alice", messages: ["me_1"], to: ["Bob"], wait: "sent" }],
    ];
    for (const [method, params] of calls) for (const timeout of [0, 99999, ""]) {
      await expect(callApi(ctx, method, { ...params, timeout })).rejects.toMatchObject({ code: "bad_request", message: "timeout must be a number from 1 to 3600" });
    }
    for (const call of ["sendMessage", "sendGroupMessage", "editMessage", "forwardMessages"] as const) expect(engine[call]).not.toHaveBeenCalled();
  });

  // A message to a private group with nobody else in it reaches nobody, not even who joins later: `--wait sent` waited its
  // whole time and said it goes when an edge opens.
  it("group send in a private group with nobody else in it answers at once and says nobody gets it", async () => {
    const alone = { ...group, profile: "mesh", members: [group.members[0]] } as GroupView;
    const node = { getState: () => ({ links: [], groups: [alone] }), sendGroupMessage: vi.fn(async () => ({ error: null, messageId: "mekey:0:0" })), groupTaken: () => 0, setGroupTyping: vi.fn() };
    const ctx = { runtime: { server: { node } }, mode: "one-shot" } as unknown as ApiContext;
    const note = "Nobody else is in this group: nobody gets this message, not even someone who joins later";
    await expect(callApi(ctx, "group.send", { group: "Crew", text: "hi", wait: "sent", timeout: 1 })).resolves.toEqual({ group: "g1", messageId: "mekey:0:0", sent: false, edges: 0, note });
    await expect(callApi(ctx, "group.send", { group: "Crew", text: "hi" })).resolves.toMatchObject({ sent: false, edges: 0, note });
    // Another member: no note, whether an edge took it yet or not.
    const crew = { ...alone, members: group.members } as GroupView;
    Object.assign(node, { getState: () => ({ links: [], groups: [crew] }) });
    expect(await callApi(ctx, "group.send", { group: "Crew", text: "hi" })).not.toHaveProperty("note");
  });

  // The same group's other writes answered `sent: false, edges: 0` at once and said nothing more.
  it("a reaction, edit, pin, removal or forward in a private group with nobody else in it says nobody gets it too", async () => {
    const alone = { ...group, profile: "mesh", members: [group.members[0]] } as GroupView;
    let seq = 0;
    const node = {
      getState: () => ({ links: [], groups: [alone] }), groupTaken: () => 0, setGroupTyping: vi.fn(),
      getMessage: async (linkId: string, id: string) => ({ ...msg(id, 5, { sender: "me" }), linkId, ...(seq ? { edit: { seq, at: 1, history: [] } } : {}) }),
      react: vi.fn(async () => ({ error: null, n: 1 })),
      editMessage: vi.fn(async () => { seq++; return { error: null, messageId: "mekey:0:0" }; }),
      pinMessage: vi.fn(async () => ({ error: null, n: 1 })),
      removeMessage: vi.fn(async () => ({ error: null, e: 1 })),
      forwardMessages: vi.fn(async () => ({ results: [{ messageIds: ["mekey:0:1"], sent: [], error: null }] })),
    };
    const ctx = { runtime: { server: { node } }, mode: "one-shot" } as unknown as ApiContext;
    const nobody = (what: string) => `Nobody else is in this group: nobody gets ${what}, not even someone who joins later`;
    const calls: [string, Record<string, unknown>, string][] = [
      ["group.react", { group: "Crew", message: "mekey:0:0", emoji: "👍" }, "this reaction"],
      ["group.edit", { group: "Crew", message: "mekey:0:0", text: "new", wait: "sent" }, "this edit"],
      ["chat.pin", { chat: "Crew", message: "mekey:0:0" }, "this pin"],
      ["chat.pin", { chat: "Crew", remove: true }, "this unpin"],
      ["chat.delete", { chat: "Crew", message: "mekey:0:0", everyone: true }, "this removal"],
    ];
    for (const [method, params, what] of calls) {
      await expect(callApi(ctx, method, { ...params, timeout: 1 })).resolves.toMatchObject({ sent: false, edges: 0, note: nobody(what) });
    }
    expect(await callApi(ctx, "chat.forward", { chat: "Crew", messages: ["mekey:0:0"], to: ["Crew"], wait: "sent", timeout: 1 }))
      .toMatchObject({ results: [{ kind: "group", edges: 0, note: nobody("this message") }] });
    // Another member: no note.
    Object.assign(node, { getState: () => ({ links: [], groups: [{ ...alone, members: group.members }] }) });
    for (const [method, params] of calls) expect(await callApi(ctx, method, { ...params, wait: "none" })).not.toHaveProperty("note");
    expect((await callApi(ctx, "chat.forward", { chat: "Crew", messages: ["mekey:0:0"], to: ["Crew"], wait: "none" }) as { results: object[] }).results[0]).not.toHaveProperty("note");
  });

  it("typing tells the engine this side writes, or stopped, and says whether the chat is live", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "chat.typing", { chat: "Alice" })).toEqual({ chat: "chat-one", typing: true, kind: "typing", live: false, sendTyping: true });
    expect(node.setTyping).toHaveBeenLastCalledWith({ linkId: "chat-one", typing: true });
    expect(await callApi(ctx, "chat.typing", { chat: "Alice", stop: true })).toMatchObject({ typing: false });
    expect(node.setTyping).toHaveBeenLastCalledWith({ linkId: "chat-one", typing: false });
    await expect(callApi(ctx, "chat.typing", { chat: "zed" })).rejects.toMatchObject({ code: "not_found" });
  });

  // A one-shot opens the profile offline for it (`offlineCall`): it answered `live: false` and exit 0, and the contact saw nothing.
  it("typing in a one-shot without --for says it reached nobody and how to make it reach the contact", async () => {
    const { ctx } = fake();
    Object.assign(ctx, { mode: "one-shot" });
    for (const stop of [false, true]) {
      expect(await callApi(ctx, "chat.typing", { chat: "Alice", stop })).toMatchObject({ live: false, note: expect.stringContaining("reached nobody") });
    }
    Object.assign(ctx, { mode: "daemon" });
    expect(await callApi(ctx, "chat.typing", { chat: "Alice" })).not.toHaveProperty("note");
  });

  // `--for` with `--stop` is refused, so a stop's note offered advice that could not be followed.
  it("a one-shot typing stop's note only gives the daemon advice, in a chat and a group", async () => {
    const { ctx, node } = fake();
    Object.assign(ctx, { mode: "one-shot" });
    const state = node.getState();
    node.getState = () => ({ ...state, groups: [{ ...group, id: "m1", name: "Mesh", profile: "mesh", status: "active" } as unknown as GroupView] });
    expect(await callApi(ctx, "chat.typing", { chat: "Alice" })).toMatchObject({ note: expect.stringContaining("--for") });
    expect(await callApi(ctx, "group.typing", { group: "Mesh" })).toMatchObject({ note: expect.stringContaining("--for") });
    for (const out of [await callApi(ctx, "chat.typing", { chat: "Alice", stop: true }), await callApi(ctx, "group.typing", { group: "Mesh", stop: true })]) {
      expect(out).toMatchObject({ note: expect.stringMatching(/reached nobody.*ghostly daemon --detach/) });
      expect(out).not.toMatchObject({ note: expect.stringContaining("--for") });
    }
  });

  it("group typing says it in a private group, with the same checks, and refuses a community", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "group.typing", { group: "Crew" })).rejects.toMatchObject({ code: "unavailable" });
    const state = node.getState();
    const mesh = { ...group, id: "m1", name: "Mesh", profile: "mesh", status: "active",
      members: [...group.members.slice(0, 2), { ...group.members[2], online: false }] } as unknown as GroupView;
    node.getState = () => ({ ...state, groups: [mesh] });
    expect(await callApi(ctx, "group.typing", { group: "Mesh", kind: "thinking", status: "Reading the\nthread" }))
      .toEqual({ group: "m1", typing: true, kind: "thinking", status: "Reading the thread", reached: 1, sendTyping: true });
    expect(node.setGroupTyping).toHaveBeenLastCalledWith({ groupId: "m1", typing: true, kind: "thinking", status: "Reading the thread" });
    expect(await callApi(ctx, "group.typing", { group: "Mesh", stop: true })).toMatchObject({ typing: false });
    expect(node.setGroupTyping).toHaveBeenLastCalledWith({ groupId: "m1", typing: false });
    await expect(callApi(ctx, "group.typing", { group: "Mesh", status: "see https://x.example" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(callApi(ctx, "group.typing", { group: "Mesh", stop: true, for: 5 })).rejects.toMatchObject({ code: "bad_request" });
    expect(node.setGroupTyping).toHaveBeenCalledTimes(2);
    // Removed from it: refused with the group's reason, as `group send` says it (it was `bad_request`).
    node.getState = () => ({ ...state, groups: [{ ...mesh, status: "removed", statusReason: "You were removed from this group" } as GroupView] });
    await expect(callApi(ctx, "group.typing", { group: "Mesh" })).rejects.toMatchObject({ code: "refused", message: "You were removed from this group" });
    expect(node.setGroupTyping).toHaveBeenCalledTimes(2);
  });

  it("typing says a kind and a bot's status, checked before anything is said", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "chat.typing", { chat: "Alice", kind: "recording" })).toMatchObject({ typing: true, kind: "recording" });
    expect(node.setTyping).toHaveBeenLastCalledWith({ linkId: "chat-one", typing: true, kind: "recording" });
    expect(await callApi(ctx, "chat.typing", { chat: "Alice", kind: "thinking", status: "Transcribing your\naudio…" }))
      .toMatchObject({ typing: true, kind: "thinking", status: "Transcribing your audio…" });
    expect(node.setTyping).toHaveBeenLastCalledWith({ linkId: "chat-one", typing: true, kind: "thinking", status: "Transcribing your audio…" });
    // A status with plain typing is fine too.
    await callApi(ctx, "chat.typing", { chat: "Alice", status: "Reading" });
    expect(node.setTyping).toHaveBeenLastCalledWith({ linkId: "chat-one", typing: true, status: "Reading" });
    node.setTyping.mockClear();
    for (const [params, message] of [
      [{ kind: "dancing" }, "kind must be one of typing, recording, thinking"],
      // Empty (an unset variable in a script) is no kind: never read as plain typing.
      [{ kind: "" }, "kind must be one of typing, recording, thinking"],
      [{ status: "x".repeat(41) }, "status: at most 40 characters"],
      [{ status: "see https://x.example" }, "status: plain text, with no link or markup"],
      [{ status: "<b>hi</b>" }, "status: plain text, with no link or markup"],
      [{ status: "\u202E\u200B" }, "status: plain text, with no link or markup"],
      [{ stop: true, kind: "thinking" }, "kind and status go with a start, not with stop"],
      [{ stop: true, status: "done" }, "kind and status go with a start, not with stop"],
    ] as const) await expect(callApi(ctx, "chat.typing", { chat: "Alice", ...params }), message).rejects.toMatchObject({ code: "bad_request", message });
    expect(node.setTyping).not.toHaveBeenCalled();
    expect(await callApi(ctx, "chat.typing", { chat: "Alice", status: "x".repeat(40) })).toMatchObject({ status: "x".repeat(40) });
  });

  // A one-shot `send` to a chat whose invite nobody took sat its whole 30 s and failed `timeout` (exit 4, which a bot
  // retries: one more copy each time), though the text is kept and goes once the contact joins.
  it("a one-shot's send to a chat nobody joined yet answers at once, waiting for them; a --wait given still waits", async () => {
    vi.useFakeTimers();
    try {
      const stored = [msg("me_1", 5, { sender: "me", delivery: "waiting" })];
      const { ctx, node } = fake(stored);
      Object.assign(ctx, { mode: "one-shot" });
      const state = node.getState();
      node.getState = () => ({ ...state, links: [link("chat-one", { label: "Alice", inviteCode: "ghostly1-code", peerParticipationKey: undefined } as Partial<LinkView>)] }) as EngineState;
      let answer: unknown;
      void callApi(ctx, "chat.send", { chat: "Alice", text: "hi" }).then((a) => { answer = a; });
      await vi.advanceTimersByTimeAsync(10);
      expect(answer).toEqual({ chat: "chat-one", messageId: "me_1", delivery: "waiting", note: "Nobody joined this chat yet: the message goes once they join while this profile is online (`ghostly daemon --detach`)" });
      const given = callApi(ctx, "chat.send", { chat: "Alice", text: "hi", wait: "sent", timeout: 5 }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await given).toMatchObject({ code: "timeout" });
    } finally { vi.useRealTimers(); }
  });

  it("send waits for the delivery it was asked for, and fails with the engine's words", async () => {
    const stored = [msg("me_1", 5, { sender: "me", delivery: "sending" })];
    const { ctx, emit } = fake(stored);
    const sent = callApi(ctx, "chat.send", { chat: "chat-one", text: "hi", wait: "delivered", timeout: 5 });
    await new Promise((r) => setTimeout(r, 10));
    stored[0] = { ...stored[0], delivery: "delivered" };
    emit({ seq: 1, id: "x", type: "message.delivery", at: 1, chat: "chat-one", messageId: "me_1" });
    expect(await sent).toMatchObject({ delivery: "delivered" });

    stored[0] = { ...stored[0], delivery: "failed", deliveryError: "Peer is gone" };
    await expect(callApi(ctx, "chat.send", { chat: "chat-one", text: "hi", wait: "sent" })).rejects.toMatchObject({ code: "engine", message: "Peer is gone" });
    // A send and its wait read the message itself: in a long chat, the whole history costs each of them a read of every row.
    expect((ctx.runtime.server.node as unknown as { getMessages: ReturnType<typeof vi.fn> }).getMessages).not.toHaveBeenCalled();
  });

  // agents#1640: a script's one-shot sends to a contact who is online. A text sent over the live link left at `sent` was
  // taken for unconfirmed as the profile closed, sent again on the DHT at the next start, and that copy held the chat's
  // one DHT text awaiting a receipt: the next send timed out after 30 s, every 5-8 messages.
  it("a one-shot's text sent over the live link waits a moment for its receipt before it leaves", async () => {
    vi.useFakeTimers();
    try {
      const stored = [msg("me_1", 5, { sender: "me", delivery: "sending" })];
      const { ctx, emit } = fake(stored);
      Object.assign(ctx, { mode: "one-shot" });
      const sent = callApi(ctx, "chat.send", { chat: "chat-one", text: "hi", wait: "sent", timeout: 30 });
      await vi.advanceTimersByTimeAsync(10);
      stored[0] = { ...stored[0], delivery: "sent", via: "datalink" };
      emit({ seq: 1, id: "x", type: "message.delivery", at: 1, chat: "chat-one", messageId: "me_1" });
      await vi.advanceTimersByTimeAsync(300);
      let done = false;
      void sent.then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(done, "it does not leave at sent").toBe(false);
      stored[0] = { ...stored[0], delivery: "delivered" };
      emit({ seq: 2, id: "y", type: "message.delivery", at: 2, chat: "chat-one", messageId: "me_1" });
      await vi.advanceTimersByTimeAsync(10);
      expect(await sent).toMatchObject({ delivery: "delivered" });

      // No receipt within ONE_SHOT_RECEIPT_MS: it leaves at sent, as before, with no error.
      stored[0] = { ...stored[0], delivery: "sent", via: "datalink" };
      const late = callApi(ctx, "chat.send", { chat: "chat-one", text: "hi", wait: "sent", timeout: 30 });
      await vi.advanceTimersByTimeAsync(ONE_SHOT_RECEIPT_MS + 100);
      expect(await late).toMatchObject({ delivery: "sent" });

      // A text on the DHT, or a daemon: no wait past sent.
      stored[0] = { ...stored[0], delivery: "sent", via: "pkarr" };
      const dht = callApi(ctx, "chat.send", { chat: "chat-one", text: "hi", wait: "sent", timeout: 30 });
      await vi.advanceTimersByTimeAsync(10);
      expect(await dht).toMatchObject({ delivery: "sent" });
      Object.assign(ctx, { mode: "daemon" });
      stored[0] = { ...stored[0], delivery: "sent", via: "datalink" };
      const daemon = callApi(ctx, "chat.send", { chat: "chat-one", text: "hi", wait: "sent", timeout: 30 });
      await vi.advanceTimersByTimeAsync(10);
      expect(await daemon).toMatchObject({ delivery: "sent" });
    } finally { vi.useRealTimers(); }
  });

  it("a one-shot's timeout says the text goes at the next command, not while a profile it is closing is online", async () => {
    vi.useFakeTimers();
    try {
      const stored = [msg("me_1", 5, { sender: "me", delivery: "queued" })];
      const { ctx } = fake(stored);
      Object.assign(ctx, { mode: "one-shot" });
      const sent = callApi(ctx, "chat.send", { chat: "chat-one", text: "hi", wait: "sent", timeout: 30 }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await sent).toMatchObject({ code: "timeout", message: "Timed out after 30 s: the message is queued and goes with this profile's next command, or keep it online with `ghostly daemon --detach`" });
    } finally { vi.useRealTimers(); }
  });

  it("send's wait sees a delivery that never came as message.delivery, and one that came as the time ran out", async () => {
    vi.useFakeTimers();
    try {
      const stored = [msg("me_1", 5, { sender: "me", delivery: "sending" })];
      const { ctx, emit } = fake(stored);
      // First seen by the event hub already delivered: it says message.sent, not message.delivery.
      const first = callApi(ctx, "chat.send", { chat: "chat-one", text: "hi", wait: "delivered", timeout: 90 });
      await vi.advanceTimersByTimeAsync(10);
      stored[0] = { ...stored[0], delivery: "delivered" };
      emit({ seq: 1, id: "x", type: "message.sent", at: 1, chat: "chat-one", message: { id: "me_1" } });
      await vi.advanceTimersByTimeAsync(10);
      expect(await first).toMatchObject({ delivery: "delivered" });

      // Delivered with no event this side saw: the last look when the time is up says so, not a timeout.
      stored[0] = { ...stored[0], delivery: "sending" };
      const second = callApi(ctx, "chat.send", { chat: "chat-one", text: "hi", wait: "delivered", timeout: 90 });
      await vi.advanceTimersByTimeAsync(89_000);
      stored[0] = { ...stored[0], delivery: "delivered" };
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await second).toMatchObject({ delivery: "delivered" });

      stored[0] = { ...stored[0], delivery: "sending" };
      const third = callApi(ctx, "chat.send", { chat: "chat-one", text: "hi", wait: "delivered", timeout: 90 });
      const failed = expect(third).rejects.toMatchObject({ code: "timeout", details: { delivery: "sending" } });
      await vi.advanceTimersByTimeAsync(90_000);
      await failed;
    } finally {
      vi.useRealTimers();
    }
  });

  it("history pages oldest first, before and after a message or a time", async () => {
    const { ctx } = fake([msg("c", 3), msg("a", 1), msg("b", 2), msg("d", 4)]);
    expect(await callApi(ctx, "chat.history", { chat: "chat-one", limit: 2 })).toMatchObject({ messages: [{ id: "c" }, { id: "d" }], more: true });
    expect(await callApi(ctx, "chat.history", { chat: "chat-one", before: "c" })).toMatchObject({ messages: [{ id: "a" }, { id: "b" }], more: false });
    expect(await callApi(ctx, "chat.history", { chat: "chat-one", after: 1, limit: 2 })).toMatchObject({ messages: [{ id: "b" }, { id: "c" }], more: true });
    await expect(callApi(ctx, "chat.history", { chat: "chat-one", before: "zz" })).rejects.toMatchObject({ code: "not_found" });
    await expect(callApi(ctx, "chat.history", { chat: "chat-one", limit: -1 })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("history after a message or a time reads that page, never the whole history (a bot reading what came since)", async () => {
    // Read whole and cut, each such call cost a daemon 94 ms at 7,000 messages, against 6 ms for the newest page.
    const { ctx, node } = fake([msg("c", 3), msg("a", 1), msg("b", 2), msg("d", 4), msg("e", 5)]);
    expect(await callApi(ctx, "chat.history", { chat: "chat-one", after: "b", limit: 2 })).toMatchObject({ messages: [{ id: "c" }, { id: "d" }], more: true });
    expect(await callApi(ctx, "chat.history", { chat: "chat-one", after: "d" })).toMatchObject({ messages: [{ id: "e" }], more: false });
    expect(await callApi(ctx, "chat.history", { chat: "chat-one", after: 2, before: "e" })).toMatchObject({ messages: [{ id: "c" }, { id: "d" }], more: false });
    expect(await callApi(ctx, "group.history", { group: "g1", after: 0, limit: 1 })).toMatchObject({ more: true });
    expect(node.getMessages).not.toHaveBeenCalled();
    expect(node.messagePage).toHaveBeenCalledWith({ linkId: "chat-one", limit: 2, before: undefined, after: "b" });
    expect(node.messagePage).toHaveBeenCalledWith({ linkId: "group:g1", limit: 1, before: undefined, after: 0 });
  });

  it("a window between two messages it holds that has nothing in it is an empty page, not a message not found", async () => {
    const { ctx } = fake([msg("a", 1), msg("b", 2), msg("c", 3)]);
    const page = (after: unknown, before: unknown) => callApi(ctx, "chat.history", { chat: "chat-one", after, before });
    // `after` was looked up in what `before` had already cut away: "No message b" for a message that is there.
    expect(await page("b", "b")).toEqual({ messages: [], more: false });
    expect(await page("c", "a")).toEqual({ messages: [], more: false });
    expect(await page("b", "c")).toEqual({ messages: [], more: false });
    expect(await page("a", "c")).toMatchObject({ messages: [{ id: "b" }], more: false });
    expect(await page("c", 2)).toEqual({ messages: [], more: false });
    expect(await page(2, "b")).toEqual({ messages: [], more: false });
    // A message that is not there is still said, on either side.
    await expect(page("zz", "c")).rejects.toMatchObject({ code: "not_found", message: 'No message "zz" in this chat (ghostly chat history chat-one)' });
    await expect(page("a", "zz")).rejects.toMatchObject({ code: "not_found", message: 'No message "zz" in this chat (ghostly chat history chat-one)' });
  });

  it("a history limit that is not a whole number is bad_request, not the engine failing", async () => {
    const { ctx } = fake([msg("a", 1), msg("b", 2)]);
    const wrong = { code: "bad_request", message: "limit must be a whole number from 1 to 10000" };
    await expect(callApi(ctx, "chat.history", { chat: "chat-one", limit: 1.5 })).rejects.toMatchObject(wrong);
    await expect(callApi(ctx, "chat.history", { chat: "chat-one", after: 1, limit: 1.5 })).rejects.toMatchObject(wrong);
    await expect(callApi(ctx, "chat.history", { chat: "chat-one", limit: 0 })).rejects.toMatchObject(wrong);
    expect(await callApi(ctx, "chat.history", { chat: "chat-one", limit: 1 })).toMatchObject({ messages: [{ id: "b" }], more: true });
  });

  it("history is in the order messages came here, whatever each sender's clock said, and gives both times", async () => {
    // As the engine stores them: `timestamp` is the row's place (when it came), `sentAt` what the contact's clock said.
    // The contact's clock was two minutes ahead for "b", and days behind for "d".
    const { ctx } = fake([msg("b", 2_000, { sentAt: 122_000 }), msg("a", 1_000, { sender: "me" }), msg("d", 4_000, { sentAt: 4_000 - 3 * 86_400_000 }), msg("c", 3_000, { sender: "me" })]);
    const page = await callApi(ctx, "chat.history", { chat: "chat-one" }) as { messages: { id: string; timestamp: number; sentAt?: number }[] };
    expect(page.messages.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
    expect(page.messages.map((m) => m.sentAt)).toEqual([undefined, 122_000, undefined, 4_000 - 3 * 86_400_000]);
    // A time as a cursor is a place, as `timestamp` is.
    expect(await callApi(ctx, "chat.history", { chat: "chat-one", after: 2_000 })).toMatchObject({ messages: [{ id: "c" }, { id: "d" }] });
    expect(await callApi(ctx, "chat.history", { chat: "chat-one", before: 3_000 })).toMatchObject({ messages: [{ id: "a" }, { id: "b" }] });
  });

  it("history cursors: digits are a time (0 from the start), seconds are refused, anything else is an id", () => {
    for (const name of ["chat history", "group history"]) {
      const command = COMMANDS[name]!;
      const params = (argv: string[]) => command.params!(parseArgs(["c1", ...argv], command.options ?? {}), { chat: "c1", group: "c1" });
      expect(params(["--after", "0"])).toMatchObject({ after: 0 });
      expect(params(["--after", "1000", "--before", "1791849403000"])).toMatchObject({ after: 1000, before: 1791849403000 });
      expect(params(["--before", "me_12"])).toMatchObject({ before: "me_12" });
      expect(() => params(["--before", "1791849403"])).toThrow(expect.objectContaining({ code: "usage", message: "--before takes milliseconds, not seconds: 1791849403000" }));
      expect(() => params(["--after", "1700000000"])).toThrow(/--after takes milliseconds, not seconds: 1700000000000/);
    }
  });

  it("remove needs a yes", async () => {
    const { ctx } = fake();
    await expect(callApi(ctx, "chat.remove", { chat: "chat-one" })).rejects.toMatchObject({ code: "confirm" });
    expect(ctx.calls.forgetChat).not.toHaveBeenCalled();
  });

  // Auto-answer from the chats named kept the removed one: it read as on and could answer nobody.
  it("remove takes the chat out of auto-answer's chats", async () => {
    const { ctx, node } = fake();
    Object.assign(node, { removeLink: vi.fn(async () => undefined), removalsPending: () => [] });
    expect(await callApi(ctx, "chat.remove", { chat: "Alice", yes: true })).toEqual({ removed: "chat-one" });
    expect(ctx.calls.forgetChat).toHaveBeenCalledWith("chat-one");
  });

  // `engine removeLink` took a chat whose delete for everyone had not reached the contact, as `chat remove` no longer does:
  // the contact kept the message for good.
  it("engine removeLink is refused while a delete for everyone is on its way, as chat remove is, until --force", async () => {
    const { ctx, node } = fake();
    const removeLink = vi.fn(async () => undefined);
    Object.assign(node, { removeLink, removalsPending: () => ["m1"] });
    for (const [method, params] of [["chat.remove", { chat: "chat-one", yes: true }], ["engine.call", { method: "removeLink", params: { linkId: "chat-one" }, yes: true }]] as const) {
      await expect(callApi(ctx, method, params)).rejects.toMatchObject({ code: "confirm", message: expect.stringContaining("deleted for everyone"), details: { messages: ["m1"] } });
    }
    expect(removeLink).not.toHaveBeenCalled();
    await callApi(ctx, "engine.call", { method: "removeLink", params: { linkId: "chat-one" }, yes: true, force: true });
    expect(removeLink).toHaveBeenCalledWith({ linkId: "chat-one" });
  });

  // `engine clearProfileData` took every chat's row with the removals still on their way, as `chat remove` no longer does.
  it("engine clearProfileData is refused while a delete for everyone is on its way in any chat, until --force", async () => {
    const { ctx, node } = fake();
    const clearProfileData = vi.fn(async () => undefined);
    Object.assign(node, { clearProfileData, removalsPending: ({ linkId }: { linkId: string }) => (linkId === "chat-two" ? ["m2"] : []) });
    Object.assign(ctx, { mode: "one-shot" });
    await expect(callApi(ctx, "engine.call", { method: "clearProfileData", yes: true })).rejects.toMatchObject({ code: "confirm", message: expect.stringContaining("clearing the profile now"), details: { messages: ["m2"] } });
    expect(clearProfileData).not.toHaveBeenCalled();
    expect(await callApi(ctx, "engine.call", { method: "clearProfileData", yes: true, force: true })).toEqual({ cleared: { chats: 2, groups: 1 } });
    expect(clearProfileData).toHaveBeenCalledOnce();
  });

  // "pass yes (--yes)" put the socket's name first: a person at a terminal types the flag.
  it("each confirm refusal names the flag first, the socket's name after it", async () => {
    const { ctx } = fake();
    for (const [method, params] of [["chat.remove", { chat: "Alice" }], ["group.leave", { group: "g1" }], ["group.forget", { group: "g1" }]] as const) {
      await expect(callApi(ctx, method, params)).rejects.toMatchObject({ code: "confirm", message: expect.stringMatching(/; pass --yes \(yes: true over the socket\) to go on$/) });
    }
  });
});

describe("group leave", () => {
  // Leave deletes the group's history and files here, as forget does: it asked for nothing (issue: no word of it).
  it("needs a yes, as forget does, and the engine is not asked without one", async () => {
    const { ctx, node } = fake();
    const leaveGroup = vi.fn(async () => ({}));
    Object.assign(node, { leaveGroup });
    await expect(callApi(ctx, "group.leave", { group: "g1" })).rejects.toMatchObject({ code: "confirm", message: expect.stringMatching(/history and files on this device; pass --yes \(yes: true over the socket\) to go on/) });
    expect(leaveGroup).not.toHaveBeenCalled();
    expect(await callApi(ctx, "group.leave", { group: "g1", yes: true })).toEqual({ left: "g1" });
    expect(leaveGroup).toHaveBeenCalledWith({ groupId: "g1" });
  });

  // An admin's leave hands the role on: the engine says to whom, and the answer names that member from the roster.
  it("an admin's leave names the member who became the admin", async () => {
    const { ctx, node } = fake();
    Object.assign(node, { leaveGroup: vi.fn(async () => ({ admin: "abce9999yy" })) });
    expect(await callApi(ctx, "group.leave", { group: "g1", yes: true })).toEqual({ left: "g1", admin: { key: "abce9999yy", name: "Bo" } });
  });

  it("the command takes --yes and its help says what goes", () => {
    const command = COMMANDS["group leave"]!;
    expect(command.usage).toBe("group leave <group> --yes");
    expect(command.summary).toMatch(/history and files/);
    expect(command.params!(parseArgs(["g1", "--yes"], command.options ?? {}), { group: "g1" })).toEqual({ group: "g1", yes: true });
    expect(command.params!(parseArgs(["g1"], command.options ?? {}), { group: "g1" })).toEqual({ group: "g1", yes: false });
  });
});

describe("chat wait", () => {
  /** A fake engine whose state a test moves, as the daemon's hub hands each new state on. */
  function moving(first: LinkView) {
    let links = [first];
    const listeners = new Set<(s: EngineState) => void>();
    const stateOf = () => ({ links, groups: [], settings: { online: true } as unknown as Settings, transport: { protocol: "p", relays: [] } }) as unknown as EngineState;
    const ctx = {
      runtime: { server: { node: { getState: stateOf } }, paths: { name: "default" } },
      hub: { onEvent: () => () => {}, onState: (l: (s: EngineState) => void) => { listeners.add(l); return () => listeners.delete(l); }, lastSeq: 0, replay: () => [] },
      mode: "daemon", version: "test",
    } as unknown as ApiContext;
    // As the daemon's hub does (EventHub.setState): a listener that throws is its own business.
    const hand = () => { for (const l of listeners) { try { l(stateOf()); } catch { /* its own */ } } };
    return { ctx, set: (next: LinkView) => { links = [next]; hand(); }, remove: () => { links = []; hand(); } };
  }
  /** Live when the app last ran (its history ends on a live stretch, WISP 100), and no session in this run yet. */
  const remembered = (fields: Partial<LinkView> = {}) => link("chat-one", {
    label: "Alice", dataLink: "idle", pairing: { status: "connecting" }, peerParticipationKey: "peerkey",
    transportHistory: [{ at: 1, kind: "live", transport: "iroh/1" }], ...fields,
  } as Partial<LinkView>);
  const session = { dataLink: "open", pairing: { status: "ready", transport: "iroh/1" }, textDelivery: "stream" } as Partial<LinkView>;

  it("a chat that was live when the daemon last ran is not live until a session exists in this run", () => {
    // Whatever the text path says: no open link and no authenticated session is not live.
    for (const text of ["stream", "dht", "hold", "unavailable"] as const) {
      const chat = remembered({ textDelivery: text });
      expect(isLive(chat), text).toBe(false);
      expect(chatJson(chat), text).toMatchObject({ live: false, transport: null });
    }
    // Each half alone is not a session either: a link open before it authenticated, a pairing with no open link.
    expect(isLive(remembered({ dataLink: "open" }))).toBe(false);
    expect(isLive(remembered({ pairing: { status: "ready", transport: "iroh/1" } } as Partial<LinkView>))).toBe(false);
    expect(isLive(remembered({ dataLink: "open", pairing: { status: "ready" } } as Partial<LinkView>))).toBe(false);
    expect(chatJson(remembered(session))).toMatchObject({ live: true, transport: "iroh/1" });
    // The older protocol has no pairing: its open link is the session.
    expect(isLive(link("old", { profile: undefined, dataLink: "open" }))).toBe(true);
    expect(isLive(link("old", { profile: undefined, dataLink: "idle" }))).toBe(false);
  });

  it("--until live waits for that session, and times out with none", async () => {
    const { ctx, set } = moving(remembered());
    await expect(callApi(ctx, "chat.wait", { chat: "Alice", until: "live", timeout: 1 })).rejects.toMatchObject({ code: "timeout" });
    let done = false;
    const waiting = callApi(ctx, "chat.wait", { chat: "Alice", until: "live", timeout: 30 }).then((view) => { done = true; return view; });
    // The link dialling, then open and not authenticated yet: still waiting.
    set(remembered({ dataLink: "connecting" }));
    set(remembered({ dataLink: "open", pairing: { status: "negotiating" } } as Partial<LinkView>));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    set(remembered(session));
    expect(await waiting).toMatchObject({ id: "chat-one", live: true, transport: "iroh/1", text: "stream" });
    // The status line counts the same chats.
    expect(await callApi(ctx, "status", {})).toMatchObject({ chats: 1, live: 1 });
    set(remembered());
    expect(await callApi(ctx, "status", {})).toMatchObject({ chats: 1, live: 0 });
  });

  it("--until text takes the DHT floor or a hold, and --until paired the contact seen or a session", async () => {
    const { ctx, set } = moving(remembered({ textDelivery: "unavailable" }));
    await expect(callApi(ctx, "chat.wait", { chat: "Alice", until: "text", timeout: 1 })).rejects.toMatchObject({ code: "timeout" });
    set(remembered({ textDelivery: "dht" }));
    expect(await callApi(ctx, "chat.wait", { chat: "Alice", until: "text", timeout: 1 })).toMatchObject({ live: false, text: "dht" });
    // An invite nobody took yet: no contact's key, nothing to answer.
    const invite = { inviteCode: "ghostly1-code", peerParticipationKey: undefined, transportHistory: undefined } as Partial<LinkView>;
    set(remembered({ ...invite, textDelivery: "unavailable" }));
    await expect(callApi(ctx, "chat.wait", { chat: "Alice", until: "paired", timeout: 1 })).rejects.toMatchObject({ code: "timeout" });
    set(remembered({ ...invite, pairingProgress: { stage: "waiting", peerSeen: true } } as Partial<LinkView>));
    expect(await callApi(ctx, "chat.wait", { chat: "Alice", until: "paired", timeout: 1 })).toMatchObject({ live: false });
    set(remembered(session));
    expect(await callApi(ctx, "chat.wait", { chat: "Alice", until: "paired", timeout: 1 })).toMatchObject({ live: true });
  });

  it("--until paired answers at once for a chat paired before, while its contact is away; --until live still waits", async () => {
    // Paired long ago (the contact's key kept), the contact's daemon stopped: the pairing reads `connecting` again,
    // with no pairing in progress, and texts go on the DHT. Paired is a fact of the chat, not of the contact being online.
    const { ctx } = moving(remembered({ textDelivery: "dht" }));
    const from = Date.now();
    expect(await callApi(ctx, "chat.wait", { chat: "Alice", until: "paired", timeout: 5 })).toMatchObject({ id: "chat-one", live: false, text: "dht" });
    expect(Date.now() - from).toBeLessThan(1000);
    await expect(callApi(ctx, "chat.wait", { chat: "Alice", until: "live", timeout: 1 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("a timeout names the state in words that read: text is carried, not been", async () => {
    // It read "waiting for chat chat-one to be text".
    const { ctx } = moving(remembered({ textDelivery: "unavailable" }));
    await expect(callApi(ctx, "chat.wait", { chat: "Alice", until: "text", timeout: 1 })).rejects.toMatchObject({ code: "timeout", message: "Timed out after 1 s waiting for chat chat-one to carry text" });
    await expect(callApi(ctx, "chat.wait", { chat: "Alice", until: "live", timeout: 1 })).rejects.toMatchObject({ code: "timeout", message: "Timed out after 1 s waiting for chat chat-one to be live" });
  });

  it("a chat removed while it is waited for answers not_found at once, not a timeout at the end", async () => {
    // The check's not_found was thrown inside the hub's state listener, which swallows it: the wait went on to its
    // --timeout (up to a day) and answered "Timed out … to be live", exit 4.
    const { ctx, remove } = moving(remembered());
    const from = Date.now();
    const waiting = callApi(ctx, "chat.wait", { chat: "Alice", until: "live", timeout: 5 });
    waiting.catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    remove();
    await expect(waiting).rejects.toMatchObject({ code: "not_found", message: "Chat chat-one was removed" });
    expect(Date.now() - from).toBeLessThan(1000);
  });
});

describe("invite create", () => {
  /** An engine whose new invite is at `progress`; `then` is the progress a later state brings. */
  function inviting(mode: "daemon" | "one-shot", progress: Partial<PairingProgress>) {
    let current = { role: "inviter", since: 0, startedAt: 0, attempt: 1, ...progress } as PairingProgress;
    const listeners = new Set<(s: EngineState) => void>();
    const stateOf = () => ({ links: [link("inv1", { pairingProgress: current })], groups: [] }) as unknown as EngineState;
    const node = { getState: stateOf, createLink: vi.fn(async () => ({ linkId: "inv1", inviteCode: "ghostly1abc" })), setActiveLink: vi.fn() };
    const ctx = {
      runtime: { server: { node }, paths: { name: "default" } },
      hub: { onEvent: () => () => {}, onState: (l: (s: EngineState) => void) => { listeners.add(l); return () => listeners.delete(l); }, lastSeq: 0, replay: () => [] },
      mode, version: "test",
    } as unknown as ApiContext;
    let answer: Record<string, unknown> | undefined;
    void callApi(ctx, "invite.create", {}).then((a) => { answer = a as Record<string, unknown>; });
    return { answer: () => answer, then: (next: Partial<PairingProgress>) => { current = { ...current, ...next }; for (const l of listeners) l(stateOf()); } };
  }

  beforeEach(() => { vi.useFakeTimers({ now: 1_000_000 }); });
  afterEach(() => { vi.useRealTimers(); });

  it("a daemon answers at once when the relays' request budget holds the invite back, and says when it goes", async () => {
    const held = inviting("daemon", { stage: "publishing", relayWaitUntil: 1_042_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(held.answer()).toEqual({ chat: "inv1", invite: "ghostly1abc", link: expect.stringContaining("ghostly1abc"), published: false, retryInMs: 42_000, note: expect.stringContaining("once a relay answers") });

    // Published first: so it says, with no wait.
    const out = inviting("daemon", { stage: "publishing" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(out.answer()).toBeUndefined();
    out.then({ stage: "waiting" });
    await vi.advanceTimersByTimeAsync(0);
    expect(out.answer()).toMatchObject({ published: true });
    expect(out.answer()).not.toHaveProperty("retryInMs");
    expect(out.answer()).not.toHaveProperty("reason");
    expect(out.answer()).not.toHaveProperty("note");
  });

  it("says why when no relay took the invite, and that the invite still goes out", async () => {
    const failed = inviting("daemon", { stage: "failed", reason: "publish", retryable: true, detail: "Publish failed on every relay: Error: https://a.test did not answer a moment ago; retry shortly" });
    await vi.advanceTimersByTimeAsync(0);
    expect(failed.answer()).toEqual({
      chat: "inv1", invite: "ghostly1abc", link: expect.stringContaining("ghostly1abc"), published: false,
      reason: "No relay answered (a.test): it goes out once one does",
      note: "The invite is good: it goes out by itself once a relay answers, while a daemon runs for this profile",
    });
  });

  /** The engine's words read "Publish failed on every relay: Error: … retry shortly": a class name per relay, beside a note that says the invite is good. */
  it.each([
    ["one relay", "Publish failed on every relay: Error: http://127.0.0.1:9 did not answer", "No relay answered (127.0.0.1:9): it goes out once one does"],
    ["two relays", "Publish failed on every relay: Error: http://127.0.0.1:9 did not answer a moment ago; retry shortly; Error: http://127.0.0.1:7 did not answer a moment ago; retry shortly",
      "No relay answered (127.0.0.1:9, 127.0.0.1:7): it goes out once one does"],
    ["a relay that answered with an error", "Publish failed on every relay: Error: https://a.test responded 503; Error: https://b.test is left alone after failing; asked again in 12 s",
      "No relay took the invite (a.test, b.test): it goes out once one does"],
  ])("says plainly which relays did not take it: %s", async (_, detail, reason) => {
    const failed = inviting("daemon", { stage: "failed", reason: "publish", retryable: true, detail });
    await vi.advanceTimersByTimeAsync(0);
    expect(failed.answer()).toMatchObject({ published: false, reason });
  });

  it("a one-shot still waits for the invite to go out before it leaves, and says when it did not", async () => {
    const held = inviting("one-shot", { stage: "publishing", relayWaitUntil: 1_042_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(held.answer()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(held.answer()).toMatchObject({ published: false, retryInMs: 22_000 });
  });
});

describe("the chat on screen of a daemon", () => {
  /** A daemon whose invites are `inv1`, `inv2`…, and `join` the chats it joins; `pair` pairs one, `drop` deletes one. */
  function daemon() {
    let links: LinkView[] = [];
    const listeners = new Set<(s: EngineState) => void>();
    const stateOf = () => ({ links, groups: [] }) as unknown as EngineState;
    const push = () => { for (const l of [...listeners]) l(stateOf()); };
    let n = 0;
    const node = {
      getState: stateOf, setActiveLink: vi.fn(), renameLink: vi.fn(),
      createLink: vi.fn(async () => { const linkId = `inv${++n}`; links = [...links, link(linkId, { pairingProgress: { stage: "waiting" } } as Partial<LinkView>)]; return { linkId, inviteCode: "ghostly1" + linkId }; }),
      joinLink: vi.fn(async () => { links = [...links, link("join")]; return { linkId: "join" }; }),
    };
    const ctx = {
      runtime: { server: { node }, paths: { name: "default" } },
      hub: { onEvent: () => () => {}, onState: (l: (s: EngineState) => void) => { listeners.add(l); return () => listeners.delete(l); }, lastSeq: 0, replay: () => [] },
      mode: "daemon", version: "test",
    } as unknown as ApiContext;
    return {
      ctx, node, listeners,
      pair: (id: string) => { links = links.map((l) => l.id === id ? { ...l, peerParticipationKey: "peer-" + id } : l); push(); },
      drop: (id: string) => { links = links.filter((l) => l.id !== id); push(); },
      shown: () => node.setActiveLink.mock.calls.map(([p]) => p.linkId),
    };
  }

  it("an invite is the chat on screen until it is paired, then none is: an away contact is read at the background pace", async () => {
    const d = daemon();
    await callApi(d.ctx, "invite.create", {});
    expect(d.shown()).toEqual(["inv1"]);
    d.pair("inv1");
    expect(d.shown()).toEqual(["inv1", null]);
    // Nothing more to watch, and later states change nothing.
    expect(d.listeners.size).toBe(0);
    d.pair("inv1");
    expect(d.shown()).toEqual(["inv1", null]);

    // The joiner's side the same, and a chat deleted before it paired too; a state from before the chat was made, not.
    await callApi(d.ctx, "invite.join", { invite: "ghostly1abc" });
    d.pair("join");
    await callApi(d.ctx, "invite.create", {});
    for (const l of [...d.listeners]) l({ links: [], groups: [] } as unknown as EngineState);
    expect(d.shown()).toEqual(["inv1", null, "join", null, "inv2"]);
    d.pair("inv1");
    d.drop("inv2");
    expect(d.shown()).toEqual(["inv1", null, "join", null, "inv2", null]);
    expect(d.listeners.size).toBe(0);
  });

  it("a newer invite keeps the mark when an older one pairs, and a chat someone chose stays on screen", async () => {
    const d = daemon();
    await callApi(d.ctx, "invite.create", {});
    await callApi(d.ctx, "invite.create", {});
    d.pair("inv1");
    expect(d.shown()).toEqual(["inv1", "inv2"]);
    expect(d.listeners.size).toBe(1);

    await callApi(d.ctx, "engine.call", { method: "setActiveLink", params: { linkId: "inv2" } });
    d.pair("inv2");
    expect(d.shown()).toEqual(["inv1", "inv2", "inv2"]);
    expect(d.listeners.size).toBe(0);
  });
  it("an invite nobody joins leaves the screen once its wait for a peer is over, and a newer invite keeps its own wait", async () => {
    vi.useFakeTimers();
    try {
      const d = daemon();
      await callApi(d.ctx, "invite.create", {});
      await vi.advanceTimersByTimeAsync(AWAITING_PEER_MS - 60_000);
      // A newer invite takes the mark with a wait of its own: the older one's end does not clear it.
      await callApi(d.ctx, "invite.create", {});
      await vi.advanceTimersByTimeAsync(60_000);
      expect(d.shown()).toEqual(["inv1", "inv2"]);
      await vi.advanceTimersByTimeAsync(AWAITING_PEER_MS - 60_000);
      expect(d.shown()).toEqual(["inv1", "inv2", null]);
      expect(d.listeners.size).toBe(0);
      // Paired late, it is not marked again.
      d.pair("inv2");
      expect(d.shown()).toEqual(["inv1", "inv2", null]);

      // One paired in time leaves no timer behind that clears a chat someone chose later.
      await callApi(d.ctx, "invite.create", {});
      d.pair("inv3");
      await callApi(d.ctx, "engine.call", { method: "setActiveLink", params: { linkId: "inv1" } });
      await vi.advanceTimersByTimeAsync(AWAITING_PEER_MS);
      expect(d.shown()).toEqual(["inv1", "inv2", null, "inv3", null, "inv1"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the engine passthrough", () => {
  it("reaches only the app's calls", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "engine.call", { method: "storeMessage", params: {} })).rejects.toMatchObject({ code: "not_found" });
    expect(node.storeMessage).not.toHaveBeenCalled();
    expect(await callApi(ctx, "engine.call", { method: "walletCreate", params: { type: "cashu" } })).toEqual({ id: "w" });
  });

  it("refuses Hide my IP from contacts (relayOnly) until the release that shows it", async () => {
    const { ctx, node } = fake();
    const updateSettings = vi.fn(async () => undefined);
    Object.assign(node, { updateSettings });
    for (const relayOnly of [true, "yes", null]) {
      await expect(callApi(ctx, "engine.call", { method: "updateSettings", params: { settings: { relayOnly } } })).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining("relayOnly") });
    }
    await expect(callApi(ctx, "settings.set", { relayOnly: true })).rejects.toMatchObject({ code: "bad_request" });
    expect(updateSettings).not.toHaveBeenCalled();
    await callApi(ctx, "engine.call", { method: "updateSettings", params: { settings: { sendTyping: false } } });
    expect(updateSettings).toHaveBeenCalledWith({ settings: { sendTyping: false } });
  });

  // A profile an older CLI (or a dev build) turned it on in kept it for good: false was refused too, and while it is on
  // the TURN server it needs cannot be taken away either.
  it("still turns Hide my IP from contacts off on a profile that has it on", async () => {
    const { ctx, node } = fake();
    const updateSettings = vi.fn(async () => undefined);
    Object.assign(node, { updateSettings });
    await callApi(ctx, "engine.call", { method: "updateSettings", params: { settings: { relayOnly: false } } });
    expect(updateSettings).toHaveBeenCalledWith({ settings: { relayOnly: false } });
  });

  it("refuses a real-money confirmation it was not given", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "engine.call", { method: "payRequest", params: { linkId: "x", paymentId: "y", confirmedReal: true } })).rejects.toMatchObject({ code: "confirm" });
    expect(node.payRequest).not.toHaveBeenCalled();
    await callApi(ctx, "engine.call", { method: "payRequest", params: { linkId: "x", paymentId: "y", confirmedReal: true }, confirmReal: true });
    expect(node.payRequest).toHaveBeenCalledWith({ linkId: "x", paymentId: "y", confirmedReal: true });
  });

  it("a call that deletes chats or groups asks for yes, as the commands made for it do", async () => {
    const { ctx, node } = fake();
    const calls = { clearProfileData: vi.fn(), removeLink: vi.fn(), leaveGroup: vi.fn(async () => ({})), forgetGroup: vi.fn(), deviceRemove: vi.fn() };
    Object.assign(node, calls, { removalsPending: () => [] });
    for (const [method, call] of Object.entries(calls)) {
      await expect(callApi(ctx, "engine.call", { method, params: {} }), method).rejects.toMatchObject({ code: "confirm", message: expect.stringContaining("--yes") });
      expect(call, method).not.toHaveBeenCalled();
    }
    expect(ctx.calls.forgetChat).not.toHaveBeenCalled();
    await callApi(ctx, "engine.call", { method: "removeLink", params: { linkId: "chat-one" }, yes: true });
    expect(calls.removeLink).toHaveBeenCalledWith({ linkId: "chat-one" });
    expect(ctx.calls.forgetChat).toHaveBeenCalledWith("chat-one");
  });

  it("clearProfileData says what it removed, and a daemon stops instead of serving the engine it shut down", async () => {
    const { ctx, node } = fake();
    const stop = vi.fn();
    Object.assign(node, { clearProfileData: vi.fn(async () => undefined), removalsPending: () => [] });
    Object.assign(ctx, { stop });
    vi.useFakeTimers();
    try {
      expect(await callApi(ctx, "engine.call", { method: "clearProfileData", yes: true })).toEqual({ cleared: { chats: 2, groups: 1 }, stopped: true });
      // Answered first, then stopped (as daemon.stop does).
      expect(stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10);
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
    Object.assign(ctx, { mode: "one-shot", stop: undefined });
    expect(await callApi(ctx, "engine.call", { method: "clearProfileData", yes: true })).toEqual({ cleared: { chats: 2, groups: 1 } });
  });

  it("refuses a call given less than it takes, or a value of the wrong kind, naming what it takes", async () => {
    const { ctx, node } = fake();
    // As the engine's own: JavaScript's TypeError on what is not there, or nothing done for a chat it does not find.
    const renameLink = vi.fn(async ({ linkId, label }: { linkId?: string; label?: string }) => { if (linkId) label!.trim(); });
    const updateSettings = vi.fn(async ({ settings }: { settings: { nostr?: unknown } }) => { void settings.nostr; });
    const lnurlResolve = vi.fn(async () => { throw new TypeError("fetch failed"); });
    Object.assign(node, { renameLink, updateSettings, lnurlResolve });
    const call = (method: string, params?: unknown) => callApi(ctx, "engine.call", { method, params }).then(() => null, asCliError);
    const takes = (method: string, why: string) => ({ code: "bad_request", message: `${method} takes ${ENGINE_PARAMS[method]}: ${why} (ghostly engine --list --verbose)` });
    expect(await call("renameLink")).toMatchObject(takes("renameLink", "no parameters given"));
    expect(await call("renameLink", {})).toMatchObject(takes("renameLink", "linkId, label missing"));
    expect(await call("renameLink", { linkId: "c" })).toMatchObject(takes("renameLink", "label missing"));
    expect(await call("updateSettings", { nick: "x" })).toMatchObject(takes("updateSettings", "settings missing"));
    expect(renameLink).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
    // A number for the text: the engine's words behind it.
    expect((await call("renameLink", { linkId: "c", label: 5 }))?.toJSON()).toEqual({
      ...takes("renameLink", "a parameter of the wrong kind"), details: { takes: "{ linkId, label }", rawError: "label.trim is not a function" },
    });
    expect(await call("renameLink", { linkId: "c", label: "x" })).toBeNull();
    // The network failing is not the caller's parameters.
    expect(await call("lnurlResolve", { text: "a@b.c" })).toMatchObject({ code: "engine", message: "fetch failed" });
  });

  it("runs send's secret guard on the calls that send a text: a seed, a key or ecash goes only with force", async () => {
    const seed = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    const { ctx, node } = fake([msg("m_seed", 5, { text: seed }), msg("m_hi", 6, { text: "hi" })]);
    Object.assign(node, { editMessage: vi.fn(async () => ({ error: null, messageId: "me_1" })), forwardMessages: vi.fn(async () => ({ results: [] })) });
    const engine = node as unknown as Record<"sendMessage" | "sendGroupMessage" | "editMessage" | "forwardMessages", ReturnType<typeof vi.fn>>;
    const calls: [keyof typeof engine, Record<string, unknown>][] = [
      ["sendMessage", { linkId: "chat-one", text: seed }],
      ["sendMessage", { linkId: "chat-one", text: "cashuAeyJ0b2tlbiI6W3sicHJvb2ZzIjpbXX1dfQ" }],
      ["sendMessage", { linkId: "chat-one", text: "", card: { kind: "task", id: "t", title: "x", step: seed } }],
      ["sendGroupMessage", { groupId: "g", text: seed }],
      ["sendGroupMessage", { groupId: "g", text: "", card: { kind: "task", id: "t", title: seed } }],
      ["editMessage", { linkId: "chat-one", messageId: "me_1", text: seed }],
      ["forwardMessages", { linkId: "chat-one", messageIds: ["m_hi", "m_seed"], to: ["chat-two"] }],
    ];
    for (const [method, params] of calls) {
      await expect(callApi(ctx, "engine.call", { method, params }), method).rejects.toMatchObject({ code: "confirm" });
    }
    for (const call of ["sendMessage", "sendGroupMessage", "editMessage", "forwardMessages"] as const) expect(engine[call]).not.toHaveBeenCalled();
    // A plain text goes as it did; with force, the secret goes too.
    await callApi(ctx, "engine.call", { method: "sendMessage", params: { linkId: "chat-one", text: "hi" } });
    await callApi(ctx, "engine.call", { method: "forwardMessages", params: { linkId: "chat-one", messageIds: ["m_hi"], to: ["chat-two"] } });
    for (const [method, params] of calls) await callApi(ctx, "engine.call", { method, params, force: true });
    expect(engine.sendMessage).toHaveBeenCalledTimes(4);
    expect(engine.sendGroupMessage).toHaveBeenCalledTimes(2);
    expect(engine.editMessage).toHaveBeenCalledOnce();
    expect(engine.forwardMessages).toHaveBeenCalledTimes(2);
  });
});

describe("groups", () => {
  it("mentions are members written as @name in the text, in code points", () => {
    expect(mentionsFor("hi @Ana and 👋 @bo", ["Ana", "abce"], group)).toEqual([{ k: "abcd1234zz", o: 3, l: 4 }, { k: "abce9999yy", o: 14, l: 3 }]);
    expect(mentionsFor("@everyone look", ["everyone"], group)).toEqual([{ k: "*", o: 0, l: 9 }]);
    expect(() => mentionsFor("hi", ["Ana"], group)).toThrow(/Write @Ana/);
    expect(() => mentionsFor("@abc hi", ["abc"], group)).toThrow(/more than one/);
    expect(() => mentionsFor("@x", ["nobody"], group)).toThrow(/No member/);
    // This profile's own key was "No member" too.
    expect(() => mentionsFor("@mekey hi", ["mekey"], group)).toThrow(expect.objectContaining({ code: "bad_request", message: '"mekey" is you: name another member of Crew' }));
  });

  it("send passes the mentions to the engine", async () => {
    const { ctx, node } = fake();
    await callApi(ctx, "group.send", { group: "Crew", text: "@Ana ping", mentions: ["Ana"] });
    expect(node.sendGroupMessage).toHaveBeenCalledWith({ groupId: "g1", text: "@Ana ping", mentions: [{ k: "abcd1234zz", o: 0, l: 4 }] });
  });
});

describe("chat show names who keeps a chat on DHT only", () => {
  it("says the contact's delivery mode beside this side's, null before the contact told it", () => {
    const peerDht = link("c", { deliveryMode: "stream", textDelivery: "dht", dhtDelivery: { mode: "stream", peerMode: "dht", authenticated: true, maxTextBytes: 256 } });
    expect(chatDetailsJson(peerDht)).toMatchObject({ live: false, deliveryMode: "stream", peerDeliveryMode: "dht" });
    expect(chatDetailsJson(link("c", { deliveryMode: "dht", dhtDelivery: { mode: "dht", peerMode: "stream", authenticated: true, maxTextBytes: 256 } }))).toMatchObject({ deliveryMode: "dht", peerDeliveryMode: "stream" });
    expect(chatDetailsJson(link("c"))).toMatchObject({ peerDeliveryMode: null });
  });
});

describe("a pending chat's invite code is a secret", () => {
  const CODE = "ghostly1pendingsecret";
  const pending = () => {
    const made = fake();
    const state = made.node.getState();
    made.node.getState = () => ({ ...state, links: [link("chat-zero"), link("chat-one", { label: "Alice", inviteCode: CODE, pairing: { status: "waiting" } } as never), link("chat-two", { peerNick: "Bob", inviteCode: CODE, pairing: { status: "ready" } } as never)] });
    return { ...made, node: { ...made.node, renameLink: vi.fn(async () => undefined), connect: vi.fn(async () => undefined), disconnect: vi.fn(), setChatTransport: vi.fn(async () => undefined) } };
  };

  it("is hidden in every chat summary unless asked for, and only list and show take the asking", async () => {
    const made = pending();
    const ctx = { ...made.ctx, runtime: { server: { node: made.node }, paths: { name: "default" } }, calls: { list: () => [] } } as unknown as ApiContext;
    expect(chatJson(link("c", { inviteCode: CODE } as never), true).invite).toBe(CODE);
    expect(chatJson(link("c")).invite).toBeNull();
    // Array.map hands the index as the second argument: it must never read as "show".
    expect(JSON.stringify([link("a"), link("b", { inviteCode: CODE } as never)].map(chatJson as never))).not.toContain(CODE);
    for (const [method, params] of [["chat.get", {}], ["chat.rename", { name: "Alice" }], ["chat.transport", { transport: "dht" }], ["chat.wait", { until: "text", timeout: 1 }]] as const) {
      const hidden = await callApi(ctx, method, { chat: "chat-one", ...params });
      expect(JSON.stringify(hidden), method).not.toContain(CODE);
      expect(hidden, method).toMatchObject({ invite: "<hidden>" });
    }
    // Nobody took the invite: connect and disconnect say so at once, without the code.
    for (const method of ["chat.connect", "chat.disconnect"] as const) {
      const refused = await callApi(ctx, method, { chat: "chat-one" }).catch((error: unknown) => error as Error);
      expect(refused, method).toMatchObject({ code: "unavailable" });
      expect(JSON.stringify(refused) + (refused as Error).message, method).not.toContain(CODE);
    }
    const listed = await callApi(ctx, "chat.list", {}) as { chats: { id: string; invite: string | null }[] };
    expect(JSON.stringify(listed)).not.toContain(CODE);
    expect(Object.fromEntries(listed.chats.map((c) => [c.id, c.invite]))).toEqual({ "chat-zero": null, "chat-one": "<hidden>", "chat-two": null });
    expect(await callApi(ctx, "chat.get", { chat: "chat-one", showSecret: true })).toMatchObject({ invite: CODE });
    expect((await callApi(ctx, "chat.list", { showSecret: true }) as typeof listed).chats.find((c) => c.id === "chat-one")).toMatchObject({ invite: CODE });
    // Paired: the code opens nothing any more, and is not printed either way.
    expect(await callApi(ctx, "chat.get", { chat: "chat-two", showSecret: true })).toMatchObject({ invite: null });
    expect(JSON.stringify(await callApi(ctx, "chat.rename", { chat: "chat-one", name: "Alice", showSecret: true }))).not.toContain(CODE);
  });

  it("chat list and chat show ask with --show-secret; engine getState hides it too", () => {
    const flag = { "show-secret": { type: "boolean" as const, description: "" } };
    expect(COMMANDS["chat list"].params!(parseArgs([], flag), {})).toEqual({});
    expect(COMMANDS["chat list"].params!(parseArgs(["--show-secret"], flag), {})).toEqual({ showSecret: true });
    expect(COMMANDS["chat show"].params!(parseArgs(["Alice"], flag), { chat: "Alice" })).toEqual({ chat: "Alice" });
    expect(COMMANDS["chat show"].params!(parseArgs(["Alice", "--show-secret"], flag), { chat: "Alice" })).toEqual({ chat: "Alice", showSecret: true });
    const printed = hideStateSecrets({ ...pending().node.getState(), groups: [{ ...group, entryLink: "ghostly-link" }] });
    expect(JSON.stringify(printed)).not.toMatch(/ghostly1pendingsecret|ghostly-link|"SK"/);
    expect(printed.links.map((l) => l.inviteCode)).toEqual([undefined, "<hidden>", "<hidden>"]);
    expect(printed.groups[0]).toMatchObject({ entryLink: "<hidden>" });
  });

  it("engine getState hides another group's link under a held id and the wake-up tokens", () => {
    const state = pending().node.getState();
    const full = { ...state,
      links: state.links.map((l, i) => (i === 0 ? { ...l, wakeToken: "wake-chat" } : l)),
      groups: [{ ...group, wakeTokens: ["wake-group"], others: [{ link: "group1/g/entry-key" }, { linkId: "chat-zero", name: "Other", members: 2 }] }] };
    const printed = hideStateSecrets(full);
    expect(JSON.stringify(printed)).not.toMatch(/entry-key|wake-chat|wake-group/);
    expect(printed.groups[0]).toMatchObject({ wakeTokens: ["<hidden>"], others: [{ link: "<hidden>" }, { linkId: "chat-zero", name: "Other", members: 2 }] });
    expect(printed.links[0]).toMatchObject({ wakeToken: "<hidden>" });
    // With --show-secret the state is printed as the engine gave it.
    expect(JSON.stringify(full)).toMatch(/entry-key.*wake-group|wake-group.*entry-key/);
  });
});

// A chat or a group with no message yet answered `lastMessageAt: 0` (1970), where every other time not reached yet is null.
describe("lastMessageAt", () => {
  it("is null for a chat or a group with no message yet, which list after those with one", async () => {
    const { ctx, node } = fake();
    const state = node.getState();
    node.getState = () => ({ ...state,
      links: [link("chat-new", { createdAt: 5, inviteCode: "ghostly1x", pairing: { status: "waiting" } } as never), link("chat-old", { createdAt: 2, lastMessageAt: 40 }), link("chat-newer", { createdAt: 9 })],
      groups: [{ ...group, id: "g-new" }, { ...group, id: "g-old", lastMessageAt: 40 }] });
    const chats = (await callApi(ctx, "chat.list", {}) as { chats: { id: string; lastMessageAt: number | null }[] }).chats;
    expect(chats.map((c) => [c.id, c.lastMessageAt])).toEqual([["chat-old", 40], ["chat-newer", null], ["chat-new", null]]);
    expect(await callApi(ctx, "chat.get", { chat: "chat-new" })).toMatchObject({ lastMessageAt: null, liveSince: null, peerLastSeenAt: null });
    const groups = (await callApi(ctx, "group.list", {}) as { groups: { id: string; lastMessageAt: number | null }[] }).groups;
    expect(groups.map((g) => [g.id, g.lastMessageAt])).toEqual([["g-old", 40], ["g-new", null]]);
    expect(await callApi(ctx, "group.get", { group: "g-new" })).toMatchObject({ lastMessageAt: null });
  });
});

describe("settings", () => {
  it("hide credentials unless asked, and change only what the CLI manages", async () => {
    const { ctx, node } = fake();
    const shown = await callApi(ctx, "settings.get", {}) as Record<string, unknown>;
    expect(JSON.stringify(shown)).not.toContain("SK");
    expect(shown).toMatchObject({ avatar: "<set>", holdStorage: { s3: { accessKeyId: "AK", secretAccessKey: "<hidden>" } } });
    expect(JSON.stringify(redactSettings({ holdStorage: { s3: { secretAccessKey: "SK" } } } as unknown as Settings, true))).toContain("SK");
    const capabilities = redactSettings({ wake: { endpoint: "https://fcm.googleapis.com/x", p256dh: "P", auth: "AUTH", vapid: { publicKey: "VP", privateKey: "VK" } }, holdStorage: { s3: {}, space: "SPACE" } } as unknown as Settings);
    expect(capabilities).toMatchObject({ wake: "<set>", holdStorage: { space: "<hidden>" } });
    expect(JSON.stringify(capabilities)).not.toMatch(/fcm|AUTH|VK|SPACE/);
    await expect(callApi(ctx, "settings.set", { mints: [] })).rejects.toMatchObject({ code: "bad_request" });
    await expect(callApi(ctx, "settings.set", { relays: "x" })).rejects.toMatchObject({ code: "bad_request" });
    await callApi(ctx, "settings.set", { relays: ["http://127.0.0.1:1"] });
    expect(node.updateSettings).toHaveBeenCalledWith({ settings: { relays: ["http://127.0.0.1:1"] } });
    // readRelays (the app's "Also use Pkarr relays") is refused with the reason: the CLI reads the relays first anyway.
    node.updateSettings.mockClear();
    for (const value of [false, true])
      await expect(callApi(ctx, "settings.set", { readRelays: value })).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining("reads the Pkarr relays first") });
    expect(node.updateSettings).not.toHaveBeenCalled();
    // ICE servers in WebRTC's form (urls a list) are taken; one without urls is a bad_request that says what to write.
    await callApi(ctx, "settings.set", { iceServers: [{ urls: ["stun:stun.example.org:3478", "stun:b.example.org"] }] });
    expect(node.updateSettings).toHaveBeenLastCalledWith({ settings: { iceServers: [{ urls: "stun:stun.example.org:3478, stun:b.example.org" }] } });
    for (const server of [{}, { url: "stun:stun.example.org" }])
      await expect(callApi(ctx, "settings.set", { iceServers: [server] })).rejects.toMatchObject({ code: "bad_request", message: "iceServers: Each ICE server needs urls: one address, or several comma-separated (turn:host:port)" });
    await expect(callApi(ctx, "settings.set", { iceServers: [{ urls: "turn:t.example.org:3478" }] })).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining("username and credential") });
  });

  it("say a relay address the engine refuses as a wrong value, named by its key, in a terminal's words", async () => {
    // Each was `engine` (exit 1), in the app's words ("Enter at least one relay address").
    const { ctx, node } = fake();
    const refusals: [Record<string, unknown>, string, string][] = [
      [{ relays: [] }, "Enter at least one relay address (https://…)", "relays: give at least one relay address (https://…)"],
      [{ irohRelays: ["x"] }, "Not a relay address: x", "irohRelays: not a relay address: x"],
      [{ hyperdhtRelay: "nope" }, "Enter a relay address (wss://…)", "hyperdhtRelay: give a relay address (wss://…)"],
      // A relay address with the wrong scheme (irohWeb.ts irohRelayProblem, hyperdhtRelay.ts hyperdhtRelayProblem).
      [{ irohRelays: ["ftp://x"] }, "Use an https:// relay address: ftp://x", "irohRelays: use an https:// relay address: ftp://x"],
      [{ hyperdhtRelay: "ftp://x" }, "Use a wss:// relay address", "hyperdhtRelay: use a wss:// relay address"],
    ];
    for (const [patch, engine, said] of refusals) {
      node.updateSettings.mockRejectedValueOnce(new Error(engine));
      await expect(callApi(ctx, "settings.set", patch)).rejects.toMatchObject({ code: "bad_request", message: said });
    }
  });

  it("name the Pkarr relay it can't use, as the app's Settings does, and ask for one only for an empty list", async () => {
    // The engine says "Enter at least one relay address" for any list it can't use: the one given went unnamed.
    const { ctx, node } = fake();
    const refusals: [string[], string][] = [
      [["ftp://x"], "relays: not a relay address: ftp://x"],
      [["ftp://relay.example.org"], "relays: use an https:// relay address: ftp://relay.example.org"],
      [["wss://relay.example.org", "notaurl"], "relays: use an https:// relay address: wss://relay.example.org"],
    ];
    for (const [relays, said] of refusals) {
      await expect(callApi(ctx, "settings.set", { relays })).rejects.toMatchObject({ code: "bad_request", message: said });
    }
    expect(node.updateSettings).not.toHaveBeenCalled();
    // A usable one next to them is the engine's to keep (it drops the rest), as before.
    await callApi(ctx, "settings.set", { relays: ["https://relay.example.org", "ftp://x"] });
    expect(node.updateSettings).toHaveBeenLastCalledWith({ settings: { relays: ["https://relay.example.org", "ftp://x"] } });
  });

  it("take TCP and TLS TURN servers for the apps, and say the CLI does not use them", async () => {
    const { ctx, node } = fake();
    const turn = (urls: string) => ({ urls, username: "u", credential: "c" });
    const udp = await callApi(ctx, "settings.set", { iceServers: [turn("turn:t.example.org:3478"), turn("turn:t.example.org:3478?transport=udp")] }) as Record<string, unknown>;
    expect(udp.warning).toBeUndefined();
    const tcp = await callApi(ctx, "settings.set", { iceServers: [turn("turn:t.example.org:3478, turn:t.example.org:3478?transport=tcp"), turn("turns:t.example.org:443?transport=tcp")] }) as Record<string, unknown>;
    expect(node.updateSettings).toHaveBeenLastCalledWith({ settings: { iceServers: [turn("turn:t.example.org:3478, turn:t.example.org:3478?transport=tcp"), turn("turns:t.example.org:443?transport=tcp")] } });
    expect(tcp.warning).toBe("The CLI reaches TURN over UDP only: it does not use turn:t.example.org:3478?transport=tcp, turns:t.example.org:443?transport=tcp (the apps do). Add a turn: server over UDP for the CLI");
  });
});

/**
 * A name is looked up in a table (the settings a command changes, the transports, the methods), and every object has
 * `constructor`, `toString` and the like: they were found there too. `settings set constructor 5` stored it in the
 * profile for good, `chat transport bob constructor` handed the engine a function, and the socket's `constructor`
 * method answered with the daemon's own context, which cannot be written: the caller waited for ever.
 */
describe("a name every object has", () => {
  const NAMES = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];

  it("is no setting: refused, and nothing is stored", async () => {
    const { ctx, node } = fake();
    for (const name of NAMES) {
      await expect(callApi(ctx, "settings.set", { [name]: 5 }), name).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining(`${name} is not a setting the CLI changes`) });
    }
    expect(node.updateSettings).not.toHaveBeenCalled();
  });

  it("is no transport: refused with the transports, and the engine is not asked", async () => {
    const { ctx, node } = fake();
    for (const name of NAMES) {
      await expect(callApi(ctx, "chat.transport", { chat: "Alice", transport: name }), name).rejects.toMatchObject({ code: "bad_request", message: "transport must be one of auto, dht, webrtc, iroh, hyperdht" });
    }
    expect(node.setChatTransport).not.toHaveBeenCalled();
  });

  it("is no method: not found, as any other unknown one", async () => {
    const { ctx } = fake();
    for (const name of [...NAMES, "nope"]) await expect(callApi(ctx, name, {}), name).rejects.toMatchObject({ code: "not_found", message: `No method ${name}` });
  });
});

/**
 * `chat transport` toward a contact whose app has no WebRTC (`GHOSTLY_WEBRTC=0`) kept the choice and answered the chat
 * still on HyperDHT, with nothing waiting: a bot could not tell it never would be. For one this app lacks, the engine
 * answered `engine`, "Transport unavailable". The Connection menu offers neither; the CLI refuses them the same way.
 */
describe("chat transport", () => {
  const withChat = (fields: Partial<LinkView>) => {
    const made = fake();
    made.node.getState = () => ({ links: [link("chat-one", { label: "Alice", ...fields })], groups: [], settings: {} }) as unknown as EngineState;
    return made;
  };

  it("refuses a transport the contact's app lacks, and the engine is not asked", async () => {
    const { ctx, node } = withChat({ availableTransports: ["webrtc/1", "hyperdht/1", "iroh/1"], peerTransports: ["hyperdht/1", "iroh/1"] });
    await expect(callApi(ctx, "chat.transport", { chat: "Alice", transport: "webrtc" })).rejects.toMatchObject({
      code: "refused", message: "Your contact's app doesn't have WebRTC: choose another, or auto", details: { reason: "contact-lacks", transport: "webrtc/1" },
    });
    expect(node.setChatTransport).not.toHaveBeenCalled();
    await callApi(ctx, "chat.transport", { chat: "Alice", transport: "hyperdht" });
    expect(node.setChatTransport).toHaveBeenCalledWith({ linkId: "chat-one", transport: "hyperdht/1" });
  });

  it("refuses one this app lacks, with why it is not running", async () => {
    const { ctx, node } = withChat({ availableTransports: ["hyperdht/1"], peerTransports: ["webrtc/1", "hyperdht/1", "iroh/1"], transportErrors: { "iroh/1": "Iroh relay unreachable" } });
    await expect(callApi(ctx, "chat.transport", { chat: "Alice", transport: "webrtc" })).rejects.toMatchObject({ code: "refused", message: "This app has no WebRTC running", details: { reason: "app-lacks" } });
    await expect(callApi(ctx, "chat.transport", { chat: "Alice", transport: "iroh" })).rejects.toMatchObject({ code: "refused", message: "This app has no Iroh running: Iroh relay unreachable", details: { reason: "app-lacks" } });
    expect(node.setChatTransport).not.toHaveBeenCalled();
  });

  it("takes any on DHT only that this app can start, auto and dht always, and any while the contact's are not known", async () => {
    const dhtOnly = withChat({ deliveryMode: "dht", availableTransports: [], runnableTransports: ["webrtc/1", "iroh/1"], peerTransports: ["webrtc/1", "iroh/1"] });
    await callApi(dhtOnly.ctx, "chat.transport", { chat: "Alice", transport: "iroh" });
    await expect(callApi(dhtOnly.ctx, "chat.transport", { chat: "Alice", transport: "hyperdht" })).rejects.toMatchObject({ details: { reason: "app-lacks" } });
    const unknown = withChat({ availableTransports: ["webrtc/1", "hyperdht/1"], peerTransports: [] });
    for (const transport of ["webrtc", "auto", "dht"]) await callApi(unknown.ctx, "chat.transport", { chat: "Alice", transport });
    expect(unknown.node.setChatTransport).toHaveBeenCalledTimes(3);
  });
});
