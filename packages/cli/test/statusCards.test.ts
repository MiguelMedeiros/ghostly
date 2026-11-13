import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { STATUS_CARD_LIMITS, checkStatusCard, type StatusCard } from "@ghostly/core";
import { callApi, type ApiContext } from "../src/api";
import { parseArgs } from "../src/args";
import { EventHub, type GhostlyEvent } from "../src/events";
import { openPersistentIndexedDb } from "../src/runtime/storage";
import { COMMANDS, idSlot, positionals } from "../src/commands";
import { chatOnly } from "../src/main";
import { CARD_UPDATE_GAP_MS, flushCardUpdates, mergeCard } from "../src/statusCards";
// covers: headless.status-cards

/** `task send` and `task update` (WISP 405 · Status Cards) against an engine that keeps what it is sent. */
const link = (id: string, fields: Partial<LinkView> = {}) => ({ id, peerPubKeyZ32: "p" + id, createdAt: 1, lastMessageAt: 0, profile: "paired-chat/1", textDelivery: "stream", pairing: { status: "ready" }, ...fields }) as unknown as LinkView;
const group = (fields: Partial<GroupView> = {}) => ({ id: "g1", name: "Sala de Máquinas", createdAt: 1, profile: "mesh", isAdmin: false, canSend: true, lastMessageAt: 0, invited: [], memberLinks: {},
  members: [{ key: "mekey", role: "member", me: true, online: true, missing: 0 }], ...fields }) as unknown as GroupView;

/**
 * `out.delivery`: what a new message's delivery is (default `sent`); `out.pending`: an edit waits for the contact's
 * confirmation. `emit` tells the commands' waits a message changed, as the engine's events do.
 */
function fake(mode: "daemon" | "one-shot" = "daemon", out: { delivery?: StoredMessage["delivery"]; pending?: boolean } = {}) {
  const rows = new Map<string, StoredMessage[]>();
  const of = (linkId: string) => rows.get(linkId) ?? rows.set(linkId, []).get(linkId)!;
  let n = 0;
  const store = (linkId: string, text: string, card?: StatusCard) => {
    const id = `me_${++n}`;
    of(linkId).push({ linkId, id, wireId: `w${n}`, text, sender: "me", timestamp: Date.now(), via: "datalink", delivery: out.delivery ?? "sent", ...(card && { card }) });
    return id;
  };
  const listeners = new Set<(event: GhostlyEvent) => void>();
  const emit = (event: GhostlyEvent) => { for (const listener of listeners) listener(event); };
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
      row.edit = { seq: (row.edit?.seq ?? 0) + 1, at: Date.now(), history: [], ...(out.pending && { pending: true }) };
      return { error: null, messageId };
    }),
    groupTaken: vi.fn(() => 1),
  };
  const onEvent = (listener: (event: GhostlyEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode, version: "test" } as unknown as ApiContext;
  return { ctx, node, rows: of, store, emit };
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
    // Before, these reached the card's check: bad_request (exit 1), "Status card: pr.number is a whole number from 1".
    const pr = (...flags: string[]) => send("--pr-url", "https://x.example/1", ...flags);
    usage("task send", pr("--pr-number", "1.5"), /^--pr-number takes a whole number from 1 to 1000000000, not 1.5$/);
    usage("task send", pr("--pr-number", "0"), /^--pr-number takes a whole number from 1 to 1000000000, not 0$/);
    for (const flag of ["additions", "deletions", "files"]) usage("task send", pr(`--${flag}`, "-3"), new RegExp(`^--${flag} takes a whole number from 0 to 1000000000, not -3$`));
    usage("task update", ["g1", "t", "--additions", "2.5"], /^--additions takes a whole number from 0 to 1000000000, not 2.5$/);
    usage("task send", send("--steps", "99999999999999999999/99999999999999999999"), /^--steps takes done\/total of at most 1000000000 steps, like 2\/5, not "99999999999999999999\/99999999999999999999"$/);
    expect(params("task send", pr("--pr-number", "7", "--additions", "0", "--files", "1000000000", "--steps", "1000000000/1000000000")).card).toMatchObject({ pr: { number: 7, additions: 0, files: 1e9 }, done: 1e9, total: 1e9 });
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

  it("refuse a wrong status or a text too long or blank as a usage error (exit 2) that names the flag, not the card's field", () => {
    // Before, these reached the card's check: bad_request (exit 1), "Status card: title is at most 120 characters".
    const usage = (name: string, argv: string[], message: RegExp) => expect(() => params(name, argv)).toThrow(expect.objectContaining({ code: "usage", message: expect.stringMatching(message) }));
    const send = (...flags: string[]) => ["g1", "--title", "Build", ...flags];
    usage("task send", send("--status", "weird"), /^--status takes queued, running, blocked, done, failed or cancelled, not "weird"$/);
    usage("task update", ["g1", "t", "--status", "weird"], /^--status takes queued, running, blocked, done, failed or cancelled, not "weird"$/);
    usage("task send", ["g1", "--title", "x".repeat(130)], /^--title takes at most 120 characters, not 130$/);
    usage("task update", ["g1", "t", "--title", "   "], /^--title takes text, not " {3}"$/);
    usage("task send", send("--step", "x".repeat(210)), /^--step takes at most 200 characters, not 210$/);
    usage("task update", ["g1", "t", "--step", ""], /^--step takes text, not ""$/);
    usage("task send", send("--branch", "b".repeat(300)), /^--branch takes at most 120 characters, not 300$/);
    usage("task send", send("--tag", "t".repeat(30)), /^--tag takes at most 24 characters, not 30$/);
    usage("task send", send("--tag", "web", "--tag", " web "), /^--tag "web" is given twice$/);
    usage("task send", send("--item", `done:${"i".repeat(300)}`), /^--item's text takes at most 200 characters, not 300$/);
    usage("task send", send("--item", "i".repeat(201)), /^--item's text takes at most 200 characters, not 201$/);
    usage("task send", send("--item", "done:"), /^--item's text takes text, not "done:"$/);
    usage("task send", send(...Array.from({ length: 21 }, (_, i) => ["--item", `step ${i}`]).flat()), /^--item is given at most 20 times, not 21$/);
    usage("task send", send("--link", `${"l".repeat(100)}=https://x.com`), /^--link's label takes at most 40 characters, not 100$/);
    usage("task send", send("--link", "notaurl"), /^--link takes an https link of at most 512 characters, or label=link, not "notaurl"$/);
    usage("task send", send(...Array.from({ length: 5 }, (_, i) => ["--link", `https://x.com/${i}`]).flat()), /^--link is given at most 4 times, not 5$/);
    // A character the card counts as one counts as one here; --json keeps the card's words for the card's check.
    expect(params("task send", ["g1", "--title", "🚀".repeat(120)]).card).toEqual({ title: "🚀".repeat(120) });
    expect(params("task send", send("--json", `{"step":"${"x".repeat(210)}","status":"weird"}`)).card).toMatchObject({ status: "weird" });
  });

  it("refuse a card past 8 KiB in all as a usage error with its size, though each flag is within its own bound", () => {
    // Before, 20 items of 200 CJK characters (3 bytes each) passed every flag and failed as bad_request (exit 1),
    // "Status card: The card takes 12529 bytes; at most 8192", the whole card in its details.
    const items = (n: number, text: string) => Array.from({ length: n }, () => ["--item", `done:${text}`]).flat();
    const big = /^The card takes \d+ bytes, and holds at most 8192 in all \(a character past Latin takes 2 to 4\): give shorter or fewer --item, --step, --link or --json$/;
    expect(() => params("task send", ["g1", "--title", "t", ...items(20, "日".repeat(200))])).toThrow(expect.objectContaining({ code: "usage", message: expect.stringMatching(big), details: undefined }));
    expect(() => params("task update", ["g1", "t", ...items(20, "日".repeat(200))])).toThrow(expect.objectContaining({ code: "usage", message: expect.stringMatching(big) }));
    expect(() => params("routine send", ["g1", "--name", "n", "--schedule", "s", "--json", JSON.stringify({ x: "日".repeat(3000) })])).toThrow(expect.objectContaining({ code: "usage", message: expect.stringMatching(/bytes, and holds at most 8192 in all .*--name, --schedule, --link or --json$/) }));
    expect(() => params("usage send", ["g1", "--left", "5", "--json", JSON.stringify({ x: "日".repeat(3000) })])).toThrow(expect.objectContaining({ code: "usage", message: expect.stringMatching(/give shorter or fewer --json$/) }));
    expect((params("task send", ["g1", "--title", "t", ...items(20, "x".repeat(200))]).card as { items: unknown[] }).items).toHaveLength(20);
    expect((params("task send", ["g1", "--title", "t", ...items(11, "日".repeat(200))]).card as { items: unknown[] }).items).toHaveLength(11);
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
    // A card too big is said by its size, not echoed back whole.
    const big = callApi(ctx, "task.send", { chat: "Coordinator", card: { title: "x", step: "日".repeat(3000) } });
    await expect(big).rejects.toMatchObject({ code: "bad_request", message: /^Status card: The card takes \d+ bytes; at most 8192$/, details: { bytes: expect.any(Number), max: 8192 } });
    expect(node.sendMessage).not.toHaveBeenCalled();
  });
});

describe("the card commands in a chat, without a daemon", () => {
  /** The message goes out (and the contact has it) 300 ms after the command, as a one-shot's first dial carries it. */
  const goesOut = (f: ReturnType<typeof fake>, id: string, delivery: StoredMessage["delivery"] = "delivered") => setTimeout(() => {
    f.rows("chat-one").find((m) => m.id === id)!.delivery = delivery;
    f.emit({ seq: 1, id: "e1", type: "message.delivery", at: Date.now(), chat: "chat-one", messageId: id });
  }, 300);
  const goesOff = "goes with this profile's next command, or keep it online with `ghostly daemon --detach`";

  it("task send and routine send stay until the card went out: the process leaving took it along unsent", async () => {
    // Before, both answered at once with `delivery: waiting`, and the contact had the card only with a later one-shot.
    for (const [method, card] of [["task.send", { id: "t1", title: "Fix" }], ["routine.send", { id: "r1", name: "Nightly", schedule: "every day 01:00" }]] as const) {
      const f = fake("one-shot", { delivery: "waiting" });
      goesOut(f, "me_1");
      const started = Date.now();
      expect(await callApi(f.ctx, method, { chat: "Coordinator", card })).toMatchObject({ chat: "chat-one", messageId: "me_1", delivery: "delivered" });
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    }
  });

  it("time out with the shared words (exit 4); --wait none answers at once; a daemon and a group answer at once", async () => {
    await expect(callApi(fake("one-shot", { delivery: "waiting" }).ctx, "task.send", { chat: "Coordinator", card: { title: "Fix" }, timeout: 1 })).rejects.toMatchObject({
      code: "timeout", message: `Timed out after 1 s: the message is waiting and ${goesOff}`,
    });
    expect(await callApi(fake("one-shot", { delivery: "waiting" }).ctx, "task.send", { chat: "Coordinator", card: { title: "Fix" }, wait: "none" })).toMatchObject({ delivery: "waiting" });
    expect(await callApi(fake("daemon", { delivery: "waiting" }).ctx, "task.send", { chat: "Coordinator", card: { title: "Fix" } })).toMatchObject({ delivery: "waiting" });
    // A group has no receipts: a group's card keeps answering at once (`--wait sent` waits for an edge).
    const group = fake("one-shot");
    group.node.groupTaken.mockReturnValue(0);
    expect(await callApi(group.ctx, "task.send", { chat: "g1", card: { title: "Fix" } })).toMatchObject({ group: "g1", messageId: "me_1" });
  });

  it("task update and routine update stay until the contact confirmed the edit; --wait none does not", async () => {
    vi.useFakeTimers();
    const f = fake("one-shot", { pending: true });
    await callApi(f.ctx, "task.send", { chat: "Coordinator", card: { id: "t1", title: "Fix" }, wait: "none" });
    const update = callApi(f.ctx, "task.update", { chat: "Coordinator", task: "t1", card: { status: "done" } });
    let answered = false;
    void update.then(() => { answered = true; }, () => { answered = true; });
    await vi.advanceTimersByTimeAsync(CARD_UPDATE_GAP_MS + 1_000);
    // Before, it answered as soon as the edit was made, with `confirmed: false`, and the process left with it.
    expect(answered).toBe(false);
    delete f.rows("chat-one")[0]!.edit!.pending;
    await vi.advanceTimersByTimeAsync(300);
    expect(await update).toMatchObject({ task: "t1", edits: 1, confirmed: true });
    const none = callApi(f.ctx, "task.update", { chat: "Coordinator", task: "t1", card: { progress: 100 }, wait: "none" });
    await vi.advanceTimersByTimeAsync(CARD_UPDATE_GAP_MS);
    expect(await none).toMatchObject({ edits: 2, confirmed: false });
    await callApi(f.ctx, "routine.send", { chat: "Coordinator", card: { id: "r1", name: "Nightly", schedule: "every day 01:00" }, wait: "none" });
    const routine = callApi(f.ctx, "routine.update", { chat: "Coordinator", routine: "r1", card: {}, run: { result: "ok" }, timeout: 1 });
    const said = expect(routine).rejects.toMatchObject({ code: "timeout", message: `Timed out after 1 s: the contact has not confirmed the edit yet (it needs a live chat and a contact's app that shows edits). It ${goesOff}` });
    await vi.advanceTimersByTimeAsync(CARD_UPDATE_GAP_MS + 1_500);
    await said;
  });

  it("usage send stays until its report went out: the first one sent, a later one confirmed", async () => {
    const f = fake("one-shot", { delivery: "waiting", pending: true });
    goesOut(f, "me_1");
    expect(await callApi(f.ctx, "usage.send", { chat: "Coordinator", card: { left: 62 } })).toMatchObject({ messageId: "me_1", delivery: "delivered", updated: false });
    setTimeout(() => { delete f.rows("chat-one")[0]!.edit!.pending; }, CARD_UPDATE_GAP_MS + 300);
    expect(await callApi(f.ctx, "usage.send", { chat: "Coordinator", card: { left: 40 } })).toMatchObject({ messageId: "me_1", edits: 1, confirmed: true, updated: true });
    expect(await callApi(fake("one-shot", { delivery: "waiting" }).ctx, "usage.send", { chat: "Coordinator", card: { left: 62 }, wait: "none" })).toMatchObject({ delivery: "waiting" });
  }, 15_000);

  it("say so in their help: the default is none with a daemon, and waits without one in a chat", () => {
    // Before, task send and routine send said "sent without" a daemon and sent nothing; usage send said none.
    for (const name of ["task send", "routine send"]) expect(COMMANDS[name]!.options!.wait!.description).toBe("none, sent or delivered; in a group none or sent: until an edge took it (default: none with a daemon; without one, sent in a chat and none in a group)");
    for (const name of ["task update", "routine update"]) expect(COMMANDS[name]!.options!.wait!.description).toBe("none, confirmed (a chat's contact took it) or sent (a group's edge took it) (default: none with a daemon; without one, confirmed in a chat and none in a group)");
    expect(COMMANDS["usage send"]!.options!.wait!.description).toBe("none or sent: until the contact has it in a chat, an edge took it in a group (default: none with a daemon; without one, sent in a chat and none in a group)");
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
    // A login to a node is named as one.
    await expect(callApi(ctx, "task.send", { chat: "Coordinator", card: { title: "Node", step: `__cookie__:${"01".repeat(32)}` } }))
      .rejects.toMatchObject({ code: "confirm", details: { kind: "node-login" }, message: /looks like a secret \(a login to a node.*send it with --force/ });
    expect(node.sendMessage).not.toHaveBeenCalled();
    expect(node.sendGroupMessage).not.toHaveBeenCalled();
    await expect(callApi(ctx, "task.send", { chat: "Coordinator", card: { id: "t1", title: "Deploy", step: seed }, force: true })).resolves.toMatchObject({ task: "t1" });
    expect(node.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("refuses an update that brings one, and not one for the text the card already had", async () => {
    vi.useFakeTimers();
    const { ctx, node } = fake("one-shot");
    await callApi(ctx, "task.send", { chat: "Coordinator", card: { id: "t1", title: "Deploy", step: seed }, force: true, wait: "none" });
    await expect(callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { step: `seed: ${seed}` } })).rejects.toMatchObject({ code: "confirm", message: /update it with --force/ });
    await callApi(ctx, "routine.send", { chat: "Coordinator", card: { id: "r1", name: "Nightly", schedule: "every day 01:00" }, wait: "none" });
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

  it("refuses a --text past 16 KiB as send does, with its size, before the guard reads it: every card command, chat and group", async () => {
    vi.useFakeTimers();
    const { ctx, node } = fake("one-shot");
    await callApi(ctx, "task.send", { chat: "Coordinator", card: { id: "t1", title: "Deploy" }, wait: "none" });
    await callApi(ctx, "routine.send", { chat: "Sala de Máquinas", card: { id: "r1", name: "Nightly", schedule: "every day 01:00" } });
    node.sendMessage.mockClear(); node.sendGroupMessage.mockClear();
    // A seed past the limit: the size is said, not "looks like a secret" (a --force would not send it either).
    const text = `${seed} ${"é".repeat(8193)}`;
    const bytes = new TextEncoder().encode(text).length;
    const tooLong = { code: "bad_request", message: expect.stringMatching(/exceeds 16384 UTF-8 bytes/), details: { bytes, max: 16384 } };
    for (const chat of ["Coordinator", "Sala de Máquinas"]) {
      await expect(callApi(ctx, "task.send", { chat, card: { title: "Deploy" }, text })).rejects.toMatchObject(tooLong);
      await expect(callApi(ctx, "routine.send", { chat, card: { name: "Nightly", schedule: "every day 01:00" }, text })).rejects.toMatchObject(tooLong);
      await expect(callApi(ctx, "usage.send", { chat, card: { left: 40 }, text })).rejects.toMatchObject(tooLong);
    }
    await expect(callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { status: "done" }, text })).rejects.toMatchObject(tooLong);
    await expect(callApi(ctx, "routine.update", { chat: "Sala de Máquinas", routine: "r1", card: {}, text })).rejects.toMatchObject(tooLong);
    // `--all` says it once, with its size, not once per chat.
    await expect(callApi(ctx, "usage.send", { all: true, card: { left: 40 }, text })).rejects.toMatchObject(tooLong);
    expect(node.sendMessage).not.toHaveBeenCalled();
    expect(node.sendGroupMessage).not.toHaveBeenCalled();
    expect(node.editMessage).not.toHaveBeenCalled();
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

  it("says how far a task is one way: a percent given replaces the card's steps, steps given replace its percent", async () => {
    const { ctx, rows } = fake();
    await callApi(ctx, "task.send", { chat: "Coordinator", card: { id: "t1", title: "Fix", done: 2, total: 5 } });
    vi.useFakeTimers({ now: Date.now() + CARD_UPDATE_GAP_MS });
    await callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { progress: 90 } });
    expect(rows("chat-one")[0]!.card).toMatchObject({ progress: 90 });
    expect(rows("chat-one")[0]!.card).not.toHaveProperty("done");
    expect(rows("chat-one")[0]!.card).not.toHaveProperty("total");
    vi.setSystemTime(Date.now() + CARD_UPDATE_GAP_MS);
    // Before, the 90 stayed: the card showed "90% · 4 of 5 steps", its bar at 90.
    await callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { done: 4, total: 5 } });
    expect(rows("chat-one")[0]!.card).toMatchObject({ done: 4, total: 5 });
    expect(rows("chat-one")[0]!.card).not.toHaveProperty("progress");
    // Both given at once (`--json`) stay as given; a step's text alone leaves either.
    vi.setSystemTime(Date.now() + CARD_UPDATE_GAP_MS);
    await callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { progress: 85, done: 4, total: 5 } });
    vi.setSystemTime(Date.now() + CARD_UPDATE_GAP_MS);
    await callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { step: "Tests" } });
    expect(rows("chat-one")[0]!.card).toMatchObject({ progress: 85, done: 4, total: 5, step: "Tests" });
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

  it("an update merged into the next goes with the newest update's text, not the first's", async () => {
    const { ctx, node } = fake("daemon");
    vi.useFakeTimers();
    await callApi(ctx, "task.send", { chat: "Coordinator", card: { id: "t1", title: "Fix" } });
    await callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { progress: 10 }, text: "Working: 10%" });
    await callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { status: "done", progress: 100 }, text: "Done!" });
    await vi.advanceTimersByTimeAsync(CARD_UPDATE_GAP_MS);
    // Before, the card said done and its text "Working: 10%" (what an app without cards and a notification show).
    expect(node.editMessage).toHaveBeenCalledTimes(1);
    expect(node.editMessage.mock.calls[0]![0]).toMatchObject({ text: "Done!", card: { status: "done", progress: 100 } });
    // One with no --text after one with it: the engine writes the text from the card, not the older words.
    await callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { step: "Ship" }, text: "Shipping" });
    await callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { step: "Shipped" } });
    await vi.advanceTimersByTimeAsync(CARD_UPDATE_GAP_MS);
    expect(node.editMessage).toHaveBeenCalledTimes(2);
    expect(node.editMessage.mock.calls[1]![0]).toMatchObject({ text: "", card: { step: "Shipped" } });
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
    await callApi(ctx, "task.send", { chat: "Coordinator", card: { id: "t1", title: "Fix" }, wait: "none" });
    const update = callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { progress: 30 } });
    await vi.advanceTimersByTimeAsync(CARD_UPDATE_GAP_MS);
    expect(await update).toMatchObject({ queued: false, edits: 1 });
    expect(node.editMessage).toHaveBeenCalledTimes(1);
  });

  it("after the device's clock went back, an update waits at most the gap, never the jump, and its updatedAt is not before startedAt", async () => {
    // Before, the wait was the card's last edit + 2.5 s on the moved clock: 4 min here, the profile held all along.
    for (const mode of ["one-shot", "daemon"] as const) {
      const { ctx, node, rows } = fake(mode);
      vi.useFakeTimers();
      await callApi(ctx, "task.send", { chat: "Coordinator", card: { id: "t1", title: "Fix" }, wait: "none" });
      await callApi(ctx, "routine.send", { chat: "Coordinator", card: { id: "r1", name: "Nightly", schedule: "every day 01:00" }, run: { result: "ok" }, wait: "none" });
      const startedAt = rows("chat-one")[0]!.card!.kind === "task" ? (rows("chat-one")[0]!.card as { startedAt: number }).startedAt : 0;
      vi.setSystemTime(Date.now() - 4 * 60_000);
      const task = callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { progress: 30 }, wait: "none" });
      const routine = callApi(ctx, "routine.update", { chat: "Coordinator", routine: "r1", card: {}, run: { result: "failed" }, wait: "none" });
      await vi.advanceTimersByTimeAsync(CARD_UPDATE_GAP_MS);
      await Promise.all([task, routine]);
      expect(node.editMessage, mode).toHaveBeenCalledTimes(2);
      expect((rows("chat-one")[0]!.card as { updatedAt: number }).updatedAt).toBeGreaterThanOrEqual(startedAt);
      expect(rows("chat-one")[1]!.card).toMatchObject({ lastRun: { result: "failed" } });
      vi.useRealTimers();
    }
  });

  it("after the clock went back past the skew, says the device's clock went back, not that a time is in the future", async () => {
    const { ctx, node } = fake();
    vi.useFakeTimers();
    await callApi(ctx, "task.send", { chat: "Coordinator", card: { id: "t1", title: "Fix" } });
    await callApi(ctx, "routine.send", { chat: "Coordinator", card: { id: "r1", name: "Nightly", schedule: "every day 01:00" }, run: { result: "ok" } });
    vi.setSystemTime(Date.now() - 3_600_000);
    // Before: "Status card: startedAt is a time in milliseconds, not in the future", a field the bot never set.
    await expect(callApi(ctx, "task.update", { chat: "Coordinator", task: "t1", card: { status: "failed" } })).rejects.toMatchObject({
      code: "bad_request", message: "This device's clock went back since the task was sent: its startedAt is later than now. Update it once the clock is right, or start a new card with ghostly task send" });
    await expect(callApi(ctx, "routine.update", { chat: "Coordinator", routine: "r1", card: {}, run: { result: "ok" } })).rejects.toMatchObject({
      code: "bad_request", message: expect.stringMatching(/^This device's clock went back since the routine was sent: its lastRun\.at is later than now/) });
    expect(node.editMessage).not.toHaveBeenCalled();
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

  // The fake's group has nobody but me: a card and its update answered `edges: 0` at once and said nothing more.
  it("says nobody gets a group's card or its update when nobody else is in the group", async () => {
    const { ctx, node } = fake("one-shot");
    node.groupTaken.mockReturnValue(0);
    const nobody = (what: string) => `Nobody else is in this group: nobody gets ${what}, not even someone who joins later`;
    expect(await callApi(ctx, "task.send", { chat: "g1", card: { id: "t1", title: "Fix" }, wait: "sent", timeout: 1 })).toMatchObject({ edges: 0, note: nobody("this card") });
    vi.useFakeTimers({ now: Date.now() + CARD_UPDATE_GAP_MS });
    expect(await callApi(ctx, "task.update", { chat: "g1", task: "t1", card: { progress: 60 }, wait: "sent", timeout: 1 })).toMatchObject({ edges: 0, note: nobody("this update") });
    vi.useRealTimers();
    const state = node.getState();
    node.getState = () => ({ ...state, groups: [group({ members: [...state.groups[0]!.members, { key: "anakey", role: "member", me: false, online: true, missing: 0 }] })] });
    expect(await callApi(ctx, "task.send", { chat: "g1", card: { id: "t2", title: "Fix" } })).not.toHaveProperty("note");
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

  it("read a date with no zone as local time, a bare date as local midnight, and keep a Z or an offset (agents#2355)", () => {
    const next = (value: string) => (params("routine update", ["g1", "nightly", "--next", value]).card as { nextRunAt: number }).nextRunAt;
    const zone = process.env.TZ;
    try {
      // Midnight of 2026-11-03 where the command runs: UTC-03, UTC+05:30 and UTC.
      for (const [tz, midnight] of [["America/Sao_Paulo", Date.UTC(2026, 10, 3, 3)], ["Asia/Kolkata", Date.UTC(2026, 10, 2, 18, 30)], ["UTC", Date.UTC(2026, 10, 3)]] as const) {
        process.env.TZ = tz;
        // Before, a bare date was UTC midnight (21:00 the day before in UTC-03) while a date with a time was local.
        expect(next("2026-11-03"), tz).toBe(midnight);
        expect(next("2026-11-03T00:00"), tz).toBe(midnight);
        expect(next("2026-11-03 09:00"), tz).toBe(midnight + 9 * 3_600_000);
        expect(next("Nov 3 2026"), tz).toBe(midnight);
        expect(next("2026-11"), tz).toBe(midnight - 2 * 86_400_000);
        // A zone given is kept as given.
        expect(next("2026-11-03T09:00:00Z"), tz).toBe(Date.UTC(2026, 10, 3, 9));
        expect(next("2026-11-03Z"), tz).toBe(Date.UTC(2026, 10, 3));
        expect(next("2026-11-03T09:00+02:00"), tz).toBe(Date.UTC(2026, 10, 3, 7));
      }
    } finally {
      if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
    }
    expect(next("1793707200000")).toBe(1793707200000);
    expect(() => next("tomorrow 09:00")).toThrow(expect.objectContaining({ code: "usage", message: expect.stringMatching(/^--next takes a time in milliseconds or a date: 2026-09-30 or 2026-09-30 01:00 \(no zone: local time; a date alone is its midnight\)/) }));
    expect(COMMANDS["routine send"]!.options!.next.description).toMatch(/2026-09-30 01:00.*no zone: local time/);
  });

  it("refuse a day the month does not have as a usage error, where it was the next month's first days", () => {
    const next = (value: string) => (params("routine update", ["g1", "nightly", "--next", value]).card as { nextRunAt: number }).nextRunAt;
    const refused = (value: string, month: string, days: number) => expect(() => next(value), value).toThrow(expect.objectContaining({ code: "usage", message: `--next takes a day the month has (${month} has ${days}), not ${JSON.stringify(value)}` }));
    // Before, each was May 1, March 3, July 1, December 1, March 1 and May 1.
    refused("2026-04-31", "2026-04", 30);
    refused("2026-02-31 01:00", "2026-02", 28);
    refused("2026-06-31T10:00:00Z", "2026-06", 30);
    refused("Nov 31 2026", "2026-11", 30);
    refused("Feb 29 2026", "2026-02", 28);
    refused("31 Apr 2026", "2026-04", 30);
    refused("2026/4/31", "2026-04", 30);
    // The days a month has, a leap day and a date whose zone moves it to the next day stay as they were.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2027, 5, 1) });
    expect(next("2028-02-29T00:00:00Z")).toBe(Date.UTC(2028, 1, 29));
    vi.useRealTimers();
    expect(next("2026-04-30T23:00-05:00")).toBe(Date.UTC(2026, 4, 1, 4));
    expect(next("Dec 31 2026 12:00Z")).toBe(Date.UTC(2026, 11, 31, 12));
  });

  it("refuse a day the month does not have in the other forms a JavaScript date reads: month first in numbers, a month's name between dashes, slashes or dots", () => {
    const next = (value: string) => (params("routine update", ["g1", "nightly", "--next", value]).card as { nextRunAt: number }).nextRunAt;
    const refused = (value: string, month: string, days: number) => expect(() => next(value), value).toThrow(expect.objectContaining({ code: "usage", message: `--next takes a day the month has (${month} has ${days}), not ${JSON.stringify(value)}` }));
    // Before, each was the next month's first day.
    refused("4/31/2026", "2026-04", 30);
    refused("04/31/2026 10:00", "2026-04", 30);
    refused("2/29/2027", "2027-02", 28);
    refused("4/31/26", "2026-04", 30);
    refused("4-31-2026", "2026-04", 30);
    refused("4.31.2026", "2026-04", 30);
    refused("31-Apr-2026", "2026-04", 30);
    refused("31/Apr/2026", "2026-04", 30);
    refused("Apr-31-2026", "2026-04", 30);
    refused("Apr.31.2026", "2026-04", 30);
    refused("2026-Apr-31", "2026-04", 30);
    refused("31 Apr, 2026", "2026-04", 30);
    // Days the month has stay as they were, a leap day included, as local time.
    expect(next("12/31/2026")).toBe(new Date(2026, 11, 31).getTime());
    expect(next("Apr-30-2026")).toBe(new Date(2026, 3, 30).getTime());
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2027, 5, 1) });
    expect(next("2/29/28 10:00")).toBe(new Date(2028, 1, 29, 10).getTime());
    expect(next("29-Feb-2028")).toBe(new Date(2028, 1, 29).getTime());
    vi.useRealTimers();
  });

  it("refuse a day the month does not have in numbers between spaces, commas or dots, as a JavaScript date reads them too", () => {
    const next = (value: string) => (params("routine update", ["g1", "nightly", "--next", value]).card as { nextRunAt: number }).nextRunAt;
    const refused = (value: string, month: string, days: number) => expect(() => next(value), value).toThrow(expect.objectContaining({ code: "usage", message: `--next takes a day the month has (${month} has ${days}), not ${JSON.stringify(value)}` }));
    // Before, each was the next month's first day.
    refused("2026.11.31", "2026-11", 30);
    refused("2026.4.31 10:00", "2026-04", 30);
    refused("2026 11 31", "2026-11", 30);
    refused("2026, 11, 31", "2026-11", 30);
    refused("2026-11.31", "2026-11", 30);
    refused("11 31 2026", "2026-11", 30);
    refused("11,31,2026", "2026-11", 30);
    // Days the month has stay as they were, as local time.
    expect(next("2026.11.30")).toBe(new Date(2026, 10, 30).getTime());
    expect(next("2026 12 31 10:00")).toBe(new Date(2026, 11, 31, 10).getTime());
    expect(next("12 31 2026")).toBe(new Date(2026, 11, 31).getTime());
  });

  it("refuse a --next more than a year ahead as a usage error (exit 2) that names the flag and the last time it takes", () => {
    const zone = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 10, 4, 11, 30, 20) });
      const send = (next: string) => params("routine send", ["g1", "--name", "r", "--schedule", "every day", "--next", next]);
      // Before, bad_request (exit 1): "Status card: nextRunAt is a time in milliseconds, within a year".
      expect(() => send("2028-02-29 09:00")).toThrow(expect.objectContaining({ code: "usage", message: "--next takes a time within a year from now (until 2027-11-05 11:30), not \"2028-02-29 09:00\"" }));
      expect(() => params("routine update", ["g1", "nightly", "--next", String(Date.UTC(2027, 10, 6))])).toThrow(expect.objectContaining({ code: "usage", message: expect.stringMatching(/^--next takes a time within a year from now/) }));
      // The last time it takes, and a time past, stay taken; the card checks a --json value itself.
      expect((send("2027-11-05 11:30").card as { nextRunAt: number }).nextRunAt).toBe(Date.UTC(2027, 10, 5, 11, 30));
      expect((send("2001-01-01").card as { nextRunAt: number }).nextRunAt).toBe(Date.UTC(2001, 0, 1));
      expect((params("routine send", ["g1", "--json", `{"name":"r","schedule":"d","nextRunAt":${Date.UTC(2028, 0, 1)}}`]).card as { nextRunAt: number }).nextRunAt).toBe(Date.UTC(2028, 0, 1));
    } finally {
      if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
    }
  });

  it("refuse a wrong state or a text too long or blank as a usage error (exit 2) that names the flag, not the card's field", () => {
    const usage = (name: string, argv: string[], message: RegExp) => expect(() => params(name, argv)).toThrow(expect.objectContaining({ code: "usage", message: expect.stringMatching(message) }));
    const send = (...flags: string[]) => ["g1", "--name", "Nightly", "--schedule", "every day", ...flags];
    usage("routine send", send("--state", "weird"), /^--state takes active or paused, not "weird"$/);
    usage("routine update", ["g1", "nightly", "--state", "sleeping"], /^--state takes active or paused, not "sleeping"$/);
    usage("routine send", ["g1", "--name", "n".repeat(130), "--schedule", "d"], /^--name takes at most 120 characters, not 130$/);
    usage("routine send", ["g1", "--name", "Nightly", "--schedule", "s".repeat(90)], /^--schedule takes at most 80 characters, not 90$/);
    usage("routine update", ["g1", "nightly", "--schedule", " "], /^--schedule takes text, not " "$/);
    usage("routine send", send("--cron", "1".repeat(200)), /^--cron takes at most 64 characters, not 200$/);
    usage("routine send", send("--cron", "0 1 * * *; rm"), /^--cron takes a cron line of 0-9 A-Z a-z \* , \/ \? # - and spaces, not "0 1 \* \* \*; rm"$/);
    usage("routine update", ["g1", "nightly", "--run", `ok:${"r".repeat(201)}`], /^--run's summary takes at most 200 characters, not 201$/);
    usage("routine send", send("--link", "x=http://ci.example"), /^--link takes an https link/);
    expect(params("routine send", send("--cron", " 0 1 * * * ")).card).toMatchObject({ cron: " 0 1 * * * " });
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
