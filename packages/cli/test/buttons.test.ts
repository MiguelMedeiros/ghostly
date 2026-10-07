import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { checkStatusCard } from "@ghostly/core";
import { callApi, type ApiContext } from "../src/api";
import { parseArgs } from "../src/args";
import { buttonsOf } from "../src/buttons";
import { COMMANDS, idSlot, positionals, TEXT_COMMANDS } from "../src/commands";
import { chatOnly } from "../src/main";
import { EXIT, type CliError } from "../src/errors";
import { EventHub, type GhostlyEvent } from "../src/events";
import { toTurn } from "../src/listen";
import { openPersistentIndexedDb } from "../src/runtime/storage";
import { messageJson } from "../src/views";
// covers: headless.buttons

/** `send --button`, `group send --button` and `button update` (WISP 406 · Message Buttons), and `button.pressed`. */
const link = (id: string, fields: Partial<LinkView> = {}) => ({ id, peerPubKeyZ32: "p" + id, createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" }, ...fields }) as unknown as LinkView;
const group = (fields: Partial<GroupView> = {}) => ({ id: "g1", name: "Sala", createdAt: 1, profile: "mesh", isAdmin: false, canSend: true, lastMessageAt: 0, invited: [], memberLinks: {},
  members: [{ key: "mekey", role: "member", me: true, online: true, missing: 0 }, { key: "anakey", nick: "Ana", role: "member", me: false, online: true, missing: 0 }], ...fields }) as unknown as GroupView;

function fake(links: LinkView[] = [link("chat-one", { label: "Alice", sessionOffers: { mine: ["buttons/1"], peer: ["edit/1", "buttons/1"] } }), link("chat-two", { label: "Bob", sessionOffers: { mine: [], peer: ["edit/1"] } }), link("chat-three", { label: "Carol" })]) {
  const rows = new Map<string, StoredMessage[]>();
  const of = (linkId: string) => rows.get(linkId) ?? rows.set(linkId, []).get(linkId)!;
  let n = 0;
  const card = (raw: unknown) => { const checked = checkStatusCard(raw); if ("error" in checked) throw new Error(checked.error); return checked.card; };
  const store = (linkId: string, text: string, raw?: unknown) => {
    const id = `me_${++n}`;
    of(linkId).push({ linkId, id, wireId: `w${n}`, text, sender: "me", timestamp: Date.now(), via: "datalink", delivery: "sent", ...(raw !== undefined && { card: card(raw) }) });
    return id;
  };
  const node = {
    getState: () => ({ links, groups: [group()], settings: {}, transport: {} }) as unknown as EngineState,
    getMessages: vi.fn(async (linkId: string) => of(linkId).map((m) => ({ ...m }))),
    groupMessages: vi.fn(async ({ groupId }: { groupId: string }) => of(`group:${groupId}`).map((m) => ({ ...m }))),
    sendMessage: vi.fn(async ({ linkId, text, card: raw }: { linkId: string; text: string; card?: unknown }) => ({ error: null, messageId: store(linkId, text, raw) })),
    sendGroupMessage: vi.fn(async ({ groupId, text, card: raw }: { groupId: string; text: string; card?: unknown }) => ({ error: null, messageId: store(`group:${groupId}`, text, raw) })),
    editMessage: vi.fn(async ({ linkId, messageId, text, card: raw }: { linkId: string; messageId: string; text: string; card?: unknown }) => {
      const row = of(linkId).find((m) => m.id === messageId)!;
      row.text = text;
      if (raw === undefined) delete row.card; else row.card = card(raw);
      row.edit = { seq: (row.edit?.seq ?? 0) + 1, at: Date.now(), history: [] };
      return { error: null, messageId };
    }),
    groupTaken: vi.fn(() => 1),
    // The engine's press: a reply whose text is the label (its own checks are packages/browser's messageButtons test).
    pressButton: vi.fn(async ({ linkId, messageId, buttonId }: { linkId: string; messageId: string; buttonId: string }) => {
      const question = of(linkId).find((m) => m.id === messageId);
      const button = question?.card?.kind === "buttons" ? question.card.buttons.find((b) => b.id === buttonId) : undefined;
      if (!button) return { error: "That message has no such button", refused: true };
      if (question!.card?.kind === "buttons" && question!.card.closed) return { error: "These buttons are closed", refused: true };
      return { error: null, messageId: store(linkId, button.label) };
    }),
  };
  /** A message someone else sent, with buttons when `raw` is a card. */
  const theirs = (linkId: string, id: string, text: string, raw?: unknown) => {
    of(linkId).push({ linkId, id, wireId: `w-${id}`, text, sender: "peer", timestamp: Date.now(), via: "datalink", ...(linkId.startsWith("group:") && { member: "anakey" }), ...(raw !== undefined && { card: card(raw) }) });
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode: "daemon", version: "test" } as unknown as ApiContext;
  return { ctx, node, rows: of, theirs };
}

/** A text command's line as main.ts reads it: the buttons its flags give. */
function flags(name: "send" | "group send", argv: string[]) {
  const spec = TEXT_COMMANDS[name]!;
  return buttonsOf(parseArgs(argv, spec.options, idSlot(spec)).options);
}

/** A table command's line as main.ts reads it. */
function params(name: string, argv: string[]): Record<string, unknown> {
  const command = COMMANDS[name]!;
  const parsed = parseArgs(argv, command.options ?? {}, idSlot(command));
  return command.params!(parsed, positionals(command, parsed.positionals));
}

describe("the button flags", () => {
  it("make buttons from id:Label, the label keeping its colons, with styles, once and an id", () => {
    expect(flags("send", ["Alice", "Want it?", "--button", "yes:Yes", "--button", "no:No: not now", "--style", "yes=primary", "--style", "no=danger", "--once", "--id", "ask-1"])).toEqual({
      buttons: [{ id: "yes", label: "Yes", style: "primary", once: true }, { id: "no", label: "No: not now", style: "danger", once: true }], buttonsId: "ask-1",
    });
    expect(flags("group send", ["Sala", "Ship?", "--button", "ok:Ship it"])).toEqual({ buttons: [{ id: "ok", label: "Ship it" }] });
    expect(flags("send", ["Alice", "hi"])).toBeUndefined();
  });

  it("refuse a button without id:Label, a style for no button, and button flags without a button", () => {
    expect(() => flags("send", ["Alice", "x", "--button", "Yes"])).toThrow(expect.objectContaining({ code: "usage", message: expect.stringMatching(/--button takes id:Label/) }));
    expect(() => flags("send", ["Alice", "x", "--button", "yes:"])).toThrow(expect.objectContaining({ code: "usage" }));
    expect(() => flags("send", ["Alice", "x", "--button", "yes:Yes", "--style", "maybe=primary"])).toThrow(expect.objectContaining({ code: "usage", message: expect.stringMatching(/--style takes id=/) }));
    expect(() => flags("send", ["Alice", "x", "--once"])).toThrow(expect.objectContaining({ code: "usage", message: expect.stringMatching(/--once goes with --button/) }));
  });

  it("refuse two buttons a typed answer could not tell apart, naming the duplicate (exit 2)", () => {
    const refused = (argv: string[]) => { try { flags("send", argv); } catch (error) { return error as CliError; } throw new Error("not refused"); };
    const same = refused(["Alice", "Ok?", "--button", "yes:Yes", "--button", "no:No", "--button", "sure: YES "]);
    expect(same).toMatchObject({ code: "usage", message: expect.stringMatching(/--button "sure: YES " repeats the label of --button "yes:Yes"/) });
    expect(EXIT[same.code]).toBe(2);
    expect(refused(["Alice", "Ok?", "--button", "a:No", "--button", "no:Nope"])).toMatchObject({ code: "usage", message: expect.stringMatching(/--button "a:No" has a label that is the id of --button "no:Nope"/) });
    expect(() => flags("group send", ["Sala", "Ship?", "--button", "a:Ship", "--button", "b:ship"])).toThrow(expect.objectContaining({ code: "usage" }));
    // Labels apart past case and spaces, and a label that is its own id, go.
    expect(flags("send", ["Alice", "Ok?", "--button", "yes:Yes", "--button", "later:Yes, later"])).toHaveProperty("buttons");
  });

  it("refuse the same over the API, where no flag was parsed (the card's rule)", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "chat.send", { chat: "Alice", text: "Ok?", buttons: [{ id: "yes", label: "Yes" }, { id: "y", label: "yes" }] }))
      .rejects.toMatchObject({ code: "bad_request", message: expect.stringMatching(/repeats buttons\[0\]\.label/) });
    expect(node.sendMessage).not.toHaveBeenCalled();
  });

  it("button update takes chosen, close and text; its chat may be a group", () => {
    expect(params("button update", ["Alice", "me_1", "--chosen", "yes", "--close"])).toMatchObject({ chat: "Alice", message: "me_1", chosen: "yes", close: true });
    expect(chatOnly("button.update", { chat: "Sala" })).toBe(false);
  });
});

describe("send with buttons", () => {
  it("sends the text with a buttons card, and says whether the contact's app can press them", async () => {
    const { ctx, node } = fake();
    const result = await callApi(ctx, "chat.send", { chat: "Alice", text: "Want the $30 one? Reply yes or no", buttons: [{ id: "yes", label: "Yes", style: "primary" }, { id: "no", label: "No" }] }) as Record<string, unknown>;
    expect(result).toMatchObject({ chat: "chat-one", messageId: "me_1", pressable: true, card: { kind: "buttons", buttons: [{ id: "yes", label: "Yes", style: "primary" }, { id: "no", label: "No" }] } });
    expect(result.buttons).toMatch(/^ask-[A-Za-z0-9_-]{8}$/);
    expect(node.sendMessage.mock.calls[0]![0]).toMatchObject({ linkId: "chat-one", text: "Want the $30 one? Reply yes or no", card: { kind: "buttons", id: result.buttons } });
    // An app that said what it offers, without buttons/1; one that has not said yet.
    expect(await callApi(ctx, "chat.send", { chat: "Bob", text: "Ok?", buttons: [{ id: "ok", label: "Ok" }], buttonsId: "q1" })).toMatchObject({ buttons: "q1", pressable: false });
    expect(await callApi(ctx, "chat.send", { chat: "Carol", text: "Ok?", buttons: [{ id: "ok", label: "Ok" }] })).toMatchObject({ pressable: null });
    // A plain send says nothing of buttons.
    expect(await callApi(ctx, "chat.send", { chat: "Alice", text: "hi" })).not.toHaveProperty("buttons");
  });

  it("refuses a bad id, a long label and too many buttons before the engine is asked", async () => {
    const { ctx, node } = fake();
    const bad = (buttons: unknown) => callApi(ctx, "chat.send", { chat: "Alice", text: "Pick", buttons });
    await expect(bad([{ id: "-yes", label: "Yes" }])).rejects.toMatchObject({ code: "bad_request", message: /buttons\[0\]\.id/ });
    await expect(bad([{ id: "has space", label: "Yes" }])).rejects.toMatchObject({ code: "bad_request" });
    await expect(bad([{ id: "a", label: "x".repeat(41) }])).rejects.toMatchObject({ code: "bad_request", message: /label/ });
    await expect(bad([{ id: "a", label: "A" }, { id: "a", label: "B" }])).rejects.toMatchObject({ code: "bad_request", message: /used twice/ });
    await expect(bad(Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, label: `B${i}` })))).rejects.toMatchObject({ code: "bad_request", message: /1 to 6/ });
    await expect(bad([{ id: "a", label: "A", style: "loud" }])).rejects.toMatchObject({ code: "bad_request", message: /style/ });
    await expect(bad("yes")).rejects.toMatchObject({ code: "bad_request" });
    expect(node.sendMessage).not.toHaveBeenCalled();
  });

  it("sends buttons to a group", async () => {
    const { ctx, node } = fake();
    expect(await callApi(ctx, "group.send", { group: "Sala", text: "Deploy now?", mentions: [], buttons: [{ id: "go", label: "Go", once: true }], buttonsId: "deploy" }))
      .toMatchObject({ group: "g1", messageId: "me_1", buttons: "deploy", card: { kind: "buttons", id: "deploy", buttons: [{ id: "go", label: "Go", once: true }] } });
    expect(node.sendGroupMessage).toHaveBeenCalledWith(expect.objectContaining({ groupId: "g1", text: "Deploy now?", card: expect.objectContaining({ kind: "buttons" }) }));
  });
});

describe("button update", () => {
  it("shows the answer and closes the buttons, the same buttons and text kept", async () => {
    const { ctx, node, rows } = fake();
    await callApi(ctx, "chat.send", { chat: "Alice", text: "Want it?", buttons: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }], buttonsId: "q" });
    expect(await callApi(ctx, "button.update", { chat: "Alice", message: "me_1", chosen: "yes" })).toMatchObject({ chat: "chat-one", buttons: "q", messageId: "me_1", edits: 1, card: { chosen: "yes" } });
    expect(node.editMessage).toHaveBeenLastCalledWith(expect.objectContaining({ linkId: "chat-one", messageId: "me_1", text: "Want it?" }));
    await callApi(ctx, "button.update", { chat: "Alice", message: "me_1", close: true });
    expect(rows("chat-one")[0]).toMatchObject({ text: "Want it?", card: { kind: "buttons", id: "q", chosen: "yes", closed: true, buttons: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] } });
    // A new text, and still closed.
    await callApi(ctx, "button.update", { chat: "Alice", message: "me_1", text: "Got it: yes" });
    expect(rows("chat-one")[0]).toMatchObject({ text: "Got it: yes", card: { closed: true } });
  });

  it("guards a new text as edit does: a seed or a key needs --force", async () => {
    const { ctx, node, rows } = fake();
    await callApi(ctx, "chat.send", { chat: "Alice", text: "Want it?", buttons: [{ id: "yes", label: "Yes" }] });
    const seed = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    await expect(callApi(ctx, "button.update", { chat: "Alice", message: "me_1", text: seed })).rejects.toMatchObject({ code: "confirm" });
    expect(node.editMessage).not.toHaveBeenCalled();
    await callApi(ctx, "button.update", { chat: "Alice", message: "me_1", text: seed, force: true });
    expect(rows("chat-one")[0]).toMatchObject({ text: seed });
    expect(params("button update", ["Alice", "me_1", "--text", "x", "--force"])).toMatchObject({ text: "x", force: true });
  });

  it("finds the message by the id both sides know too, and in a group", async () => {
    const { ctx, node } = fake();
    await callApi(ctx, "group.send", { group: "Sala", text: "Deploy?", mentions: [], buttons: [{ id: "go", label: "Go" }] });
    expect(await callApi(ctx, "button.update", { chat: "Sala", message: "w1", chosen: "go", close: true })).toMatchObject({ group: "g1", messageId: "me_1", card: { chosen: "go", closed: true } });
    expect(node.editMessage).toHaveBeenCalledWith(expect.objectContaining({ linkId: "group:g1", messageId: "me_1" }));
  });

  it("refuses a message not mine or not there, one without buttons, a button it lacks, and nothing to do", async () => {
    const { ctx, node } = fake();
    await callApi(ctx, "chat.send", { chat: "Alice", text: "plain" });
    await callApi(ctx, "chat.send", { chat: "Alice", text: "Ok?", buttons: [{ id: "ok", label: "Ok" }] });
    await expect(callApi(ctx, "button.update", { chat: "Alice", message: "nope", close: true })).rejects.toMatchObject({ code: "not_found" });
    await expect(callApi(ctx, "button.update", { chat: "Alice", message: "me_1", close: true })).rejects.toMatchObject({ code: "bad_request", message: /no buttons/ });
    await expect(callApi(ctx, "button.update", { chat: "Alice", message: "me_2", chosen: "maybe" })).rejects.toMatchObject({ code: "bad_request", message: /chosen/ });
    await expect(callApi(ctx, "button.update", { chat: "Alice", message: "me_2" })).rejects.toMatchObject({ code: "bad_request", message: /Nothing to update/ });
    expect(node.editMessage).not.toHaveBeenCalled();
  });
});

describe("button press", () => {
  const ask = { kind: "buttons", id: "q", buttons: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] };

  it("presses a button of the contact's question, by its id here or the one both sides know", async () => {
    const { ctx, node, rows, theirs } = fake();
    theirs("chat-one", "peer_1", "Want it?", ask);
    expect(await callApi(ctx, "button.press", { chat: "Alice", message: "peer_1", button: "yes" }))
      .toEqual({ chat: "chat-one", messageId: "peer_1", button: "yes", label: "Yes", replyId: "me_1", delivery: "sent" });
    expect(node.pressButton).toHaveBeenCalledWith({ linkId: "chat-one", messageId: "peer_1", buttonId: "yes" });
    expect(rows("chat-one").at(-1)).toMatchObject({ id: "me_1", sender: "me", text: "Yes" });
    expect(await callApi(ctx, "button.press", { chat: "Alice", message: "w-peer_1", button: "no", wait: "none" })).toMatchObject({ messageId: "peer_1", button: "no", label: "No" });
  });

  it("presses in a group, answering how many edges took it", async () => {
    const { ctx, node, theirs } = fake();
    theirs("group:g1", "gq", "Deploy?", { kind: "buttons", id: "d", buttons: [{ id: "go", label: "Go" }] });
    expect(await callApi(ctx, "button.press", { chat: "Sala", message: "gq", button: "go" })).toEqual({ group: "g1", messageId: "gq", button: "go", label: "Go", replyId: "me_1", edges: 1 });
    expect(node.pressButton).toHaveBeenCalledWith({ linkId: "group:g1", messageId: "gq", buttonId: "go" });
  });

  it("refuses my own message, one without buttons, a button it lacks, and what the engine refuses", async () => {
    const { ctx, node, theirs } = fake();
    await callApi(ctx, "chat.send", { chat: "Alice", text: "Mine?", buttons: [{ id: "yes", label: "Yes" }] });
    theirs("chat-one", "peer_plain", "hello");
    theirs("chat-one", "peer_closed", "Closed?", { ...ask, closed: true });
    await expect(callApi(ctx, "button.press", { chat: "Alice", message: "me_1", button: "yes" })).rejects.toMatchObject({ code: "not_found", message: /from someone else/ });
    await expect(callApi(ctx, "button.press", { chat: "Alice", message: "peer_plain", button: "yes" })).rejects.toMatchObject({ code: "bad_request", message: /no buttons/ });
    await expect(callApi(ctx, "button.press", { chat: "Alice", message: "peer_closed", button: "maybe" })).rejects.toMatchObject({ code: "not_found", message: /its buttons: yes, no/ });
    expect(node.pressButton).not.toHaveBeenCalled();
    const refused = await callApi(ctx, "button.press", { chat: "Alice", message: "peer_closed", button: "yes" }).catch((error: CliError) => error);
    expect(refused).toMatchObject({ code: "refused", message: "These buttons are closed" });
    expect(EXIT[(refused as CliError).code]).toBe(1);
  });

  it("reads its line: chat, message and button, with --wait; its chat may be a group", () => {
    expect(params("button press", ["Alice", "peer_1", "yes", "--wait", "delivered", "--timeout", "5"])).toMatchObject({ chat: "Alice", message: "peer_1", button: "yes", wait: "delivered", timeout: 5 });
    // A message id that starts with a dash is an id, not a flag.
    expect(params("button press", ["Alice", "-Ab3", "yes"])).toMatchObject({ message: "-Ab3" });
    expect(chatOnly("button.press", { chat: "Sala" })).toBe(false);
  });
});

describe("presses in the stream", () => {
  let dir: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ghostly-buttons-"));
    await openPersistentIndexedDb(join(dir, "db"));
  });
  const state = (links: LinkView[], groups: unknown[] = []) => ({ links, groups, settings: {}, transport: {} }) as unknown as EngineState;
  const row = (linkId: string, id: string, fields: Partial<StoredMessage> = {}): StoredMessage => ({ linkId, id, text: "t " + id, sender: "peer", timestamp: 1, via: "datalink", ...fields });
  async function hub(name: string) {
    const h = new EventHub(join(dir, `${name}.jsonl`), () => 1000, name);
    await h.open();
    const events: GhostlyEvent[] = [];
    h.onEvent((e) => events.push(e));
    return { h, events };
  }

  it("says button.pressed after the reply's own event, in a chat and in a group, and nothing for a plain reply", async () => {
    const { h, events } = await hub("presses");
    // The chat named "Alice" here; the contact calls themselves "Alice Smith".
    h.baseline(state([link("c1", { label: "Alice", peerNick: "Alice Smith" })], [group()]), new Map([["c1", []], ["group:g1", []]]));
    const question = row("c1", "me_1", { sender: "me", text: "Want it?", card: { kind: "buttons", id: "q", buttons: [{ id: "yes", label: "Yes" }] } });
    h.sink.post({ kind: "messages", linkId: "c1", messages: [question,
      row("c1", "r1", { text: "Yes", replyTo: { id: "w1", snippet: "Want it?", from: "me", button: "yes", messageId: "me_1" }, press: { messageId: "me_1", button: "yes", label: "Yes" } }),
      row("c1", "r2", { text: "why?", replyTo: { id: "w1", snippet: "Want it?", from: "me", messageId: "me_1" } }),
      row("c1", "r3", { text: "yes", replyTo: { id: "w1", snippet: "", messageId: "me_1" }, press: { messageId: "me_1", button: "yes", label: "Yes", inferred: true } })] });
    h.sink.post({ kind: "messages", linkId: "group:g1", messages: [row("group:g1", "gr1", { text: "Go", member: "anakey", replyTo: { id: "gq", snippet: "Deploy?", from: "me", button: "go", messageId: "gq" }, press: { messageId: "gq", button: "go", label: "Go" } })] });
    expect(events.map((e) => e.id)).toEqual([
      "message.sent:c1:me_1", "message.received:c1:r1", "button.pressed:c1:r1", "message.received:c1:r2", "message.received:c1:r3", "button.pressed:c1:r3",
      "group.message:g1:gr1", "button.pressed:g1:gr1",
    ]);
    const pressed = events.filter((e) => e.type === "button.pressed");
    // `name` is the chat's name here; what the contact calls themselves is under `untrusted`.
    expect(pressed[0]).toMatchObject({ chat: "c1", messageId: "me_1", button: "yes", label: "Yes", by: "c1", name: "Alice", replyId: "r1", untrusted: { name: "Alice Smith" } });
    expect(pressed[0]).not.toHaveProperty("inferred");
    expect(pressed[1]).toMatchObject({ replyId: "r3", inferred: true });
    // In a group, both are the roster's name: the one the member chose.
    expect(pressed[2]).toMatchObject({ group: "g1", messageId: "gq", button: "go", label: "Go", by: "anakey", name: "Ana", replyId: "gr1", untrusted: { name: "Ana" } });
    // The reply's own event carries the press, and its replyTo the button.
    expect((events[1]!.message as Record<string, unknown>)).toMatchObject({ press: { messageId: "me_1", button: "yes", label: "Yes" }, replyTo: { id: "me_1", button: "yes", found: true } });
    // Once each: the same rows again say nothing.
    h.sink.post({ kind: "messages", linkId: "group:g1", messages: [row("group:g1", "gr1", { text: "Go", member: "anakey", press: { messageId: "gq", button: "go", label: "Go" } })] });
    expect(events.filter((e) => e.type === "button.pressed")).toHaveLength(3);
  });

  it("says nothing of the engine's own buttons restore, and a later update of the bot's as any edit", async () => {
    const { h, events } = await hub("restore");
    const card = { kind: "buttons" as const, id: "q", buttons: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] };
    // The question went on the DHT floor, its text alone, and the contact confirmed it.
    const floored = row("c1", "me_1", { sender: "me", wireId: "w1", text: "Want it?", card, via: "pkarr", delivery: "delivered", cardRestore: "due" });
    h.baseline(state([link("c1")]), new Map([["c1", [floored]]]));
    // Live again: the engine sends the buttons as edit 1 (the same text), then the contact confirms it.
    const restored = { ...floored, cardRestore: "sent" as const, edit: { seq: 1, at: 2, history: [], pending: true as const, restore: true as const } };
    h.sink.post({ kind: "messages", linkId: "c1", messages: [restored] });
    h.sink.post({ kind: "messages", linkId: "c1", messages: [{ ...restored, edit: { seq: 1, at: 2, history: [], restore: true as const } }] });
    expect(events).toEqual([]);
    // The bot marks the answer (`button update --chosen`): edit 2, a new edit of its own, reported once.
    const chosen = { ...restored, card: { ...card, chosen: "yes" }, edit: { seq: 2, at: 3, history: [] } };
    h.sink.post({ kind: "messages", linkId: "c1", messages: [chosen] });
    h.sink.post({ kind: "messages", linkId: "c1", messages: [chosen] });
    expect(events.map((e) => e.id)).toEqual(["message.edited:c1:me_1:2"]);
    expect(events[0]).toMatchObject({ chat: "c1", messageId: "me_1", edits: 2, message: { text: "Want it?" } });
    // Restarted with the restore only: still nothing.
    const again = await hub("restore-restart");
    again.h.baseline(state([link("c1")]), new Map([["c1", [floored]]]));
    again.h.sink.post({ kind: "messages", linkId: "c1", messages: [restored] });
    expect(again.events).toEqual([]);
  });

  it("says button.pressed for a group reply whose press came after it (a stripped copy completed), once", async () => {
    const { h, events } = await hub("late-presses");
    h.baseline(state([], [group()]), new Map([["group:g1", []]]));
    // Handed on without its reply box: only the text first.
    h.sink.post({ kind: "messages", linkId: "group:g1", messages: [row("group:g1", "gr1", { text: "Go", member: "anakey" })] });
    // The author's whole copy completes it: the reply, and the engine's press.
    const whole = row("group:g1", "gr1", { text: "Go", member: "anakey", replyTo: { id: "gq", snippet: "Deploy?", from: "me", button: "go", messageId: "gq" }, press: { messageId: "gq", button: "go", label: "Go" } });
    h.sink.post({ kind: "messages", linkId: "group:g1", messages: [whole] });
    h.sink.post({ kind: "messages", linkId: "group:g1", messages: [whole] });
    expect(events.map((e) => e.id)).toEqual(["group.message:g1:gr1", "button.pressed:g1:gr1"]);
    expect(events[1]).toMatchObject({ group: "g1", messageId: "gq", button: "go", by: "anakey", replyId: "gr1" });
    // An edit of it later says the edit, not the press again.
    h.sink.post({ kind: "messages", linkId: "group:g1", messages: [{ ...whole, edit: { seq: 1, at: 2, history: [] } }] });
    expect(events.map((e) => e.type)).toEqual(["group.message", "button.pressed", "group.message.edited"]);
    // Restarted: what was reported stays reported.
    const again = await hub("late-presses");
    again.h.baseline(state([], [group()]), new Map([["group:g1", [{ ...whole, edit: { seq: 1, at: 2, history: [] } }]]]));
    expect(again.events).toEqual([]);
  });

  it("an agent turn carries the press beside the untrusted text, and a plain turn none", () => {
    const received = (message: StoredMessage) => ({ seq: 1, id: `message.received:c1:${message.id}`, type: "message.received", at: 1, chat: "c1", message: messageJson(message) });
    const pressed = toTurn(received(row("c1", "r1", { text: "Yes", press: { messageId: "me_1", button: "yes", label: "Yes" } })));
    expect(pressed).toMatchObject({ press: { messageId: "me_1", button: "yes", label: "Yes" }, untrusted: { text: "Yes" } });
    expect(toTurn(received(row("c1", "r2", { text: "Yes" })))).not.toHaveProperty("press");
  });

  it("messageJson leaves press and button out of a plain message", () => {
    const json = messageJson(row("c1", "x", { replyTo: { id: "w1", snippet: "s", from: "me" } }));
    expect(json).not.toHaveProperty("press");
    expect(json.replyTo).not.toHaveProperty("button");
  });
});
