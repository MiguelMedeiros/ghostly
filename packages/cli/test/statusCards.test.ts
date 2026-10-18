import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { STATUS_CARD_LIMITS, checkStatusCard, type StatusCard } from "@ghostly/core";
import { callApi, type ApiContext } from "../src/api";
import { parseArgs } from "../src/args";
import { EventHub } from "../src/events";
import { openPersistentIndexedDb } from "../src/runtime/storage";
import { COMMANDS, idSlot, positionals } from "../src/commands";
import { chatOnly } from "../src/main";
import { CARD_UPDATE_GAP_MS, flushCardUpdates, mergeCard } from "../src/statusCards";
// covers: headless.status-cards

/** `task send` and `task update` (WISP 405 · Status Cards) against an engine that keeps what it is sent. */
const link = (id: string, fields: Partial<LinkView> = {}) => ({ id, peerPubKeyZ32: "p" + id, createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" }, ...fields }) as unknown as LinkView;
const group = (fields: Partial<GroupView> = {}) => ({ id: "g1", name: "Sala de Máquinas", createdAt: 1, profile: "mesh", isAdmin: false, canSend: true, lastMessageAt: 0, invited: [], memberLinks: {},
  members: [{ key: "mekey", role: "member", me: true, online: true, missing: 0 }], ...fields }) as unknown as GroupView;

function fake(mode: "daemon" | "one-shot" = "daemon") {
  const rows = new Map<string, StoredMessage[]>();
  const of = (linkId: string) => rows.get(linkId) ?? rows.set(linkId, []).get(linkId)!;
  let n = 0;
  const store = (linkId: string, text: string, card?: StatusCard) => {
    const id = `me_${++n}`;
    of(linkId).push({ linkId, id, wireId: `w${n}`, text, sender: "me", timestamp: Date.now(), via: "datalink", delivery: "sent", ...(card && { card }) });
    return id;
  };
  const card = (raw: unknown) => { const checked = checkStatusCard(raw); if ("error" in checked) throw new Error(checked.error); return checked.card; };
  const node = {
    getState: () => ({ links: [link("chat-one", { label: "Coordinator" })], groups: [group()], settings: {}, transport: {} }) as unknown as EngineState,
    getMessages: vi.fn(async (linkId: string) => of(linkId).map((m) => ({ ...m }))),
    getMessage: vi.fn(async (linkId: string, id: string) => { const m = of(linkId).find((x) => x.id === id); return m && { ...m }; }),
    groupMessages: vi.fn(async ({ groupId }: { groupId: string }) => of(`group:${groupId}`).map((m) => ({ ...m }))),
    sendMessage: vi.fn(async ({ linkId, text, card: raw }: { linkId: string; text: string; card?: unknown }) => ({ error: null, messageId: store(linkId, text || "fallback", raw ? card(raw) : undefined) })),
    sendGroupMessage: vi.fn(async ({ groupId, text, card: raw }: { groupId: string; text: string; card?: unknown }) => ({ error: null, messageId: store(`group:${groupId}`, text || "fallback", raw ? card(raw) : undefined) })),
    editMessage: vi.fn(async ({ linkId, messageId, card: raw }: { linkId: string; messageId: string; text: string; card?: unknown }) => {
      const row = of(linkId).find((m) => m.id === messageId)!;
      row.card = card(raw);
      row.edit = { seq: (row.edit?.seq ?? 0) + 1, at: Date.now(), history: [] };
      return { error: null, messageId };
    }),
    groupTaken: vi.fn(() => 1),
    removeMessage: vi.fn(async ({ linkId, messageId }: { linkId: string; messageId: string }) => {
      const at = of(linkId).findIndex((m) => m.id === messageId);
      if (at < 0) return { error: "Only your own messages can be deleted for everyone", refused: true };
      of(linkId).splice(at, 1);
      return { error: null };
    }),
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode, version: "test" } as unknown as ApiContext;
  return { ctx, node, rows: of, store };
}

/** A command line as main.ts reads it: its options and positionals, then the method's parameters. */
function params(name: string, argv: string[]): Record<string, unknown> {
  const command = COMMANDS[name]!;
  const parsed = parseArgs(argv, command.options ?? {}, idSlot(command));
  return command.params!(parsed, positionals(command, parsed.positionals));
}

afterEach(() => { vi.useRealTimers(); });

describe("the task commands", () => {
  it("build a card from flags, the JSON under them", () => {
    expect(params("task send", ["Coordinator", "--title", "Fix relay rotation", "--steps", "2/5", "--step", "Running the e2e", "--item", "done:Codec", "--item", "Engine",
      "--pr-url", "https://github.com/o/r/pull/612", "--pr-number", "612", "--additions", "123", "--deletions", "45", "--link", "CI=https://ci.example/1", "--json", '{"branch":"r6a/x","title":"ignored"}'])).toEqual({
      chat: "Coordinator", text: undefined, force: false, wait: undefined, timeout: undefined,
      card: { branch: "r6a/x", title: "Fix relay rotation", done: 2, total: 5, step: "Running the e2e", items: [{ state: "done", text: "Codec" }, { state: "pending", text: "Engine" }],
        pr: { url: "https://github.com/o/r/pull/612", number: 612, additions: 123, deletions: 45 }, links: [{ label: "CI", url: "https://ci.example/1" }] },
    });
    expect(params("task update", ["g1", "relay-rotation", "--progress", "80"])).toMatchObject({ chat: "g1", task: "relay-rotation", card: { progress: 80 } });
    // The pull request's state and checks, tags (each --tag one) and the parent task.
    expect(params("task send", ["g1", "--title", "Codec", "--pr-url", "https://github.com/o/r/pull/612", "--pr-state", "open", "--pr-checks", "passing", "--tag", "core", "--tag", "web", "--parent", "epic-1"]).card).toEqual({
      title: "Codec", pr: { url: "https://github.com/o/r/pull/612", state: "open", checks: "passing" }, tags: ["core", "web"], parent: "epic-1" });
    expect(params("task update", ["g1", "codec", "--pr-state", "merged"]).card).toEqual({ pr: { state: "merged" } });
    expect(() => params("task update", ["g1", "t", "--steps", "two"])).toThrow(/--steps takes done\/total/);
    expect(() => params("task send", ["g1", "--json", "{nope"])).toThrow(/not valid JSON/);
  });

  it("refuse a --json file that is not there or is a folder in the CLI's words with the path, and \"\" as naming no file", () => {
    // Before, Node's text ("ENOENT: no such file or directory, open …", "EISDIR: illegal operation on a directory, read" with
    // no path), and "" was the current folder.
    const dir = mkdtempSync(join(tmpdir(), "ghostly-cardjson-"));
    const missing = join(dir, "nofile.json");
    for (const name of ["task send", "routine send", "usage send"]) {
      const send = (...json: string[]) => () => params(name, ["g1", ...json]);
      expect(send("--json", missing)).toThrow(expect.objectContaining({ code: "not_found", message: `No such file or folder: ${missing}` }));
      expect(send("--json", dir)).toThrow(expect.objectContaining({ code: "bad_request", message: `${dir} is a folder: name a file` }));
      expect(send("--json", "")).toThrow(expect.objectContaining({ code: "usage", message: "A path given as \"\" names no file" }));
    }
  });

  it("refuse a new card without its title as a usage error (exit 2) that names the flag; --json may give it", () => {
    expect(() => params("task send", ["g1", "--steps", "1/4"])).toThrow(expect.objectContaining({ code: "usage", message: expect.stringMatching(/^--title is needed: ghostly task send/) }));
    expect(() => params("task send", ["g1", "--title", " "])).toThrow(expect.objectContaining({ code: "usage" }));
    expect(params("task send", ["g1", "--json", '{"title":"Ship"}'])).toMatchObject({ card: { title: "Ship" } });
    // An update names only what changes.
    expect(params("task update", ["g1", "t", "--status", "done"])).toMatchObject({ card: { status: "done" } });
  });

  it("refuse an item whose state is no state, listing the states; text that names none stays pending as it is", () => {
    const items = (...values: string[]) => (params("task send", ["g1", "--title", "Ship", ...values.flatMap((v) => ["--item", v])]).card as { items: unknown }).items;
    expect(() => items("queued:Publishing")).toThrow(/"queued" is not a state: use pending, running, done, failed or skipped/);
    expect(() => params("task update", ["g1", "t", "--item", "done:Codec", "--item", "fix: tests"])).toThrow(expect.objectContaining({ code: "usage" }));
    expect(items("done: Codec", "Step 2: build", "Note: flaky", "https://ci.example/1", "Engine", "pending:fix: tests")).toEqual([
      { state: "done", text: "Codec" }, { state: "pending", text: "Step 2: build" }, { state: "pending", text: "Note: flaky" },
      { state: "pending", text: "https://ci.example/1" }, { state: "pending", text: "Engine" }, { state: "pending", text: "fix: tests" },
    ]);
  });

  it("refuse a flag the card would not take as a usage error (exit 2) that names the flag, not the card's field", () => {
    const usage = (name: string, argv: string[], message: RegExp) => expect(() => params(name, argv)).toThrow(expect.objectContaining({ code: "usage", message: expect.stringMatching(message) }));
    const send = (...flags: string[]) => ["g1", "--title", "Build", ...flags];
    usage("task send", send("--steps", "9/5"), /^--steps takes done\/total with done at most total, like 2\/5, not "9\/5"$/);
    usage("task update", ["g1", "t", "--steps", "0/0"], /^--steps takes done\/total/);
    usage("task send", send("--tag", "a", "--tag", "b", "--tag", "c", "--tag", "d"), /^--tag is given at most 3 times, not 4$/);
    usage("task send", send("--progress", "150"), /^--progress takes a percent from 0 to 100, not 150$/);
    usage("task update", ["g1", "t", "--pr-state", "weird"], /^--pr-state takes draft, open, merged or closed, not "weird"$/);
    usage("task update", ["g1", "t", "--pr-checks", "green"], /^--pr-checks takes passing, failing or pending, not "green"$/);
    usage("task send", send("--pr-url", "http://github.com/o/r/pull/1"), /^--pr-url takes an https link of at most 512 characters, not "http:/);
    // A new card's pull request goes by its link: the flags that came without it are named.
    usage("task send", send("--pr-state", "open"), /^--pr-state goes with --pr-url: ghostly task send/);
    usage("task send", send("--pr-number", "7", "--pr-checks", "passing"), /^--pr-number and --pr-checks go with --pr-url: ghostly task send/);
    expect(params("task send", send("--pr-state", "open", "--json", '{"pr":{"url":"https://github.com/o/r/pull/1"}}')).card).toMatchObject({ pr: { url: "https://github.com/o/r/pull/1", state: "open" } });
    // An update's card may have the link already; a whole card in --json stays the card's to check.
    expect(params("task update", ["g1", "t", "--pr-checks", "failing"]).card).toEqual({ pr: { checks: "failing" } });
    expect(params("task send", send("--json", '{"pr":{"state":"open"},"tags":["a","b","c","d"]}')).card).toMatchObject({ pr: { state: "open" } });
    expect(params("task send", send("--steps", "5/5", "--json", '{"progress":100}', "--tag", "a", "--tag", "b", "--tag", "c")).card).toMatchObject({ done: 5, total: 5, progress: 100, tags: ["a", "b", "c"] });
  });

  it("start the groups' sessions even in a one-shot: the chat they name may be a group", () => {
    expect(chatOnly("task.send", { chat: "Sala" })).toBe(false);
    expect(chatOnly("chat.send", { chat: "Alice" })).toBe(true);
  });
});

describe("task send", () => {
  it("sends a checked card to a chat, running from now, and says its id and message", async () => {
    const { ctx, node } = fake();
    const result = await callApi(ctx, "task.send", { chat: "Coordinator", card: { id: "relay-rotation", title: "Fix relay rotation", progress: 10 } }) as Record<string, unknown>;
    expect(result).toMatchObject({ chat: "chat-one", task: "relay-rotation", messageId: "me_1", delivery: "sent" });
    const sent = node.sendMessage.mock.calls[0]![0] as { linkId: string; text: string; card: StatusCard };
    expect(sent).toMatchObject({ linkId: "chat-one", text: "", card: { kind: "task", id: "relay-rotation", status: "running", progress: 10 } });
    expect((sent.card as { startedAt?: number }).startedAt).toBeGreaterThan(0);
  });

  it("makes an id up when none is given, and goes to a group by its name", async () => {
    const { ctx, node } = fake();
    const result = await callApi(ctx, "task.send", { chat: "Sala de Máquinas", card: { title: "Nightly build" } }) as Record<string, unknown>;
    expect(result).toMatchObject({ group: "g1", messageId: "me_1" });
    expect(result.task).toMatch(/^task-[A-Za-z0-9_-]{8}$/);
    expect(node.sendGroupMessage).toHaveBeenCalledWith(expect.objectContaining({ groupId: "g1", text: "" }));
  });

  it("refuses a card out of bounds before the engine is asked, saying why", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "task.send", { chat: "Coordinator", card: { title: "x", status: "paused" } })).rejects.toMatchObject({ code: "bad_request", message: /status is one of/ });
    await expect(callApi(ctx, "task.send", { chat: "Coordinator", card: { title: "x", pr: { url: "http://github.com/o/r/pull/1" } } })).rejects.toMatchObject({ code: "bad_request", message: /https/ });
    await expect(callApi(ctx, "task.send", { chat: "Coordinator", card: { title: "x", items: Array.from({ length: 21 }, () => ({ text: "x" })) } })).rejects.toMatchObject({ code: "bad_request" });
    expect(node.sendMessage).not.toHaveBeenCalled();
  });
});

describe("the secret guard on cards", () => {
  const seed = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const nsec = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";

  it("refuses a card whose text looks like a seed or a key, as send does, unless --force", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "task.send", { chat: "Coordinator", card: { title: "Deploy", step: seed } })).rejects.toMatchObject({ code: "confirm", details: { kind: "mnemonic" }, message: /send it with --force/ });
    await expect(callApi(ctx, "task.send", { chat: "Sala de Máquinas", card: { title: "Deploy", items: [{ state: "done", text: nsec }] } })).rejects.toMatchObject({ code: "confirm", details: { kind: "nsec" } });
    await expect(callApi(ctx, "task.send", { chat: "Coordinator", card: { title: "Deploy" }, text: seed })).rejects.toMatchObject({ code: "confirm" });
    await expect(callApi(ctx, "routine.send", { chat: "Coordinator", card: { name: "Nightly", schedule: "every day 01:00" }, run: { result: "failed", summary: `key: ${nsec}` } })).rejects.toMatchObject({ code: "confirm", details: { kind: "nsec" } });
    expect(node.sendMessage).not.toHaveBeenCalled();
    expect(node.sendGroupMessage).not.toHaveBeenCalled();
    await expect(callApi(ctx, "task.send", { chat: "Coordinator", card: { id: "t1", title: "Deploy", step: seed }, force: true })).resolves.toMatchObject({ task: "t1" });
    expect(node.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("refuses an update that brings one, and not one for the text the card already had", async () => {
    vi.useFakeTimers();
    const { ctx, node } = fake("one-shot");
    await callApi(ctx, "task.send", { chat: "Coordinator", card: { id: "t1", title: "Deploy", step: seed }, force: true });
    await expect(callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { step: `seed: ${seed}` } })).rejects.toMatchObject({ code: "confirm", message: /update it with --force/ });
    await callApi(ctx, "routine.send", { chat: "Coordinator", card: { id: "r1", name: "Nightly", schedule: "every day 01:00" } });
    await expect(callApi(ctx, "routine.update", { chat: "Coordinator", routine: "r1", card: {}, run: { result: "failed", summary: nsec } })).rejects.toMatchObject({ code: "confirm" });
    expect(node.editMessage).not.toHaveBeenCalled();
    const update = callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { status: "done" } });
    await vi.advanceTimersByTimeAsync(CARD_UPDATE_GAP_MS);
    await expect(update).resolves.toMatchObject({ task: "t1" });
    expect(node.editMessage).toHaveBeenCalledTimes(1);
  });

  it("reads a card's text as the card carries it: a key with invisible characters in it goes out whole", async () => {
    const { ctx, node } = fake();
    // A zero-width space, a soft hyphen, a word joiner, an escape: a card's lines lose them, and the key is one piece again.
    const broken = (mark: string) => `${nsec.slice(0, 20)}${mark}${nsec.slice(20)}`;
    for (const mark of ["​", "­", "⁠", "\u001b"]) {
      expect(checkStatusCard({ kind: "task", id: "t", title: "Deploy", status: "running", step: broken(mark) })).toMatchObject({ card: { step: nsec } });
      await expect(callApi(ctx, "task.send", { chat: "Coordinator", card: { title: "Deploy", step: broken(mark) } })).rejects.toMatchObject({ code: "confirm", details: { kind: "nsec" } });
    }
    await expect(callApi(ctx, "task.send", { chat: "Sala de Máquinas", card: { title: "Deploy", items: [{ state: "done", text: broken("​") }] } })).rejects.toMatchObject({ code: "confirm", details: { kind: "nsec" } });
    await expect(callApi(ctx, "routine.send", { chat: "Coordinator", card: { name: "Nightly", schedule: "every day 01:00" }, run: { result: "failed", summary: broken("­") } })).rejects.toMatchObject({ code: "confirm", details: { kind: "nsec" } });
    expect(node.sendMessage).not.toHaveBeenCalled();
    expect(node.sendGroupMessage).not.toHaveBeenCalled();
    await expect(callApi(ctx, "task.send", { chat: "Coordinator", card: { id: "t1", title: "Deploy", step: broken("​") }, force: true })).resolves.toMatchObject({ task: "t1", card: { step: nsec } });
  });

  it("takes --force on every card command", () => {
    for (const [name, argv] of [["task send", ["c", "--title", "t"]], ["task update", ["c", "t1"]], ["routine send", ["c", "--name", "n", "--schedule", "daily"]], ["routine update", ["c", "r1"]], ["usage send", ["c", "--left", "50"]]] as const)
      expect(params(name, [...argv, "--force"])).toMatchObject({ force: true });
  });
});

describe("a task's pull request state, checks, tags and parent", () => {
  it("go on the card when they hold, and are refused before the engine is asked when a reader would leave them out", async () => {
    const { ctx, node } = fake();
    await callApi(ctx, "task.send", { chat: "Coordinator", card: { id: "epic-1", title: "Relay rework" } });
    await callApi(ctx, "task.send", { chat: "Coordinator", card: { id: "codec", title: "Codec", pr: { url: "https://github.com/o/r/pull/612", state: "open", checks: "pending" }, tags: ["core", "web"], parent: "epic-1" } });
    expect((node.sendMessage.mock.calls[1]![0] as { card: StatusCard }).card).toMatchObject({ pr: { state: "open", checks: "pending" }, tags: ["core", "web"], parent: "epic-1" });
    const bad = (card: Record<string, unknown>) => callApi(ctx, "task.send", { chat: "Coordinator", card: { title: "x", ...card } });
    await expect(bad({ pr: { url: "https://github.com/o/r/pull/1", state: "approved" } })).rejects.toMatchObject({ code: "bad_request", message: /pr.state is one of/ });
    await expect(bad({ pr: { url: "https://github.com/o/r/pull/1", checks: "green" } })).rejects.toMatchObject({ code: "bad_request", message: /pr.checks is one of/ });
    await expect(bad({ tags: ["a", "b", "c", "d"] })).rejects.toMatchObject({ code: "bad_request", message: /tags is a list of at most 3/ });
    await expect(bad({ tags: ["x".repeat(25)] })).rejects.toMatchObject({ code: "bad_request", message: /at most 24/ });
    await expect(bad({ id: "self", parent: "self" })).rejects.toMatchObject({ code: "bad_request", message: /not its own/ });
    expect(node.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("refuse a parent that is no task of mine in that chat: the parent goes first", async () => {
    const { ctx, node } = fake();
    await expect(callApi(ctx, "task.send", { chat: "Coordinator", card: { title: "Codec", parent: "epic-1" } })).rejects.toMatchObject({ code: "not_found", message: /--parent: no task "epic-1" of yours in this chat/ });
    expect(node.sendMessage).not.toHaveBeenCalled();
    // A task of that id in another chat is not this chat's.
    await callApi(ctx, "task.send", { chat: "Sala de Máquinas", card: { id: "epic-1", title: "Relay rework" } });
    await expect(callApi(ctx, "task.send", { chat: "Coordinator", card: { title: "Codec", parent: "epic-1" } })).rejects.toMatchObject({ code: "not_found" });
    await expect(callApi(ctx, "task.send", { chat: "Sala de Máquinas", card: { title: "Codec", parent: "epic-1" } })).resolves.toMatchObject({ group: "g1" });
  });

  it("an update sets them, merges the pull request field by field, and replaces the tags", async () => {
    const { ctx, rows } = fake();
    await callApi(ctx, "task.send", { chat: "Coordinator", card: { id: "codec", title: "Codec", pr: { url: "https://github.com/o/r/pull/612", number: 612, state: "draft" }, tags: ["core"] } });
    vi.useFakeTimers({ now: Date.now() + CARD_UPDATE_GAP_MS });
    await callApi(ctx, "task.update", { chat: "Coordinator", task: "codec", card: { pr: { state: "open", checks: "passing" }, tags: ["web", "cli"] } });
    expect(rows("chat-one")[0]!.card).toMatchObject({ pr: { url: "https://github.com/o/r/pull/612", number: 612, state: "open", checks: "passing" }, tags: ["web", "cli"] });
  });
});

describe("task update", () => {
  it("merges the fields given over the card and edits its message; a field given as null goes", async () => {
    const { ctx, node, rows } = fake();
    await callApi(ctx, "task.send", { chat: "Coordinator", card: { id: "t1", title: "Fix", step: "Codec", pr: { url: "https://github.com/o/r/pull/1", number: 1 } } });
    vi.useFakeTimers({ now: Date.now() + CARD_UPDATE_GAP_MS });
    const result = await callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { progress: 50, step: null, pr: { additions: 12 } } }) as Record<string, unknown>;
    expect(result).toMatchObject({ chat: "chat-one", task: "t1", messageId: "me_1", queued: false, edits: 1 });
    expect(node.editMessage).toHaveBeenCalledTimes(1);
    const card = rows("chat-one")[0]!.card!;
    expect(card).toMatchObject({ kind: "task", id: "t1", title: "Fix", status: "running", progress: 50, pr: { url: "https://github.com/o/r/pull/1", number: 1, additions: 12 } });
    expect(card).not.toHaveProperty("step");
  });

  it("paces a card's updates in a daemon: those sooner than 2.5 s merge into one that goes when the time is up", async () => {
    const { ctx, node, rows } = fake("daemon");
    vi.useFakeTimers();
    await callApi(ctx, "task.send", { chat: "Coordinator", card: { id: "t1", title: "Fix" } });
    const first = await callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { progress: 10 } }) as Record<string, unknown>;
    const second = await callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { step: "Engine" } }) as Record<string, unknown>;
    expect([first.queued, second.queued]).toEqual([true, true]);
    expect(node.editMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CARD_UPDATE_GAP_MS);
    expect(node.editMessage).toHaveBeenCalledTimes(1);
    expect(rows("chat-one")[0]!.card).toMatchObject({ progress: 10, step: "Engine" });
    // The next one after the gap goes at once.
    await vi.advanceTimersByTimeAsync(CARD_UPDATE_GAP_MS);
    expect(await callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { status: "done", progress: 100 } })).toMatchObject({ queued: false, edits: 2 });
    expect(rows("chat-one")[0]!.card).toMatchObject({ status: "done", progress: 100, step: "Engine" });
  });

  it("sends an update still waiting for its time when the daemon stops, and never calls it confirmed before it went", async () => {
    const { ctx, node, rows } = fake("daemon");
    vi.useFakeTimers();
    await callApi(ctx, "task.send", { chat: "Coordinator", card: { id: "t1", title: "Nightly build", progress: 10 } });
    const done = await callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { status: "done", progress: 100 } }) as Record<string, unknown>;
    expect(done).toMatchObject({ queued: true, confirmed: false });
    expect(node.editMessage).not.toHaveBeenCalled();
    // The daemon stops before the gap is over: the task's last word still goes, once.
    await flushCardUpdates(ctx);
    expect(node.editMessage).toHaveBeenCalledTimes(1);
    expect(rows("chat-one")[0]!.card).toMatchObject({ status: "done", progress: 100 });
    await vi.advanceTimersByTimeAsync(CARD_UPDATE_GAP_MS);
    expect(node.editMessage).toHaveBeenCalledTimes(1);
  });

  it("in a one-shot, waits the gap out itself and sends", async () => {
    const { ctx, node } = fake("one-shot");
    vi.useFakeTimers();
    await callApi(ctx, "task.send", { chat: "Coordinator", card: { id: "t1", title: "Fix" } });
    const update = callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { progress: 30 } });
    await vi.advanceTimersByTimeAsync(CARD_UPDATE_GAP_MS);
    expect(await update).toMatchObject({ queued: false, edits: 1 });
    expect(node.editMessage).toHaveBeenCalledTimes(1);
  });

  it("finds only a task of mine by its id, and refuses an update out of bounds", async () => {
    const { ctx } = fake();
    await expect(callApi(ctx, "task.update", { chat: "Coordinator", task: "nope", card: {} })).rejects.toMatchObject({ code: "not_found" });
    await callApi(ctx, "task.send", { chat: "Coordinator", card: { id: "t1", title: "Fix" } });
    vi.useFakeTimers({ now: Date.now() + CARD_UPDATE_GAP_MS });
    await expect(callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { progress: 140 } })).rejects.toMatchObject({ code: "bad_request", message: /progress/ });
  });

  it("at a card's last update, says to start a new card", async () => {
    const { ctx, node, rows } = fake();
    await callApi(ctx, "task.send", { chat: "Coordinator", card: { id: "t1", title: "Fix" } });
    rows("chat-one")[0]!.edit = { seq: STATUS_CARD_LIMITS.edits, at: 1, history: [] };
    await expect(callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { progress: 1 } })).rejects.toMatchObject({ code: "refused", message: /start a new card with ghostly task send/ });
    expect(node.editMessage).not.toHaveBeenCalled();
  });

  it("updates a group's task", async () => {
    const { ctx, node } = fake();
    await callApi(ctx, "task.send", { chat: "g1", card: { id: "t1", title: "Fix" } });
    vi.useFakeTimers({ now: Date.now() + CARD_UPDATE_GAP_MS });
    expect(await callApi(ctx, "task.update", { chat: "g1", task: "t1", card: { progress: 60 } })).toMatchObject({ group: "g1", task: "t1", edits: 1 });
    expect(node.editMessage).toHaveBeenCalledWith(expect.objectContaining({ linkId: "group:g1", messageId: "me_1" }));
  });
});

describe("task remove", () => {
  it("deletes every message of mine with that task's card for everyone, in a chat or a group; nothing else", async () => {
    const { ctx, node, rows } = fake();
    const first = await callApi(ctx, "task.send", { chat: "Coordinator", card: { title: "Old run", id: "relay" } }) as { messageId: string };
    const again = await callApi(ctx, "task.send", { chat: "Coordinator", card: { title: "New run", id: "relay" } }) as { messageId: string };
    await callApi(ctx, "task.send", { chat: "Coordinator", card: { title: "Another", id: "other" } });
    await callApi(ctx, "routine.send", { chat: "Coordinator", card: { id: "relay", name: "Nightly", schedule: "every day 01:00", state: "active" } });
    rows("chat-one").push({ linkId: "chat-one", id: "peer_x", text: "theirs", sender: "peer", timestamp: 1, via: "datalink", card: { kind: "task", id: "relay", title: "Theirs", status: "running" } as StatusCard });
    expect(params("task remove", ["Coordinator", "relay"])).toEqual({ chat: "Coordinator", task: "relay", all: false });
    expect(await callApi(ctx, "task.remove", { chat: "Coordinator", task: "relay" })).toEqual({ chat: "chat-one", task: "relay", tasks: ["relay"], removed: [first.messageId, again.messageId] });
    expect(node.removeMessage).toHaveBeenCalledTimes(2);
    expect(rows("chat-one").map((m) => m.card?.kind === "routine" ? "routine" : m.card?.id)).toEqual(["other", "routine", "relay"]);
    // Gone: an update or a second removal finds nothing.
    await expect(callApi(ctx, "task.update", { chat: "Coordinator", task: "relay", card: { progress: 50 } })).rejects.toMatchObject({ code: "not_found" });
    await expect(callApi(ctx, "task.remove", { chat: "Coordinator", task: "relay" })).rejects.toMatchObject({ code: "not_found" });
    // A group's, by its name.
    const inGroup = await callApi(ctx, "task.send", { chat: "Sala de Máquinas", card: { title: "Group task", id: "g-task" } }) as { messageId: string };
    expect(await callApi(ctx, "task.remove", { chat: "Sala de Máquinas", task: "g-task" })).toEqual({ group: "g1", task: "g-task", tasks: ["g-task"], removed: [inGroup.messageId] });
    expect(node.removeMessage).toHaveBeenLastCalledWith({ linkId: "group:g1", messageId: inGroup.messageId });
  });

  it("--all takes every task card of mine there, and routine remove a routine's; a task or --all, not both or neither", async () => {
    const { ctx, rows } = fake();
    for (const id of ["a", "b"]) await callApi(ctx, "task.send", { chat: "Coordinator", card: { title: id, id } });
    await callApi(ctx, "routine.send", { chat: "Coordinator", card: { id: "nightly", name: "Nightly", schedule: "every day 01:00", state: "active" } });
    expect(params("task remove", ["Coordinator", "--all"])).toEqual({ chat: "Coordinator", task: undefined, all: true });
    expect(await callApi(ctx, "task.remove", { chat: "Coordinator", all: true })).toMatchObject({ chat: "chat-one", tasks: ["a", "b"], removed: expect.any(Array) });
    expect(rows("chat-one").map((m) => m.card?.kind)).toEqual(["routine"]);
    // Nothing left: --all says so with an empty list, not an error.
    expect(await callApi(ctx, "task.remove", { chat: "Coordinator", all: true })).toEqual({ chat: "chat-one", tasks: [], removed: [] });
    expect(await callApi(ctx, "routine.remove", { chat: "Coordinator", routine: "nightly" })).toMatchObject({ routine: "nightly", removed: [expect.any(String)] });
    expect(rows("chat-one")).toEqual([]);
    await expect(callApi(ctx, "task.remove", { chat: "Coordinator" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(callApi(ctx, "task.remove", { chat: "Coordinator", task: "a", all: true })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("an update of the card still waiting for its time goes nowhere once it is removed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { ctx, node } = fake();
    await callApi(ctx, "task.send", { chat: "Coordinator", card: { title: "T", id: "t" } });
    // Sooner than the gap after it was sent: it waits for its time.
    expect(await callApi(ctx, "task.update", { chat: "Coordinator", task: "t", card: { progress: 20 } })).toMatchObject({ queued: true });
    await callApi(ctx, "task.remove", { chat: "Coordinator", task: "t" });
    await vi.advanceTimersByTimeAsync(CARD_UPDATE_GAP_MS * 2);
    expect(node.editMessage).not.toHaveBeenCalled();
    // Nothing is left to flush when the daemon stops.
    await flushCardUpdates(ctx);
    expect(node.editMessage).not.toHaveBeenCalled();
  });
});

describe("a card's update in a long chat", () => {
  const wholeReads = (node: ReturnType<typeof fake>["node"]) => node.getMessages.mock.calls.length + node.groupMessages.mock.calls.length;

  it("reads the card's own message, never the history, for a card this process sent: a chat's and a group's", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { ctx, node } = fake();
    for (const chat of ["Coordinator", "g1"]) {
      await callApi(ctx, "task.send", { chat, card: { id: "t1", title: "Fix" } });
      await callApi(ctx, "routine.send", { chat, card: { id: "r1", name: "Nightly", schedule: "every day 01:00" } });
    }
    expect(wholeReads(node)).toBe(0);
    for (const chat of ["Coordinator", "g1"]) {
      vi.setSystemTime(Date.now() + CARD_UPDATE_GAP_MS);
      expect(await callApi(ctx, "task.update", { chat, task: "t1", card: { progress: 60 } })).toMatchObject({ task: "t1", queued: false, edits: 1 });
      expect(await callApi(ctx, "routine.update", { chat, routine: "r1", card: {}, run: { result: "ok" } })).toMatchObject({ routine: "r1", queued: false, edits: 1 });
    }
    expect(node.editMessage).toHaveBeenCalledTimes(4);
    expect(wholeReads(node)).toBe(0);
  });

  it("looks a card it has not seen yet up in the history once, then no more", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { ctx, node, rows } = fake();
    // Sent by an earlier run of the daemon: this one never saw it.
    rows("chat-one").push({ linkId: "chat-one", id: "me_old", text: "fallback", sender: "me", timestamp: Date.now() - 60_000, via: "datalink", delivery: "sent", card: { kind: "task", id: "t1", title: "Fix", status: "running" } });
    for (let update = 1; update <= 3; update++) {
      vi.setSystemTime(Date.now() + CARD_UPDATE_GAP_MS);
      expect(await callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { progress: update } })).toMatchObject({ messageId: "me_old", edits: update });
    }
    expect(wholeReads(node)).toBe(1);
  });

  it("goes to the newest card of an id, also one these commands did not send, and to the one before when that is deleted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ghostly-cards-"));
    await openPersistentIndexedDb(join(dir, "db"));
    vi.useFakeTimers({ toFake: ["Date"] });
    const { ctx, node, rows, store } = fake();
    // The daemon's own event stream: a message of mine stored by something else (`engine call`) is said there.
    const hub = new EventHub(join(dir, "events.jsonl"), Date.now, "cards.jsonl");
    await hub.open();
    hub.baseline(node.getState(), new Map());
    (ctx as { hub: EventHub }).hub = hub;
    const stored = (linkId: string, card: StatusCard) => {
      const id = store(linkId, "fallback", card);
      hub.sink.post({ kind: "messages", linkId, messages: rows(linkId) });
      return id;
    };
    const update = async (chat: string) => { vi.setSystemTime(Date.now() + CARD_UPDATE_GAP_MS); return callApi(ctx, "task.update", { chat, task: "t1", card: { step: "next" } }); };
    for (const [chat, linkId] of [["Coordinator", "chat-one"], ["g1", "group:g1"]] as const) {
      const first = (await callApi(ctx, "task.send", { chat, card: { id: "t1", title: "Fix" } }) as { messageId: string }).messageId;
      expect(await update(chat)).toMatchObject({ messageId: first });
      vi.setSystemTime(Date.now() + 1);
      const second = stored(linkId, { kind: "task", id: "t1", title: "Fix again", status: "running" });
      expect(await update(chat)).toMatchObject({ messageId: second, card: { title: "Fix again" } });
      expect(wholeReads(node)).toBe(0);
      // The newest is deleted: the history says the one before stands for the id again.
      rows(linkId).splice(rows(linkId).findIndex((m) => m.id === second), 1);
      expect(await update(chat)).toMatchObject({ messageId: first, card: { title: "Fix" } });
      expect(await update(chat)).toMatchObject({ messageId: first });
      expect(wholeReads(node)).toBe(1);
      node.getMessages.mockClear(); node.groupMessages.mockClear();
    }
    // Another chat's card of the same id is not this chat's.
    await expect(callApi(ctx, "task.update", { chat: "Coordinator", task: "t2", card: {} })).rejects.toMatchObject({ code: "not_found" });
    stored("group:g1", { kind: "task", id: "t2", title: "Elsewhere", status: "running" });
    await expect(callApi(ctx, "task.update", { chat: "Coordinator", task: "t2", card: {} })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("routines", () => {
  it("take their fields and a run from flags", () => {
    expect(params("routine send", ["g1", "--name", "Nightly bug hunt", "--schedule", "every day 01:00", "--cron", "0 1 * * *", "--next", "2026-09-30T01:00:00Z", "--run", "ok:12 issues checked"])).toEqual({
      chat: "g1", text: undefined, force: false, wait: undefined, timeout: undefined, run: { result: "ok", summary: "12 issues checked" },
      card: { name: "Nightly bug hunt", schedule: "every day 01:00", cron: "0 1 * * *", nextRunAt: Date.UTC(2026, 8, 30, 1, 0) },
    });
    expect(params("routine update", ["g1", "nightly", "--run", "failed", "--state", "paused"])).toMatchObject({ routine: "nightly", run: { result: "failed" }, card: { state: "paused" } });
    expect(() => params("routine update", ["g1", "nightly", "--run", "maybe"])).toThrow(/--run takes ok, failed or skipped/);
    expect(() => params("routine update", ["g1", "nightly", "--next", "someday"])).toThrow(/--next takes a time/);
    // Unix seconds are refused with the milliseconds they mean: they were a card dated January 1970.
    expect(() => params("routine send", ["g1", "--name", "Backup", "--schedule", "every hour", "--next", "1791849403"])).toThrow(expect.objectContaining({ code: "usage", message: "--next takes milliseconds, not seconds: 1791849403000" }));
    expect(params("routine update", ["g1", "nightly", "--next", "1791849403000"])).toMatchObject({ card: { nextRunAt: 1791849403000 } });
    expect(() => params("routine send", ["g1"])).toThrow(expect.objectContaining({ code: "usage", message: expect.stringMatching(/^--name and --schedule are needed/) }));
    expect(() => params("routine send", ["g1", "--name", "Nightly"])).toThrow(expect.objectContaining({ code: "usage", message: expect.stringMatching(/^--schedule is needed/) }));
  });

  it("send a routine active from now, and each run becomes the last and the newest of ten recent ones", async () => {
    const { ctx, node, rows } = fake();
    const next = Date.now() + 3_600_000;
    expect(await callApi(ctx, "routine.send", { chat: "Coordinator", card: { id: "nightly", name: "Nightly", schedule: "every day 01:00", nextRunAt: next } })).toMatchObject({ chat: "chat-one", routine: "nightly" });
    expect(node.sendMessage.mock.calls[0]![0]).toMatchObject({ card: { kind: "routine", id: "nightly", state: "active", nextRunAt: next } });
    vi.useFakeTimers({ now: Date.now() });
    for (let i = 0; i < 12; i++) {
      vi.setSystemTime(Date.now() + CARD_UPDATE_GAP_MS);
      await callApi(ctx, "routine.update", { chat: "Coordinator", routine: "nightly", card: {}, run: { result: i % 2 ? "ok" : "failed", summary: `run ${i}` } });
    }
    const card = rows("chat-one")[0]!.card as { lastRun: { summary: string }; runs: { summary: string }[] };
    expect(card.lastRun.summary).toBe("run 11");
    expect(card.runs.map(r => r.summary)).toEqual(Array.from({ length: 10 }, (_, i) => `run ${11 - i}`));
    await expect(callApi(ctx, "routine.update", { chat: "Coordinator", routine: "nightly", card: { state: "sleeping" } })).rejects.toMatchObject({ code: "bad_request", message: /state is one of/ });
  });
});

describe("mergeCard", () => {
  it("never changes a card's kind or id", () => {
    expect(mergeCard({ kind: "task", id: "a", title: "x" }, { kind: "routine", id: "b", title: "y" })).toEqual({ kind: "task", id: "a", title: "y" });
  });
});
