import { act, screen, waitFor, within } from "@testing-library/react";
import { useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { readStatusCard, statusCardText, type RoutineCard, type TaskCard } from "@ghostly/core";
import type { CardIndexRow, StoredMessage } from "@ghostly/browser/shared/types";
import { SidebarTasks } from "../../components/tasks/SidebarTasks";
import { saveSession } from "../../lib/storage";
import { Tasks } from "../../pages/Tasks";
import { groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.tasks-board

/** The Tasks board (WISP 4xx · Status Cards § The Tasks board): the page, a card, the phone's tabs, the keys. */

const NOW = Date.now();
const PEER = "peerkeycoordinator";
const task = (extra: Record<string, unknown> = {}) => readStatusCard({ kind: "task", id: "relay", title: "Fix relay rotation", status: "running", ...extra }) as TaskCard;
const routine = (extra: Record<string, unknown> = {}) => readStatusCard({ kind: "routine", id: "nightly", name: "Nightly bug hunt", schedule: "every day 01:00", state: "active", ...extra }) as RoutineCard;
let n = 0;
const row = (linkId: string, card: TaskCard | RoutineCard, patch: Partial<CardIndexRow> = {}): CardIndexRow => ({ linkId, id: `m${++n}`, card, sender: "peer", timestamp: NOW - 10 * 60_000 + n, ...patch });

const viewport = (width: number, height = 800) => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height });
afterEach(() => viewport(1024, 768));

/** Where the app is, and what the navigation carried: a click on a card opens its chat on its message. */
function Where() {
  const location = useLocation();
  return <p data-testid="where" data-jump={String((location.state as { jumpTo?: string } | null)?.jumpTo ?? "")}>{location.pathname}</p>;
}

/** A profile with a 1:1 chat with a bot (Coordinator) and a group (Sala de Máquinas) where Hermes also posts. */
function profile(rows: CardIndexRow[]) {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages: [], createdAt: 1_700_000_000_000, nick: "Coordinator" });
  const state = {
    links: [linkView({ id: "link-1", peerPubKeyZ32: PEER, peerNick: "Coordinator" })],
    groups: [groupView({ id: "g1", name: "Sala de Máquinas", status: "active", members: [{ key: "me-key", me: true, nick: "Me" }, { key: "hermes-key", me: false, nick: "Hermes One" }] as never })],
  };
  let current = rows;
  const rendered = renderApp(<><Tasks /><Where /></>, { route: "/tasks" });
  rendered.engine.on("statusCardIndex", () => current).setState(state);
  return { ...rendered, set: (next: CardIndexRow[]) => { current = next; } };
}

const column = (id: string) => screen.getByTestId("tasks-board").querySelector<HTMLElement>(`[data-column="${id}"]`)!;
const cardIds = (id: string) => within(column(id)).queryAllByTestId("board-card").map((c) => c.getAttribute("data-card-id"));
const loaded = () => waitFor(() => expect(screen.queryByTestId("tasks-board") ?? screen.queryByTestId("tasks-routines")).toBeInTheDocument());

const rowsOfThree = () => [
  row("link-1", task({ id: "relay", progress: 40, done: 2, total: 5, pr: { url: "https://github.com/o/r/pull/612", number: 612, additions: 123, deletions: 45 } })),
  row("group:g1", task({ id: "docs", title: "Write the WISP", status: "queued" }), { member: "hermes-key" }),
  row("group:g1", task({ id: "ci", title: "Fix the flaky spec", status: "done" }), { member: "hermes-key" }),
];

describe("the Tasks board", () => {
  it("gathers the tasks of every chat in columns by status, each with its count, and says how many are active", async () => {
    profile([...rowsOfThree(), row("link-1", task({ id: "old", status: "failed" })), row("link-1", task({ id: "gone", status: "cancelled" }))]);
    await loaded();
    expect(screen.getAllByTestId("board-column").map((c) => c.getAttribute("data-column"))).toEqual(["queued", "running", "blocked", "done", "closed"]);
    expect(screen.getAllByTestId("board-column").map((c) => within(c).getByRole("heading").textContent)).toEqual(["Queued1", "Running1", "Blocked0", "Done1", "Stopped2"]);
    expect(cardIds("queued")).toEqual(["docs"]);
    expect(cardIds("running")).toEqual(["relay"]);
    expect(cardIds("done")).toEqual(["ci"]);
    // Failed and cancelled share the last column.
    expect(cardIds("closed").sort()).toEqual(["gone", "old"]);
    expect(within(column("blocked")).getByTestId("board-column-empty")).toHaveTextContent("None");
    expect(screen.getByTestId("tasks-summary")).toHaveTextContent("2 active · 5 tasks");
  });

  it("a card is a button with its whole story as its name: title, status, progress, who and where, PR, age", async () => {
    profile(rowsOfThree());
    await loaded();
    const relay = within(column("running")).getByTestId("board-card");
    const open = within(relay).getByTestId("board-card-open");
    expect(open.tagName).toBe("BUTTON");
    expect(open).toHaveAccessibleName(/^Fix relay rotation, Running, 2 of 5, in Coordinator, PR #612, updated \d+ min ago$/);
    // The whole title on hover; one line on the card.
    expect(open).toHaveAttribute("title", "Fix relay rotation");
    expect(within(relay).getByTestId("board-card-title")).toHaveTextContent("Fix relay rotation");
    expect(within(relay).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
    expect(within(relay).getByTestId("board-card-age")).toHaveTextContent(/min ago/);
    // In a group, the card says which bot and which chat.
    const docs = within(column("queued")).getByTestId("board-card");
    expect(within(docs).getByTestId("board-card-open")).toHaveAccessibleName(/^Write the WISP, Queued, Hermes One in Sala de Máquinas, updated /);
    expect(within(docs).getByTestId("board-card-bot")).toHaveTextContent("Hermes One");
    expect(within(docs).getByTestId("board-card-chat")).toHaveTextContent("Sala de Máquinas");
  });

  it("shows at most three chips; the PR's opens outside the app; the rest is behind Details", async () => {
    const { user } = profile([row("group:g1", task({ id: "full", step: "Running the e2e", branch: "fix/relay", done: 2, total: 5,
      pr: { url: "https://github.com/o/r/pull/612", number: 612, additions: 123, deletions: 45, files: 7 } }), { member: "hermes-key" })]);
    await loaded();
    const card = screen.getByTestId("board-card");
    expect(within(card).getByTestId("board-card-chips").children).toHaveLength(3);
    const pr = within(card).getByTestId("board-card-pr");
    expect(pr).toHaveTextContent("PR #612+123−45");
    expect(pr).toHaveAttribute("href", "https://github.com/o/r/pull/612");
    expect(pr).toHaveAttribute("target", "_blank");
    expect(pr).toHaveAttribute("rel", "noopener noreferrer");
    expect(pr).toHaveAttribute("title", "Open on github.com");

    expect(screen.queryByTestId("board-card-details")).not.toBeInTheDocument();
    const toggle = within(card).getByRole("button", { name: "Details" });
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const details = within(card).getByTestId("board-card-details");
    expect(details).toHaveTextContent("Running · 2 of 5");
    expect(details).toHaveTextContent("Running the e2e");
    expect(details).toHaveTextContent("fix/relay");
    expect(details).toHaveTextContent("Files:7");
    // Details did not open the chat.
    expect(screen.getByTestId("where")).toHaveTextContent("/tasks");

    // Grouped by bot, the status takes the bot's place among the three.
    await user.click(screen.getByTestId("tasks-group-bot"));
    const chips = within(screen.getByTestId("board-card")).getByTestId("board-card-chips");
    expect(chips.children).toHaveLength(3);
    expect(within(chips).getByTestId("board-card-status")).toHaveTextContent("Running");
    expect(within(chips).queryByTestId("board-card-bot")).not.toBeInTheDocument();
  });

  it("a click, or Enter, opens the card's chat on its message", async () => {
    const rows = rowsOfThree();
    const { user } = profile(rows);
    await loaded();
    await user.click(within(column("queued")).getByTestId("board-card-open"));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/group/g1"));
    expect(screen.getByTestId("where")).toHaveAttribute("data-jump", rows[1].id);
  });

  it("Enter on a 1:1 chat's card opens that chat on the card's message", async () => {
    const rows = rowsOfThree();
    const { user } = profile(rows);
    await loaded();
    within(column("running")).getByTestId("board-card-open").focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/chat/chat-1"));
    expect(screen.getByTestId("where")).toHaveAttribute("data-jump", rows[0].id);
  });

  it("the arrow keys move between cards and columns", async () => {
    const { user } = profile([
      row("link-1", task({ id: "q1", status: "queued" })), row("link-1", task({ id: "q2", status: "queued" })),
      row("link-1", task({ id: "r1" })),
      row("link-1", task({ id: "d1", status: "done" })), row("link-1", task({ id: "d2", status: "done" })),
    ]);
    await loaded();
    const focused = () => document.activeElement?.closest("[data-testid=board-card]")?.getAttribute("data-card-id");
    // The newest first: q2 above q1.
    within(column("queued")).getAllByTestId("board-card-open")[0].focus();
    expect(focused()).toBe("q2");
    await user.keyboard("{ArrowDown}");
    expect(focused()).toBe("q1");
    await user.keyboard("{ArrowDown}");
    expect(focused()).toBe("q1");
    // To the next column: its last card when it has fewer.
    await user.keyboard("{ArrowRight}");
    expect(focused()).toBe("r1");
    // Past the empty Blocked column, to Done.
    await user.keyboard("{ArrowRight}");
    expect(focused()).toBe("d2");
    await user.keyboard("{End}");
    expect(focused()).toBe("d1");
    await user.keyboard("{Home}");
    expect(focused()).toBe("d2");
    await user.keyboard("{ArrowLeft}{ArrowLeft}{ArrowUp}");
    expect(focused()).toBe("q2");
  });

  it("follows the cards as they are edited: an update moves a card to its column", async () => {
    const rows = rowsOfThree();
    const { engine, set } = profile(rows);
    await loaded();
    expect(cardIds("running")).toEqual(["relay"]);
    const done = task({ id: "relay", status: "done", progress: 100 });
    set([{ ...rows[0], card: done, editedAt: NOW }, rows[1], rows[2]]);
    // The chat's messages changed, as the engine tells every page.
    act(() => engine.messages("link-1", [{ linkId: "link-1", id: rows[0].id, text: statusCardText(done), sender: "peer", timestamp: rows[0].timestamp, via: "datalink", card: done } as StoredMessage]));
    await waitFor(() => expect(cardIds("done")).toEqual(["relay", "ci"]));
    expect(cardIds("running")).toEqual([]);
    expect(screen.getByTestId("tasks-summary")).toHaveTextContent("1 active · 3 tasks");
  });

  it("a deleted chat's cards leave the board", async () => {
    const rows = rowsOfThree();
    const { engine, set } = profile(rows);
    await loaded();
    expect(screen.getAllByTestId("board-card")).toHaveLength(3);
    // The group is forgotten: the engine drops its messages, and the state no longer lists it.
    set([rows[0]]);
    act(() => engine.update({ groups: [] }));
    await waitFor(() => expect(screen.getAllByTestId("board-card")).toHaveLength(1));
    expect(cardIds("running")).toEqual(["relay"]);
  });

  it("groups by bot or by chat instead, and filters by text", async () => {
    const { user } = profile(rowsOfThree());
    await loaded();
    await user.click(screen.getByTestId("tasks-group-bot"));
    expect(screen.getByTestId("tasks-group-bot")).toHaveAttribute("aria-checked", "true");
    expect(screen.getAllByTestId("board-column").map((c) => within(c).getByRole("heading").textContent)).toEqual(["Hermes One2", "Coordinator1"]);
    await user.click(screen.getByTestId("tasks-group-chat"));
    expect(screen.getAllByTestId("board-column").map((c) => within(c).getByRole("heading").textContent)).toEqual(["Sala de Máquinas2", "Coordinator1"]);
    await user.click(screen.getByTestId("tasks-group-status"));

    await user.type(screen.getByTestId("tasks-filter"), "wisp");
    expect(screen.getAllByTestId("board-card").map((c) => c.getAttribute("data-card-id"))).toEqual(["docs"]);
    await user.clear(screen.getByTestId("tasks-filter"));
    await user.type(screen.getByTestId("tasks-filter"), "nothing like it");
    expect(screen.queryAllByTestId("board-card")).toHaveLength(0);
    expect(screen.getByTestId("tasks-no-match")).toHaveTextContent("No task matches");
  });

  it("keeps finished tasks for a day, with older ones behind Show older", async () => {
    const { user } = profile([
      row("link-1", task({ id: "fresh", status: "done" })),
      row("link-1", task({ id: "stale", status: "done" }), { timestamp: NOW - 3 * 24 * 60 * 60_000 }),
      row("link-1", task({ id: "long", status: "running" }), { timestamp: NOW - 3 * 24 * 60 * 60_000 }),
    ]);
    await loaded();
    expect(cardIds("done")).toEqual(["fresh"]);
    expect(cardIds("running")).toEqual(["long"]);
    const older = within(column("done")).getByTestId("board-column-older");
    expect(older).toHaveTextContent("Show older (1)");
    await user.click(older);
    expect(cardIds("done")).toEqual(["fresh", "stale"]);
    expect(within(column("done")).getByTestId("board-column-older")).toHaveTextContent("Hide older");
  });

  it("with hundreds of cards, draws fifty a column and more on Show more", async () => {
    const many = Array.from({ length: 500 }, (_, i) => row("link-1", task({ id: `t${i}`, title: `Task ${i}`, status: i % 5 === 0 ? "queued" : "running" })));
    const { user } = profile(many);
    await loaded();
    expect(screen.getByTestId("tasks-summary")).toHaveTextContent("500 active · 500 tasks");
    expect(within(column("running")).getByTestId("board-column-count")).toHaveTextContent("400");
    expect(cardIds("running")).toHaveLength(50);
    expect(cardIds("queued")).toHaveLength(50);
    expect(screen.getAllByTestId("board-card")).toHaveLength(100);
    const more = within(column("running")).getByTestId("board-column-more");
    expect(more).toHaveTextContent("Show more (350)");
    await user.click(more);
    expect(cardIds("running")).toHaveLength(100);
  });

  it("lists routines on their own tab, a line each, never in the columns", async () => {
    const rows = [...rowsOfThree(), row("group:g1", routine({ lastRun: { at: NOW - 3_600_000, result: "ok" } }), { member: "hermes-key" })];
    const { user } = profile(rows);
    await loaded();
    expect(screen.getAllByTestId("board-card")).toHaveLength(3);
    expect(screen.getByTestId("tasks-view-routines")).toHaveTextContent("Routines 1");
    await user.click(screen.getByTestId("tasks-view-routines"));
    expect(screen.queryByTestId("tasks-board")).not.toBeInTheDocument();
    const line = screen.getByTestId("board-routine");
    expect(line).toHaveTextContent("Nightly bug hunt");
    expect(line).toHaveTextContent("Hermes One in Sala de Máquinas");
    expect(line).toHaveTextContent("Last run: OK");
    await user.click(line);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/group/g1"));
    expect(screen.getByTestId("where")).toHaveAttribute("data-jump", rows[3].id);
  });

  it("with no card at all, says what tasks are in a line, with the details behind the info button", async () => {
    const { user, engine } = profile([]);
    await waitFor(() => expect(engine.callsTo("statusCardIndex").length).toBeGreaterThan(0));
    expect(screen.getByTestId("tasks-empty")).toHaveTextContent("No tasks yet");
    expect(screen.getByTestId("tasks-empty")).toHaveTextContent("Task cards from bots in your chats show up here.");
    expect(screen.queryByTestId("tasks-board")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tasks-info-text")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("tasks-info"));
    expect(screen.getByTestId("tasks-info-text")).toHaveTextContent(/its bot changes the status/);
  });

  it("has nothing that moves a card: no drag, no status control", async () => {
    profile(rowsOfThree());
    await loaded();
    expect(document.querySelector("[draggable=true]")).toBeNull();
    expect(screen.getByTestId("tasks-board").querySelector("select, input, [role=combobox]")).toBeNull();
  });
});

describe("richer task cards on the board", () => {
  const pr = (extra: Record<string, unknown> = {}) => ({ url: "https://github.com/o/r/pull/612", number: 612, ...extra });

  it("a task whose pull request is open sits in Review, between Blocked and Done, still running", async () => {
    profile([
      row("link-1", task({ id: "reviewing", pr: pr({ state: "open", checks: "passing" }) })),
      row("link-1", task({ id: "drafting", pr: pr({ state: "draft" }) })),
      row("link-1", task({ id: "merged", status: "done", pr: pr({ state: "merged" }) })),
    ]);
    await loaded();
    expect(screen.getAllByTestId("board-column").map((c) => within(c).getByRole("heading").textContent)).toEqual(["Queued0", "Running1", "Blocked0", "Review1", "Done1", "Stopped0"]);
    expect(cardIds("review")).toEqual(["reviewing"]);
    expect(cardIds("running")).toEqual(["drafting"]);
    expect(cardIds("done")).toEqual(["merged"]);
    expect(within(column("review")).getByTestId("board-card")).toHaveAttribute("data-status", "running");
    expect(screen.getByTestId("tasks-summary")).toHaveTextContent("2 active · 3 tasks");
  });

  it("without a pull request state on any card, the board has no Review column", async () => {
    profile(rowsOfThree());
    await loaded();
    expect(screen.getByTestId("tasks-board").querySelector('[data-column="review"]')).toBeNull();
  });

  it("the pull request's chip carries its checks as a mark with words, and its state in its name and Details", async () => {
    const { user } = profile([
      row("link-1", task({ id: "pass", pr: pr({ state: "open", checks: "passing" }) })),
      row("link-1", task({ id: "fail", status: "blocked", pr: pr({ state: "open", checks: "failing" }) })),
      row("link-1", task({ id: "wait", status: "queued", pr: pr({ state: "draft", checks: "pending" }) })),
    ]);
    await loaded();
    const card = (id: string) => screen.getByTestId("tasks-board").querySelector<HTMLElement>(`[data-testid="board-card"][data-card-id="${id}"]`)!;
    expect(within(card("pass")).getByTestId("board-card-checks")).toHaveAttribute("data-checks", "passing");
    expect(within(card("pass")).getByTestId("board-card-checks")).toHaveTextContent("✓Checks passing");
    expect(within(card("fail")).getByTestId("board-card-checks")).toHaveTextContent("✕Checks failing");
    expect(within(card("wait")).getByTestId("board-card-checks")).toHaveTextContent("●Checks pending");
    expect(within(card("pass")).getByTestId("board-card-pr")).toHaveAttribute("title", "Open on github.com · Open · Checks passing");
    expect(within(card("pass")).getByTestId("board-card-open")).toHaveAccessibleName(/PR #612, Open, Checks passing, updated /);
    await user.click(within(card("wait")).getByRole("button", { name: "Details" }));
    expect(within(card("wait")).getByTestId("board-card-pr-standing")).toHaveTextContent("Draft · Checks pending");
  });

  it("shows tags as chips (three chips at most, all of them in Details) and filters by one", async () => {
    const { user } = profile([
      row("link-1", task({ id: "a", tags: ["core", "web"] })),
      row("link-1", task({ id: "b", tags: ["core"], pr: pr() })),
      row("group:g1", task({ id: "c", tags: ["cli", "docs", "web"], pr: pr() }), { member: "hermes-key" }),
    ]);
    await loaded();
    const card = (id: string) => screen.getByTestId("tasks-board").querySelector<HTMLElement>(`[data-testid="board-card"][data-card-id="${id}"]`)!;
    // A 1:1 chat's card: its bot, then its tags.
    expect(within(card("a")).getAllByTestId("board-card-tag").map((el) => el.textContent)).toEqual(["core", "web"]);
    // Bot, chat and pull request take the three places: the tags are in Details.
    expect(within(card("c")).getByTestId("board-card-chips").children).toHaveLength(3);
    expect(within(card("c")).queryByTestId("board-card-tag")).not.toBeInTheDocument();
    await user.click(within(card("c")).getByRole("button", { name: "Details" }));
    expect(within(card("c")).getByTestId("board-card-tags")).toHaveTextContent("cli, docs, web");

    // The tags to filter by, the most used first; a card's tag chip filters too.
    expect(within(screen.getByTestId("tasks-tags")).getAllByTestId("tasks-tag").map((el) => el.textContent)).toEqual(["core", "web", "cli", "docs"]);
    await user.click(within(screen.getByTestId("tasks-tags")).getByRole("button", { name: "web" }));
    expect(screen.getAllByTestId("board-card").map((c) => c.getAttribute("data-card-id")).sort()).toEqual(["a", "c"]);
    expect(within(screen.getByTestId("tasks-tags")).getByRole("button", { name: "web" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(screen.getByTestId("tasks-tags")).getByRole("button", { name: "web" }));
    expect(screen.getAllByTestId("board-card")).toHaveLength(3);
    await user.click(within(card("a")).getAllByTestId("board-card-tag")[0]);
    expect(screen.getAllByTestId("board-card").map((c) => c.getAttribute("data-card-id")).sort()).toEqual(["a", "b"]);
    expect(screen.getByTestId("where")).toHaveTextContent("/tasks");
  });

  it("stacks a task's parts under it with how many are done; a part opens its own message", async () => {
    const rows = [
      row("group:g1", task({ id: "epic", title: "Relay rework" }), { member: "hermes-key" }),
      row("group:g1", task({ id: "codec", title: "Codec", parent: "epic", status: "done" }), { member: "hermes-key" }),
      row("group:g1", task({ id: "engine", title: "Engine", parent: "epic" }), { member: "hermes-key" }),
      row("group:g1", task({ id: "orphan", title: "Orphan", parent: "never-sent", status: "queued" }), { member: "hermes-key" }),
    ];
    const { user } = profile(rows);
    await loaded();
    // The parts are in no column of their own; a part whose parent is missing stands alone.
    expect(cardIds("running")).toEqual(["epic"]);
    expect(cardIds("done")).toEqual([]);
    expect(cardIds("queued")).toEqual(["orphan"]);
    expect(screen.getByTestId("tasks-summary")).toHaveTextContent("3 active · 4 tasks");
    const epic = within(column("running")).getByTestId("board-card");
    expect(within(epic).getByTestId("board-card-parts")).toHaveTextContent("1 of 2 done");
    expect(within(epic).getByTestId("board-card-open")).toHaveAccessibleName(/^Relay rework, Running, 1 of 2 done, /);
    expect(within(epic).queryByTestId("board-card-part")).not.toBeInTheDocument();
    const toggle = within(epic).getByTestId("board-card-stack-toggle");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(epic).getAllByTestId("board-card-part").map((p) => p.textContent)).toEqual(["EngineRunning", "CodecDone"]);
    await user.click(within(epic).getAllByTestId("board-card-part")[1]);
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("/group/g1"));
    expect(screen.getByTestId("where")).toHaveAttribute("data-jump", rows[1].id);
  });
});

describe("the Tasks board on a phone", () => {
  it("shows the columns as tabs with their counts, one column for each", async () => {
    viewport(375, 740);
    const { user } = profile(rowsOfThree());
    await loaded();
    expect(screen.getByTestId("tasks-board")).toHaveAttribute("data-layout", "tabs");
    const tabs = within(screen.getByRole("tablist", { name: "Columns" })).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Queued1", "Running1", "Blocked0", "Done1", "Stopped0"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false", "false", "false"]);
    // Each tab names its panel, and each panel its tab.
    const panels = screen.getAllByRole("tabpanel");
    expect(panels).toHaveLength(5);
    expect(panels[1]).toHaveAttribute("aria-labelledby", tabs[1].id);
    expect(tabs[1]).toHaveAttribute("aria-controls", panels[1].id);
    await user.click(tabs[3]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "false", "false", "true", "false"]);
    // The arrow keys move between the tabs.
    await user.keyboard("{ArrowLeft}");
    expect(tabs[2]).toHaveAttribute("aria-selected", "true");
    expect(tabs[2]).toHaveFocus();
    await user.keyboard("{Home}");
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
  });
});

describe("the way to the board, above the chat list", () => {
  it("is there only when the profile has a card, with the number of tasks still going", async () => {
    let rows: CardIndexRow[] = [];
    const { engine } = renderApp(<SidebarTasks active={false} onOpen={() => {}} />);
    engine.on("statusCardIndex", () => rows);
    await waitFor(() => expect(engine.callsTo("statusCardIndex").length).toBeGreaterThan(0));
    expect(screen.queryByTestId("sidebar-tasks")).not.toBeInTheDocument();

    rows = rowsOfThree();
    act(() => engine.messages("link-1", [{ linkId: "link-1", id: rows[0].id, text: "", sender: "peer", timestamp: 1, via: "datalink", card: rows[0].card } as StoredMessage]));
    const entry = await screen.findByTestId("sidebar-tasks");
    expect(entry).toHaveAccessibleName("Tasks, 2 active");
    expect(within(entry).getByTestId("sidebar-tasks-summary")).toHaveTextContent("2 active");
  });

  it("with nothing going says so, and still leads to the finished tasks", async () => {
    const { engine } = renderApp(<SidebarTasks active onOpen={() => {}} />);
    engine.on("statusCardIndex", () => [row("link-1", task({ status: "done" }))]);
    act(() => engine.update({}));
    // The first question went before the test could answer: a chat's change asks again.
    act(() => engine.messages("link-1", [{ linkId: "link-1", id: "x", text: "", sender: "peer", timestamp: 1, via: "datalink", card: task() } as StoredMessage]));
    const entry = await screen.findByTestId("sidebar-tasks");
    expect(entry).toHaveAccessibleName("Tasks");
    expect(entry).toHaveAttribute("aria-current", "page");
    expect(within(entry).getByTestId("sidebar-tasks-summary")).toHaveTextContent("Nothing running");
  });
});
