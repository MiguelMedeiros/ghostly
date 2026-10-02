import { describe, expect, it } from "vitest";
import { readStatusCard, type RoutineCard, type TaskCard } from "@ghostly/core";
import type { CardIndexRow } from "@ghostly/browser/shared/types";
import { BOARD_COLUMNS, RECENT_MS, boardEntries, boardModel, boardMove, columnOf, progressWords, type BoardEntry, type BoardTask } from "../../lib/taskBoard";

// covers: chat.tasks-board

/** The Tasks board's selector (WISP 4xx · Status Cards § The Tasks board): cards across chats, in columns by status. */

const NOW = 1_800_000_000_000;
const task = (extra: Record<string, unknown> = {}) => readStatusCard({ kind: "task", id: "relay", title: "Fix relay rotation", status: "running", ...extra }) as TaskCard;
const routine = (extra: Record<string, unknown> = {}) => readStatusCard({ kind: "routine", id: "nightly", name: "Nightly", schedule: "every day 01:00", state: "active", ...extra }) as RoutineCard;
let n = 0;
const row = (linkId: string, card: TaskCard | RoutineCard, patch: Partial<CardIndexRow> = {}): CardIndexRow => ({ linkId, id: `m${++n}`, card, sender: "peer", timestamp: NOW - 60 * 60_000 + n, ...patch });
/** Names as `useTaskBoard` would give them. */
const named = (entries: BoardEntry[], names: Record<string, string> = {}): BoardTask[] => entries.filter((e): e is BoardEntry<TaskCard> => e.card.kind === "task")
  .map((e) => ({ ...e, botKey: e.author, bot: names[e.author] ?? e.author, chat: names[e.linkId] ?? e.linkId }));
const columns = (tasks: BoardTask[], options: Parameters<typeof boardModel>[1] = {}) =>
  Object.fromEntries(boardModel(tasks, { now: NOW, ...options }).groups.map((g) => [g.id, g.tasks.map((t) => t.card.id)]));

describe("the cards of every chat", () => {
  const rows = [
    row("chat-a", task({ id: "relay" })),
    row("group:mesh", task({ id: "docs", status: "queued" }), { member: "hermes" }),
    row("group:community", task({ id: "ci", status: "blocked" }), { member: "coordinator" }),
    row("group:community", routine(), { member: "coordinator" }),
    row("chat-b", task({ id: "mine", status: "done" }), { sender: "me" }),
  ];

  it("come from 1:1 chats, private groups and communities, each with its chat and its sender", () => {
    expect(boardEntries(rows).map((e) => [e.linkId, e.author, e.card.kind, e.card.id]).sort()).toEqual([
      ["chat-a", "peer", "task", "relay"],
      ["chat-b", "me", "task", "mine"],
      ["group:community", "coordinator", "routine", "nightly"],
      ["group:community", "coordinator", "task", "ci"],
      ["group:mesh", "hermes", "task", "docs"],
    ]);
  });

  it("the same id in two chats, or from two members of a group, is two cards", () => {
    const twice = [row("chat-a", task()), row("chat-b", task()), row("group:mesh", task(), { member: "hermes" }), row("group:mesh", task(), { member: "coordinator" })];
    expect(boardEntries(twice)).toHaveLength(4);
  });

  it("the newest message of a card stands for it, whatever order the rows come in", () => {
    const old = row("chat-a", task({ status: "running" }), { timestamp: NOW - 5_000 });
    const sentAgain = row("chat-a", task({ status: "done" }), { timestamp: NOW - 1_000 });
    for (const order of [[old, sentAgain], [sentAgain, old]]) {
      const [entry, ...rest] = boardEntries(order);
      expect(rest).toEqual([]);
      expect(entry).toMatchObject({ messageId: sentAgain.id, card: { status: "done" } });
    }
  });

  it("a deleted chat's cards go away", () => {
    const known = new Set(["chat-a", "group:mesh", "group:community"]);
    expect(boardEntries(rows, known).map((e) => e.linkId)).not.toContain("chat-b");
    expect(boardEntries(rows, new Set(["chat-a"])).map((e) => e.card.id)).toEqual(["relay"]);
    expect(boardEntries(rows, new Set())).toEqual([]);
  });

  it("are ordered by their last update: an edit's time, else when the message was sent", () => {
    const entries = boardEntries([
      row("chat-a", task({ id: "first" }), { timestamp: NOW - 30_000 }),
      row("chat-a", task({ id: "edited" }), { timestamp: NOW - 90_000, editedAt: NOW - 1_000 }),
      row("chat-b", task({ id: "last" }), { timestamp: NOW - 60_000 }),
    ]);
    expect(entries.map((e) => e.card.id)).toEqual(["edited", "first", "last"]);
    expect(entries[0].at).toBe(NOW - 1_000);
  });
});

describe("the board's columns", () => {
  it("are Queued, Running, Blocked, Done and Stopped, with failed and cancelled tasks together", () => {
    expect(BOARD_COLUMNS).toEqual(["queued", "running", "blocked", "done", "closed"]);
    expect((["queued", "running", "blocked", "done", "failed", "cancelled"] as const).map(columnOf)).toEqual(["queued", "running", "blocked", "done", "closed", "closed"]);
    const tasks = named(boardEntries((["queued", "running", "blocked", "done", "failed", "cancelled"] as const).map((status) => row("chat-a", task({ id: status, status })))));
    expect(columns(tasks)).toEqual({ queued: ["queued"], running: ["running"], blocked: ["blocked"], done: ["done"], closed: ["cancelled", "failed"] });
    expect(boardModel(tasks, { now: NOW })).toMatchObject({ active: 3, total: 6, shown: 6 });
  });

  it("an edit moves a card to its new column, as one card", () => {
    const sent = row("chat-a", task({ status: "running", progress: 40 }));
    expect(columns(named(boardEntries([sent])))).toMatchObject({ running: ["relay"], done: [] });
    // The bot edited its message: the index gives the same message with the card of its latest version.
    const edited = { ...sent, card: task({ status: "done", progress: 100 }), editedAt: NOW - 1_000 };
    expect(columns(named(boardEntries([edited])))).toMatchObject({ running: [], done: ["relay"] });
  });

  it("within a column, the most recently updated first", () => {
    const tasks = named(boardEntries([
      row("chat-a", task({ id: "a" }), { timestamp: NOW - 50_000 }),
      row("chat-b", task({ id: "b" }), { timestamp: NOW - 10_000 }),
      row("group:mesh", task({ id: "c" }), { member: "hermes", timestamp: NOW - 90_000, editedAt: NOW - 5_000 }),
    ]));
    expect(columns(tasks).running).toEqual(["c", "b", "a"]);
  });

  it("finished tasks older than a day wait behind Show older; tasks still going never do", () => {
    const longAgo = NOW - RECENT_MS - 60_000;
    const tasks = named(boardEntries([
      row("chat-a", task({ id: "old-done", status: "done" }), { timestamp: longAgo }),
      row("chat-a", task({ id: "old-failed", status: "failed" }), { timestamp: longAgo }),
      row("chat-a", task({ id: "old-running", status: "running" }), { timestamp: longAgo }),
      row("chat-a", task({ id: "new-done", status: "done" }), { timestamp: NOW - 60_000 }),
      // Sent long ago, finished a minute ago: its last update is what counts.
      row("chat-a", task({ id: "just-done", status: "done" }), { timestamp: longAgo, editedAt: NOW - 30_000 }),
    ]));
    const recent = boardModel(tasks, { now: NOW });
    expect(columns(tasks)).toMatchObject({ running: ["old-running"], done: ["just-done", "new-done"], closed: [] });
    expect(recent.groups.map((g) => g.old)).toEqual([0, 0, 0, 1, 1]);
    expect(columns(tasks, { older: true })).toMatchObject({ done: ["just-done", "new-done", "old-done"], closed: ["old-failed"] });
    expect(boardModel(tasks, { now: NOW, older: true }).groups.map((g) => g.old)).toEqual([0, 0, 0, 1, 1]);
  });

  it("grouped by bot or by chat: a column each, those with more going first, their going tasks first", () => {
    const tasks = named(boardEntries([
      row("group:mesh", task({ id: "h1", status: "done" }), { member: "hermes" }),
      row("group:mesh", task({ id: "h2", status: "running" }), { member: "hermes" }),
      row("group:mesh", task({ id: "c1", status: "running" }), { member: "coordinator" }),
      row("chat-a", task({ id: "c2", status: "blocked" }), { member: "coordinator" }),
      row("chat-a", task({ id: "c3", status: "failed" }), { member: "coordinator" }),
    ]), { hermes: "Hermes", coordinator: "Coordinator", "group:mesh": "Sala de Máquinas", "chat-a": "Coordinator" });
    const byBot = boardModel(tasks, { now: NOW, grouping: "bot" });
    expect(byBot.groups.map((g) => [g.label, g.active, g.tasks.map((t) => t.card.id)])).toEqual([
      ["Coordinator", 2, ["c1", "c2", "c3"]],
      ["Hermes", 1, ["h2", "h1"]],
    ]);
    const byChat = boardModel(tasks, { now: NOW, grouping: "chat" });
    expect(byChat.groups.map((g) => [g.id, g.label, g.tasks.map((t) => t.card.id)])).toEqual([
      ["group:mesh", "Sala de Máquinas", ["c1", "h2", "h1"]],
      ["chat-a", "Coordinator", ["c2", "c3"]],
    ]);
  });

  it("the filter reads the title, the bot, the chat, the step, the branch, the status and the PR's number", () => {
    const tasks = named(boardEntries([
      row("group:mesh", task({ id: "a", title: "Fix relay rotation", step: "Running the e2e", branch: "fix/relay" }), { member: "hermes" }),
      row("chat-a", task({ id: "b", title: "Écrire le WISP", status: "done", pr: { url: "https://github.com/o/r/pull/612", number: 612 } })),
    ]), { hermes: "Hermes One", "group:mesh": "Sala de Máquinas", "chat-a": "Coordinator" });
    const found = (filter: string) => boardModel(tasks, { now: NOW, filter, statusWord: (s) => (s === "done" ? "Concluída" : s) }).groups.flatMap((g) => g.tasks.map((t) => t.card.id)).sort();
    expect(found("relay")).toEqual(["a"]);
    expect(found("hermes")).toEqual(["a"]);
    expect(found("maquinas")).toEqual(["a"]);
    expect(found("e2e")).toEqual(["a"]);
    expect(found("fix/relay")).toEqual(["a"]);
    expect(found("ecrire")).toEqual(["b"]);
    expect(found("#612")).toEqual(["b"]);
    expect(found("concluida")).toEqual(["b"]);
    expect(found("  ")).toEqual(["a", "b"]);
    expect(found("nothing like it")).toEqual([]);
    // The header's count is of every task: the filter does not change it.
    expect(boardModel(tasks, { now: NOW, filter: "ecrire" })).toMatchObject({ active: 1, total: 2, shown: 1 });
  });
});

describe("a card's progress in words", () => {
  it("is its steps when it counts them, else its percent, else nothing", () => {
    expect(progressWords(task({ done: 2, total: 5, progress: 10 }))).toEqual({ done: 2, total: 5 });
    expect(progressWords(task({ progress: 40 }))).toEqual({ percent: 40 });
    expect(progressWords(task())).toBeUndefined();
  });
});

describe("the arrow keys on the board", () => {
  const board = [2, 0, 3, 1];
  it("move up and down within a column and stop at its ends", () => {
    expect(boardMove(board, { column: 2, row: 0 }, "ArrowDown")).toEqual({ column: 2, row: 1 });
    expect(boardMove(board, { column: 2, row: 2 }, "ArrowDown")).toBeUndefined();
    expect(boardMove(board, { column: 2, row: 1 }, "ArrowUp")).toEqual({ column: 2, row: 0 });
    expect(boardMove(board, { column: 2, row: 0 }, "ArrowUp")).toBeUndefined();
    expect(boardMove(board, { column: 2, row: 1 }, "Home")).toEqual({ column: 2, row: 0 });
    expect(boardMove(board, { column: 2, row: 1 }, "End")).toEqual({ column: 2, row: 2 });
  });

  it("move to the next column that has a card, at the same place or its last card", () => {
    expect(boardMove(board, { column: 0, row: 1 }, "ArrowRight")).toEqual({ column: 2, row: 1 });
    expect(boardMove(board, { column: 2, row: 2 }, "ArrowRight")).toEqual({ column: 3, row: 0 });
    expect(boardMove(board, { column: 3, row: 0 }, "ArrowRight")).toBeUndefined();
    expect(boardMove(board, { column: 2, row: 2 }, "ArrowLeft")).toEqual({ column: 0, row: 1 });
    expect(boardMove(board, { column: 0, row: 0 }, "ArrowLeft")).toBeUndefined();
  });

  it("right to left, the arrows follow the page", () => {
    expect(boardMove(board, { column: 0, row: 0 }, "ArrowLeft", true)).toEqual({ column: 2, row: 0 });
    expect(boardMove(board, { column: 2, row: 0 }, "ArrowRight", true)).toEqual({ column: 0, row: 0 });
  });
});
