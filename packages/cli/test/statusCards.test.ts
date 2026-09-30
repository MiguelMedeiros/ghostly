import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineState, GroupView, LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { STATUS_CARD_LIMITS, checkStatusCard, type StatusCard } from "@ghostly/core";
import { callApi, type ApiContext } from "../src/api";
import { parseArgs } from "../src/args";
import { COMMANDS, idSlot, positionals } from "../src/commands";
import { chatOnly } from "../src/main";
import { CARD_UPDATE_GAP_MS, flushCardUpdates, mergeCard } from "../src/statusCards";
// covers: headless.status-cards

/** `task send` and `task update` (WISP 4xx · Status Cards) against an engine that keeps what it is sent. */
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
  };
  const ctx = { runtime: { server: { node }, paths: { name: "default" } }, hub: { onEvent: () => () => {}, onState: () => () => {}, lastSeq: 0, replay: () => [] }, mode, version: "test" } as unknown as ApiContext;
  return { ctx, node, rows: of };
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
      chat: "Coordinator", text: undefined, wait: undefined, timeout: undefined,
      card: { branch: "r6a/x", title: "Fix relay rotation", done: 2, total: 5, step: "Running the e2e", items: [{ state: "done", text: "Codec" }, { state: "pending", text: "Engine" }],
        pr: { url: "https://github.com/o/r/pull/612", number: 612, additions: 123, deletions: 45 }, links: [{ label: "CI", url: "https://ci.example/1" }] },
    });
    expect(params("task update", ["g1", "relay-rotation", "--progress", "80"])).toMatchObject({ chat: "g1", task: "relay-rotation", card: { progress: 80 } });
    expect(() => params("task update", ["g1", "t", "--steps", "two"])).toThrow(/--steps takes done\/total/);
    expect(() => params("task send", ["g1", "--json", "{nope"])).toThrow(/not valid JSON/);
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

describe("routines", () => {
  it("take their fields and a run from flags", () => {
    expect(params("routine send", ["g1", "--name", "Nightly bug hunt", "--schedule", "every day 01:00", "--cron", "0 1 * * *", "--next", "2026-09-30T01:00:00Z", "--run", "ok:12 issues checked"])).toEqual({
      chat: "g1", text: undefined, wait: undefined, timeout: undefined, run: { result: "ok", summary: "12 issues checked" },
      card: { name: "Nightly bug hunt", schedule: "every day 01:00", cron: "0 1 * * *", nextRunAt: Date.UTC(2026, 8, 30, 1, 0) },
    });
    expect(params("routine update", ["g1", "nightly", "--run", "failed", "--state", "paused"])).toMatchObject({ routine: "nightly", run: { result: "failed" }, card: { state: "paused" } });
    expect(() => params("routine update", ["g1", "nightly", "--run", "maybe"])).toThrow(/--run takes ok, failed or skipped/);
    expect(() => params("routine update", ["g1", "nightly", "--next", "someday"])).toThrow(/--next takes a time/);
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
