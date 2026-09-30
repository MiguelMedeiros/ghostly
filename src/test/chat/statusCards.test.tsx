import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { readStatusCard, statusCardText, type RoutineCard, type StatusCard } from "@ghostly/core";
import { MessageBubble } from "../../components/MessageBubble";
import { TasksButton } from "../../components/chat/TasksButton";
import { activeTaskCount, cardEntries, panelModel, routineSummary, type CardRow } from "../../lib/statusCards";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";

// covers: chat.status-cards

/** Status cards in the chat (WISP 4xx · Status Cards): the card instead of its text, opened in place; the Tasks button. */

const NOW = Date.now();
const card = (extra: Record<string, unknown> = {}): StatusCard => readStatusCard({ kind: "task", id: "relay", title: "Fix relay rotation", status: "running", ...extra })!;
/** How wide the window is, as matchMedia and layout read it. */
const viewport = (width: number, height = 800) => (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width, height });
afterEach(() => viewport(1024, 768));

const message = (c: StatusCard, patch: Partial<ChatMessage> = {}): ChatMessage => ({ id: "m1", text: statusCardText(c), sender: "peer", timestamp: 1_700_000_000_000, card: c, ...patch });

describe("a task card in the chat", () => {
  it("shows the title, a bar, the status and the PR's size instead of its text", () => {
    const c = card({ progress: 40, done: 2, total: 5, pr: { url: "https://github.com/o/r/pull/612", number: 612, additions: 123, deletions: 45 } });
    renderApp(<MessageBubble message={message(c)} peerPubKey="peer" />);
    const shown = screen.getByTestId("status-card");
    expect(shown).toHaveAttribute("data-status", "running");
    expect(within(shown).getByTestId("status-card-title")).toHaveTextContent("Fix relay rotation");
    expect(within(shown).getByTestId("status-card-status")).toHaveTextContent("Running");
    expect(within(shown).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
    expect(within(shown).getByTestId("status-card-pr")).toHaveTextContent("+123−45·PR #612");
    expect(shown).toHaveTextContent("2 of 5 steps");
    expect(screen.queryByTestId("message-text")).not.toBeInTheDocument();
    expect(screen.queryByTestId("status-card-details")).not.toBeInTheDocument();
  });

  it("opens in place on a click or with the keyboard, with the step, the steps and the links by their host", async () => {
    const c = card({ step: "Running the e2e", branch: "r6a/relay", items: [{ text: "Codec", state: "done" }, { text: "UI", state: "running" }],
      pr: { url: "https://github.com/o/r/pull/612", number: 612 }, links: [{ url: "https://ci.example/run/1", label: "CI run" }], updatedAt: NOW - 120_000 });
    const { user } = renderApp(<MessageBubble message={message(c)} peerPubKey="peer" />);
    const toggle = screen.getByTestId("status-card-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const details = screen.getByTestId("status-card-details");
    expect(within(details).getByTestId("status-card-step")).toHaveTextContent("Running the e2e");
    expect(within(details).getAllByTestId("status-card-item").map(i => i.getAttribute("data-state"))).toEqual(["done", "running"]);
    const links = within(details).getAllByTestId("status-card-link");
    expect(links.map(a => a.getAttribute("href"))).toEqual(["https://github.com/o/r/pull/612", "https://ci.example/run/1"]);
    expect(details).toHaveTextContent("github.com");
    expect(details).toHaveTextContent("ci.example");
    expect(details).toHaveTextContent(/updated 2 min/);
    // Enter closes it again.
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("status-card-details")).not.toBeInTheDocument();
  });

  it("draws its strings as plain text: no Markdown, no links found in a line", () => {
    renderApp(<MessageBubble message={message(card({ title: "**bold** https://evil.example" }))} peerPubKey="peer" />);
    expect(screen.getByTestId("status-card-title")).toHaveTextContent("**bold** https://evil.example");
    expect(screen.getByTestId("status-card").querySelector("a, strong")).toBeNull();
  });

  it("tells the statuses apart: running in the accent, done in green with ✓, failed in red with ✕, blocked in amber", () => {
    renderApp(<>{(["running", "done", "failed", "blocked", "queued"] as const).map(status =>
      <MessageBubble key={status} message={message(card({ status, progress: 30 }), { id: status })} peerPubKey="peer" />)}</>);
    const tone = (status: string) => {
      const shown = screen.getAllByTestId("status-card").find(c => c.dataset.status === status)!;
      return { label: within(shown).getByTestId("status-card-status"), bar: shown.querySelector("[role=progressbar] > div")!.className };
    };
    expect(tone("running").label.className).toContain("text-accent");
    expect(tone("done").label).toHaveTextContent("✓ Done");
    expect(tone("done").bar).toContain("bg-success");
    expect(tone("failed").label).toHaveTextContent("✕ Failed");
    expect(tone("failed").bar).toContain("bg-danger");
    expect(tone("blocked").label.className).toContain("text-amber-500");
    expect(tone("queued").label.className).toContain("text-text-primary/65");
  });

  it("infers nothing: a done task without a percent keeps an empty bar, its steps as they are, and no current step", async () => {
    const { user } = renderApp(<MessageBubble message={message(card({ status: "done", done: 3, total: 4, step: "CI" }))} peerPubKey="peer" />);
    const shown = screen.getByTestId("status-card");
    expect(within(shown).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "75");
    expect(shown).toHaveTextContent("3 of 4 steps");
    await user.click(screen.getByTestId("status-card-toggle"));
    expect(screen.queryByTestId("status-card-step")).not.toBeInTheDocument();
    const bare = renderApp(<MessageBubble message={message(card({ status: "done" }), { id: "m2" })} peerPubKey="peer" />);
    expect(bare.container.querySelector("[role=progressbar]")).not.toHaveAttribute("aria-valuenow");
    expect(bare.container.querySelector("[role=progressbar] > div")).toHaveStyle({ width: "0%" });
  });

  it("reads right to left in Arabic", () => {
    renderApp(<MessageBubble message={message(card({ status: "blocked" }))} peerPubKey="peer" />, { language: "ar" });
    expect(screen.getByTestId("status-card-status")).toHaveTextContent("متوقفة");
  });

  it("shows a message without a card as its text", () => {
    renderApp(<MessageBubble message={{ id: "m", text: "just words", sender: "peer", timestamp: 1 }} peerPubKey="peer" />);
    expect(screen.queryByTestId("status-card")).not.toBeInTheDocument();
    expect(screen.getByTestId("message-text")).toHaveTextContent("just words");
  });
});

describe("a routine card in the chat", () => {
  const routine = (extra: Record<string, unknown> = {}) => readStatusCard({ kind: "routine", id: "nightly", name: "Nightly bug hunt", schedule: "every day 01:00", state: "active", ...extra })!;

  it("is one line: its name, schedule, next run and the last run's mark; opened, the last run's result and when", async () => {
    const c = routine({ lastRun: { at: NOW - 2 * 3_600_000, result: "failed", summary: "CI flaked" }, nextRunAt: NOW + 3 * 3_600_000 + 60_000 });
    const { user } = renderApp(<MessageBubble message={message(c)} peerPubKey="peer" />);
    const shown = screen.getByTestId("status-card");
    expect(shown).toHaveAttribute("data-kind", "routine");
    const line = within(shown).getByTestId("status-card-toggle");
    expect(within(line).getByTestId("status-card-title")).toHaveTextContent("Nightly bug hunt");
    expect(within(line).getByTestId("status-card-schedule")).toHaveTextContent("every day 01:00");
    expect(within(line).getByTestId("status-card-next")).toHaveTextContent("· in 3 hr.");
    const last = within(line).getByTestId("status-card-last");
    expect(last).toHaveAttribute("data-result", "failed");
    expect(last).toHaveTextContent("✕Last run: Failed");
    expect(last.className).toContain("text-danger-ink");
    // One line: no second row, nothing else until it is opened.
    expect(line.querySelectorAll("br, p, div")).toHaveLength(0);
    expect(screen.queryByTestId("status-card-details")).not.toBeInTheDocument();
    expect(screen.queryByTestId("message-text")).not.toBeInTheDocument();
    await user.click(line);
    const run = screen.getByTestId("status-card-last-run");
    expect(run).toHaveTextContent(/Failed\s*2 h ago/);
    expect(run).toHaveTextContent("Next in 3 hr.");
    expect(screen.getByTestId("status-card-details")).toHaveTextContent("CI flaked");
  });

  it("opens in place on its recent runs and cron line; a paused one shows no next run", async () => {
    const runs = [{ at: NOW - 86_400_000, result: "ok", summary: "12 issues" }, { at: NOW - 2 * 86_400_000, result: "skipped" }];
    const { user } = renderApp(<MessageBubble message={message(routine({ state: "paused", cron: "0 1 * * *", runs, lastRun: runs[0], nextRunAt: NOW + 60_000 }))} peerPubKey="peer" />);
    expect(screen.getByTestId("status-card-status")).toHaveTextContent("Paused");
    expect(screen.queryByTestId("status-card-next")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("status-card-toggle"));
    expect(screen.getAllByTestId("status-card-run").map(r => r.dataset.result)).toEqual(["ok", "skipped"]);
    expect(screen.getByTestId("status-card-details")).toHaveTextContent("0 1 * * *");
  });

  it("says so when it has not run yet", () => {
    renderApp(<MessageBubble message={message(routine())} peerPubKey="peer" />);
    expect(screen.getByTestId("status-card-last")).toHaveTextContent("No runs yet");
    expect(screen.getByTestId("status-card-last")).not.toHaveAttribute("data-result");
  });

  it("is listed in the Tasks panel on one line, with its next run and last run's mark", async () => {
    const { user } = renderApp(<TasksButton rows={[{ id: "m1", sender: "peer", timestamp: 1, card: routine({ nextRunAt: NOW + 2 * 3_600_000, lastRun: { at: NOW - 60_000, result: "ok" } }) }]} />);
    expect(screen.queryByTestId("chat-tasks-count")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("chat-tasks"));
    // One routine is its row, not a folded line.
    expect(screen.queryByTestId("chat-tasks-routines-toggle")).not.toBeInTheDocument();
    const item = within(screen.getByTestId("chat-tasks-routines")).getByTestId("chat-tasks-item");
    expect(item).toHaveAttribute("data-kind", "routine");
    expect(within(item).getByTestId("chat-tasks-item-next")).toHaveTextContent("in 2 hr.");
    expect(within(item).getByTestId("chat-tasks-item-last")).toHaveTextContent("✓Last run: OK");
    expect(screen.getByTestId("chat-tasks-summary")).toHaveTextContent("Nothing running · 1 routine");
  });
});

const row = (id: string, c: StatusCard | undefined, patch: Partial<CardRow> = {}): CardRow => ({ id, card: c, sender: "peer", timestamp: Number(id.replace(/\D/g, "")) || 1, ...patch });

describe("the chat's cards", () => {
  it("are the newest message of each card, active tasks first, then finished, then routines", () => {
    const rows = [
      row("m1", card({ id: "a", status: "running" })),
      row("m2", card({ id: "b", status: "done" })),
      row("m3", readStatusCard({ kind: "routine", id: "r", name: "Nightly", schedule: "daily", state: "active" })),
      row("m4", card({ id: "a", status: "blocked" })),
      row("m5", undefined),
      row("m6", card({ id: "a", status: "queued" }), { sender: "me" }),
    ];
    const entries = cardEntries(rows);
    expect(entries.map(e => [e.messageId, e.card.id, e.author])).toEqual([["m6", "a", "me"], ["m4", "a", "peer"], ["m2", "b", "peer"], ["m3", "r", "peer"]]);
    expect(activeTaskCount(entries)).toBe(2);
  });
});

describe("the Tasks button", () => {
  it("is not there without a card", () => {
    renderApp(<TasksButton rows={[row("m1", undefined)]} />);
    expect(screen.queryByTestId("chat-tasks")).not.toBeInTheDocument();
  });

  it("counts the active tasks and lists them, then the finished ones; a row goes to its card", async () => {
    const rows = [row("m1", card({ id: "a", title: "Build", progress: 40 })), row("m2", card({ id: "b", title: "Deploy", status: "done" })), row("m3", card({ id: "c", title: "Review", status: "blocked" }))];
    const { user } = renderApp(<><TasksButton rows={rows} /><div data-message-id="m2">card b</div></>);
    const button = screen.getByTestId("chat-tasks");
    expect(screen.getByTestId("chat-tasks-count")).toHaveTextContent("2");
    expect(button).toHaveAccessibleName("Tasks, 2 active");
    await user.click(button);
    const panel = screen.getByTestId("chat-tasks-panel");
    expect(within(within(panel).getByTestId("chat-tasks-active")).getAllByTestId("chat-tasks-item").map(i => i.dataset.cardId)).toEqual(["c", "a"]);
    expect(within(panel).queryByTestId("chat-tasks-routines")).not.toBeInTheDocument();
    // The finished ones are folded under one line.
    const finished = within(panel).getByTestId("chat-tasks-finished");
    const toggle = within(finished).getByTestId("chat-tasks-finished-toggle");
    expect(toggle).toHaveTextContent("Finished (1)");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(finished).queryByTestId("chat-tasks-item")).not.toBeInTheDocument();
    await user.click(toggle);
    expect(within(finished).getAllByTestId("chat-tasks-item").map(i => i.dataset.cardId)).toEqual(["b"]);
    await user.click(within(panel).getAllByTestId("chat-tasks-item").find(i => i.dataset.cardId === "b")!);
    expect(screen.queryByTestId("chat-tasks-panel")).not.toBeInTheDocument();
    expect(screen.getByText("card b").closest("[data-message-id]")).toHaveAttribute("data-reply-flash");
  });

  it("in a group of three, lists each bot's cards under its name, the one with more going first; the badge counts them all", async () => {
    const hermes = "h".repeat(52), coordinator = "c".repeat(52);
    const names: Record<string, string> = { [hermes]: "Hermes One", [coordinator]: "Coordinator" };
    const rows = [
      row("m1", card({ id: "nightly", title: "Nightly build", status: "done" }), { member: hermes }),
      row("m2", card({ id: "relay", title: "Fix relay", progress: 30 }), { member: coordinator }),
      row("m3", card({ id: "docs", title: "Write WISP", status: "queued" }), { member: coordinator }),
      row("m4", card({ id: "bench", title: "Benchmarks", progress: 80 }), { member: hermes }),
      row("m5", undefined, { member: "p".repeat(52), sender: "me" }),
    ];
    const { user } = renderApp(<TasksButton rows={rows} nameOf={author => names[author] ?? "?"} />);
    expect(screen.getByTestId("chat-tasks-count")).toHaveTextContent("3");
    await user.click(screen.getByTestId("chat-tasks"));
    const sections = screen.getAllByTestId("chat-tasks-sender");
    expect(sections.map(s => within(s).getByTestId("chat-tasks-sender-name").textContent)).toEqual(["Coordinator", "Hermes One"]);
    expect(sections.map(s => within(s).getByTestId("chat-tasks-sender-count").textContent)).toEqual(["2 active", "1 active"]);
    expect(within(sections[1]).getAllByTestId("chat-tasks-item").map(i => i.dataset.cardId)).toEqual(["bench"]);
    // A finished task goes to the folded section at the end, with its sender's name.
    await user.click(screen.getByTestId("chat-tasks-finished-toggle"));
    const done = within(screen.getByTestId("chat-tasks-finished")).getByTestId("chat-tasks-item");
    expect(done).toHaveAttribute("data-card-id", "nightly");
    expect(done).toHaveTextContent("Hermes One");
  });

  it("shows no count once every task is finished", () => {
    renderApp(<TasksButton rows={[row("m1", card({ status: "done" }))]} />);
    expect(screen.getByTestId("chat-tasks")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-tasks-count")).not.toBeInTheDocument();
  });
});

/** "Sala de Máquinas": a coordinator, Hermes Zero with ten routines, Hermes One with two tasks and two routines. */
describe("the Tasks panel under a bot room's load", () => {
  const coordinator = "c".repeat(52), zero = "z".repeat(52), one = "o".repeat(52);
  const names: Record<string, string> = { [coordinator]: "Coordinator", [zero]: "Hermes Zero", [one]: "Hermes One" };
  const nameOf = (author: string) => names[author] ?? "?";
  const routineCard = (id: string, extra: Record<string, unknown> = {}) => readStatusCard({ kind: "routine", id, name: `Routine ${id}`, schedule: "every hour", state: "active", ...extra })!;
  const load = (): CardRow[] => {
    let n = 0;
    const at = (c: StatusCard, member: string) => row(`m${++n}`, c, { member, timestamp: n });
    return [
      at(card({ id: "ux", title: "Status cards UX", progress: 40 }), coordinator),
      at(card({ id: "relay", title: "Fix relay", status: "done", pr: { url: "https://github.com/o/r/pull/712", number: 712 } }), coordinator),
      at(routineCard("bughunt", { nextRunAt: NOW + 5 * 3_600_000, lastRun: { at: NOW - 60_000, result: "ok" } }), coordinator),
      at(routineCard("prqueue", { nextRunAt: NOW + 4 * 60_000 + 20_000, lastRun: { at: NOW - 60_000, result: "ok" } }), coordinator),
      ...Array.from({ length: 10 }, (_, i) => at(routineCard(`zero-${i}`, {
        nextRunAt: NOW + (i + 2) * 60_000 + 20_000, lastRun: { at: NOW - 60_000, result: i === 6 ? "failed" : "ok" }, ...(i === 9 && { state: "paused" }),
      }), zero)),
      at(card({ id: "e2e", title: "Run the e2e matrix", progress: 45 }), one),
      at(card({ id: "bench", title: "Benchmarks", status: "blocked" }), one),
      at(routineCard("one-a", { nextRunAt: NOW + 7 * 3_600_000 }), one),
      at(routineCard("one-b", { nextRunAt: NOW + 2 * 3_600_000 }), one),
    ];
  };

  it("says what is going in its header, and scrolls inside a box no taller than the window", async () => {
    const { user } = renderApp(<TasksButton rows={load()} nameOf={nameOf} />);
    await user.click(screen.getByTestId("chat-tasks"));
    const panel = screen.getByTestId("chat-tasks-panel");
    expect(panel).toHaveAttribute("role", "dialog");
    expect(panel).toHaveAttribute("data-layout", "popover");
    expect(panel).toHaveAccessibleName("Tasks");
    expect(screen.getByTestId("chat-tasks-summary")).toHaveTextContent("3 active · 14 routines");
    // At most min(70vh, 560px), inside the window; the rows scroll in their own box, the header stays.
    const maxHeight = parseFloat(panel.style.maxHeight);
    expect(maxHeight).toBeGreaterThan(0);
    expect(maxHeight).toBeLessThanOrEqual(Math.min(window.innerHeight * 0.7, 560));
    expect(parseFloat(panel.style.width)).toBeLessThanOrEqual(window.innerWidth - 16);
    expect(panel.className).toContain("flex-col");
    const scroll = within(panel).getByTestId("chat-tasks-scroll");
    expect(scroll.className).toMatch(/\boverflow-y-auto\b/);
    expect(scroll.className).toMatch(/\bmin-h-0\b/);
    expect(scroll).not.toContainElement(screen.getByTestId("chat-tasks-summary"));
  });

  it("lists each bot's tasks first, then its routines folded on one line, with the finished tasks folded at the end", async () => {
    const { user } = renderApp(<TasksButton rows={load()} nameOf={nameOf} />);
    await user.click(screen.getByTestId("chat-tasks"));
    const sections = screen.getAllByTestId("chat-tasks-sender");
    // The one with more going first; Hermes Zero, with nothing going, last.
    expect(sections.map(s => within(s).getByTestId("chat-tasks-sender-name").textContent)).toEqual(["Hermes One", "Coordinator", "Hermes Zero"]);
    // Sticky names: a bot's name stays at the top while its rows scroll under it.
    expect(within(sections[0]).getByTestId("chat-tasks-sender-name").parentElement!.className).toMatch(/\bsticky\b.*\btop-0\b/);
    // Tasks before routines, blocked and running both "active", in the card's words and colours.
    const [hermesOne, coord, hermesZero] = sections;
    expect(within(within(hermesOne).getByTestId("chat-tasks-active")).getAllByTestId("chat-tasks-item").map(i => i.dataset.cardId)).toEqual(["bench", "e2e"]);
    expect(within(hermesOne).getAllByTestId("chat-tasks-item-status").map(s => s.textContent)).toEqual(["Blocked", "Running"]);
    expect(within(hermesOne).getAllByTestId("chat-tasks-item-status")[0].className).toContain("text-amber-500");
    const order = [...hermesOne.querySelectorAll("[data-testid=chat-tasks-active], [data-testid=chat-tasks-routines]")].map(el => el.getAttribute("data-testid"));
    expect(order).toEqual(["chat-tasks-active", "chat-tasks-routines"]);
    // Zero's ten routines: one line, folded.
    const zeroToggle = within(hermesZero).getByTestId("chat-tasks-routines-toggle");
    expect(zeroToggle).toHaveAttribute("aria-expanded", "false");
    expect(zeroToggle).toHaveTextContent("10 routines· next in 2 min.· ✕ 1 failed");
    expect(within(hermesZero).queryAllByTestId("chat-tasks-item")).toHaveLength(0);
    expect(within(coord).getByTestId("chat-tasks-routines-toggle")).toHaveTextContent("2 routines· next in 4 min.· ✓ all OK");
    // The finished task is not among the bots' rows; the section at the end holds it, folded.
    expect(within(coord).queryAllByTestId("chat-tasks-item").map(i => i.dataset.cardId)).toEqual(["ux"]);
    expect(screen.getByTestId("chat-tasks-finished-toggle")).toHaveTextContent("Finished (1)");
    // Opened: one line per routine, a failed one first, a paused one last.
    await user.click(zeroToggle);
    expect(zeroToggle).toHaveAttribute("aria-expanded", "true");
    const rows = within(hermesZero).getAllByTestId("chat-tasks-item");
    expect(rows).toHaveLength(10);
    expect(rows[0]).toHaveAttribute("data-card-id", "zero-6");
    expect(rows[0]).toHaveAttribute("data-result", "failed");
    expect(rows[9]).toHaveAttribute("data-card-id", "zero-9");
    expect(within(rows[9]).getByTestId("chat-tasks-item-next")).toHaveTextContent("Paused");
    expect(rows.every(r => r.tagName === "BUTTON")).toBe(true);
  });

  it("moves between its rows with the arrow keys, closes on Escape and gives the focus back to the button", async () => {
    const { user } = renderApp(<TasksButton rows={load()} nameOf={nameOf} />);
    const button = screen.getByTestId("chat-tasks");
    await user.click(button);
    const panel = screen.getByTestId("chat-tasks-panel");
    expect(panel).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toHaveAttribute("data-card-id", "bench");
    await user.keyboard("{End}");
    expect(document.activeElement).toHaveAttribute("data-testid", "chat-tasks-finished-toggle");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toHaveAttribute("data-card-id", "bench");
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("chat-tasks-panel")).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it("keeps Tab inside it", async () => {
    const { user } = renderApp(<><button>before</button><TasksButton rows={load()} nameOf={nameOf} /><button>after</button></>);
    await user.click(screen.getByTestId("chat-tasks"));
    const panel = screen.getByTestId("chat-tasks-panel");
    for (let i = 0; i < 12; i++) {
      await user.tab();
      expect(panel).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it("takes a row to its card and puts the focus on it", async () => {
    const rows = load();
    const target = rows.find(r => r.card?.id === "e2e")!;
    const { user } = renderApp(<><TasksButton rows={rows} nameOf={nameOf} /><div data-message-id={target.id}><button data-testid="status-card-toggle">card</button></div></>);
    await user.click(screen.getByTestId("chat-tasks"));
    await user.click(screen.getAllByTestId("chat-tasks-item").find(i => i.dataset.cardId === "e2e")!);
    expect(screen.queryByTestId("chat-tasks-panel")).not.toBeInTheDocument();
    expect(screen.getByText("card").closest("[data-message-id]")).toHaveAttribute("data-reply-flash");
    expect(screen.getByText("card")).toHaveFocus();
  });

  it("is a sheet on a phone, with a close button", async () => {
    viewport(375, 812);
    const { user } = renderApp(<TasksButton rows={load()} nameOf={nameOf} />);
    const button = screen.getByTestId("chat-tasks");
    await user.click(button);
    const panel = screen.getByTestId("chat-tasks-panel");
    expect(panel).toHaveAttribute("data-layout", "sheet");
    expect(panel.className).toContain("max-h-[calc(100dvh-2.5rem)]");
    expect(within(panel).getByTestId("chat-tasks-scroll").className).toMatch(/\boverflow-y-auto\b/);
    expect(screen.getByTestId("chat-tasks-backdrop")).toBeInTheDocument();
    await user.click(within(panel).getByTestId("chat-tasks-close"));
    expect(screen.queryByTestId("chat-tasks-panel")).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it("says so when nothing is going, with the finished tasks open", async () => {
    const { user } = renderApp(<TasksButton rows={[row("m1", card({ id: "a", status: "done" })), row("m2", card({ id: "b", status: "cancelled" }))]} />);
    await user.click(screen.getByTestId("chat-tasks"));
    expect(screen.getByTestId("chat-tasks-summary")).toHaveTextContent("Nothing running");
    expect(screen.getByTestId("chat-tasks-empty")).toHaveTextContent("No tasks running now");
    expect(screen.getByTestId("chat-tasks-finished-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByTestId("chat-tasks-item").map(i => i.dataset.status)).toEqual(["cancelled", "done"]);
  });

  it("reads right to left in Arabic", async () => {
    const { user } = renderApp(<TasksButton rows={load()} nameOf={nameOf} />, { language: "ar" });
    await user.click(screen.getByTestId("chat-tasks"));
    expect(screen.getByTestId("chat-tasks-summary")).toHaveTextContent("3 نشطة · 14 روتينات");
    expect(screen.getByTestId("chat-tasks-close")).toHaveAccessibleName("إغلاق");
  });
});

describe("the panel's model", () => {
  const r = (id: string, extra: Record<string, unknown>) => readStatusCard({ kind: "routine", id, name: id, schedule: "hourly", state: "active", ...extra }) as RoutineCard;

  it("sums up routines: how many, the soonest next run of an active one, how many failed and ran", () => {
    const cards = [r("a", { nextRunAt: NOW + 600_000, lastRun: { at: NOW - 1, result: "ok" } }), r("b", { nextRunAt: NOW + 60_000, state: "paused" }),
      r("c", { nextRunAt: NOW + 120_000, lastRun: { at: NOW - 1, result: "failed" } }), r("d", {})];
    expect(routineSummary(cards)).toEqual({ count: 4, next: NOW + 120_000, failed: 1, ran: 2 });
    expect(routineSummary([])).toEqual({ count: 0, failed: 0, ran: 0 });
  });

  it("in a 1:1 chat is one section without a name, the finished tasks apart", () => {
    const model = panelModel(cardEntries([row("m1", card({ id: "a" })), row("m2", card({ id: "b", status: "failed" })), row("m3", r("n", {}))]), false);
    expect(model.sections).toHaveLength(1);
    expect(model.sections[0].author).toBe("");
    expect(model.sections[0].active.map(e => e.card.id)).toEqual(["a"]);
    expect(model.sections[0].routines.map(e => e.card.id)).toEqual(["n"]);
    expect(model.finished.map(e => e.card.id)).toEqual(["b"]);
    expect([model.active, model.routines]).toEqual([1, 1]);
  });
});
