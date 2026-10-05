import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readStatusCard, statusCardText, type RoutineCard, type StatusCard, type TaskCard } from "@ghostly/core";
import { MessageBubble } from "../../components/MessageBubble";
import { RoutineStack } from "../../components/chat/RoutineCard";
import { TasksButton } from "../../components/chat/TasksButton";
import { jumpToMessage, messageSnippet, quoteFor, replyIndex } from "../../lib/replies";
import { activeTaskCount, cardEntries, durationIn, panelModel, routineStacks, routineSummary, taskElapsed, type CardRow } from "../../lib/statusCards";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";

// covers: chat.status-cards

/** Status cards in the chat (WISP 405 · Status Cards): the card instead of its text, opened in place; the Tasks button. */

const NOW = Date.now();
const card = (extra: Record<string, unknown> = {}): StatusCard => readStatusCard({ kind: "task", id: "relay", title: "Fix relay rotation", status: "running", ...extra })!;
const task = (extra: Record<string, unknown> = {}) => card(extra) as TaskCard;
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
    // When it was updated is the card's foot, not repeated here.
    expect(details).not.toHaveTextContent(/updated/);
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

  it("says when it started (opened) and was updated (its foot) as a label and a time in Japanese and Chinese, \"just now\" included", async () => {
    const times = { startedAt: Date.now() - 3 * 60_000, updatedAt: Date.now() };
    const edit = { at: Date.now(), versions: [] } as unknown as ChatMessage["edit"];
    for (const [language, started, updated] of [["ja", "開始：3 分前", "更新：今"], ["zh", "开始：3分钟前", "更新：现在"]] as const) {
      const { user, unmount } = renderApp(<MessageBubble message={message(card(times), { edit })} peerPubKey="peer" />, { language });
      await user.click(screen.getByTestId("status-card-toggle"));
      expect(screen.getByTestId("status-card-started")).toHaveTextContent(started);
      expect(screen.getByTestId("status-card-time")).toHaveTextContent(updated);
      // Said once: the opened card does not repeat the foot's "updated".
      expect(screen.getByTestId("status-card-details")).not.toHaveTextContent(updated);
      unmount();
    }
  });

  it("shows a message without a card as its text", () => {
    renderApp(<MessageBubble message={{ id: "m", text: "just words", sender: "peer", timestamp: 1 }} peerPubKey="peer" />);
    expect(screen.queryByTestId("status-card")).not.toBeInTheDocument();
    expect(screen.getByTestId("message-text")).toHaveTextContent("just words");
  });
});

describe("a card on its own, not a bubble", () => {
  const edited = { at: NOW - 3.5 * 60_000, versions: [] } as unknown as ChatMessage["edit"];

  it("has no bubble, tail or \"edited\": the card is the surface, and says when it was last updated", () => {
    const { container } = renderApp(<MessageBubble message={message(card({ progress: 67 }), { edit: edited })} peerPubKey="peer" />);
    expect(container.querySelector("[data-message-bubble]")).toBeNull();
    expect(container.querySelector(".fill-sent-bg, .fill-received-bg, .bg-sent-bg, .bg-received-bg")).toBeNull();
    expect(screen.queryByTestId("message-edited")).not.toBeInTheDocument();
    const surface = container.querySelector<HTMLElement>("[data-message-card]")!;
    expect(surface).toHaveClass("status-card-surface");
    expect(surface).toContainElement(screen.getByTestId("status-card"));
    expect(within(surface).getByTestId("status-card-time")).toHaveTextContent("updated 3 min ago");
    // On the sender's side: theirs at the start of the line.
    expect(container.querySelector("[data-message-row]")!.className).toContain("justify-start");
  });

  it("is a group a screen reader names by its title, status and progress", () => {
    renderApp(<>
      <MessageBubble message={message(card({ progress: 67 }))} peerPubKey="peer" />
      <MessageBubble message={message(readStatusCard({ kind: "routine", id: "n", name: "Nightly", schedule: "daily", state: "paused" })!, { id: "m2" })} peerPubKey="peer" />
    </>);
    expect(screen.getByRole("group", { name: "Task: Fix relay rotation, Running, 67%" })).toHaveAttribute("data-message-card");
    expect(screen.getByRole("group", { name: "Routine: Nightly, Paused" })).toBeInTheDocument();
  });

  it("never updated, shows the time it came; mine carry their delivery marks, at my side of the line", () => {
    const { container } = renderApp(<MessageBubble message={message(card(), { sender: "me", delivery: "delivered" })} peerPubKey="peer" />);
    const time = screen.getByTestId("status-card-time");
    expect(time).not.toHaveAttribute("data-updated");
    expect(time.textContent).toMatch(/\d{1,2}:\d{2}/);
    expect(within(container.querySelector("[data-message-card]")!).getByTestId("message-delivery")).toBeInTheDocument();
    expect(container.querySelector("[data-message-row]")!.className).toContain("justify-end");
  });

  it("a routine's closed line has no time, only my marks; it has a status mark only when its last run failed or it is paused", () => {
    const routine = (id: string, extra: Record<string, unknown>) => readStatusCard({ kind: "routine", id, name: id, schedule: "daily", state: "active", ...extra })!;
    const { container } = renderApp(<>
      <MessageBubble message={message(routine("ok", { lastRun: { at: NOW, result: "ok" } }), { id: "ok", sender: "me", delivery: "delivered" })} peerPubKey="peer" />
      <MessageBubble message={message(routine("failed", { lastRun: { at: NOW, result: "failed" } }), { id: "failed" })} peerPubKey="peer" />
      <MessageBubble message={message(routine("paused", { state: "paused" }), { id: "paused" })} peerPubKey="peer" />
      <MessageBubble message={message(card({ status: "blocked" }), { id: "task" })} peerPubKey="peer" />
    </>);
    expect(screen.queryAllByTestId("status-card-time")).toHaveLength(1);
    const cardOf = (id: string) => [...container.querySelectorAll<HTMLElement>("[data-message-card]")].find(c => c.querySelector(`[data-card-id="${id}"]`))!;
    expect(within(cardOf("ok")).getByTestId("message-delivery")).toBeInTheDocument();
    expect(within(cardOf("ok")).queryByTestId("status-card-edge")).not.toBeInTheDocument();
    expect(within(cardOf("failed")).getByTestId("status-card-edge").className).toContain("bg-danger");
    expect(within(cardOf("paused")).getByTestId("status-card-edge").className).toContain("bg-text-muted");
    expect(within(cardOf("relay")).getByTestId("status-card-edge").className).toContain("bg-amber-500");
  });

  it("keeps the message's menu, reactions and replies: React from the ⋮, chips under the card, a swipe or a long press", async () => {
    const reacted: string[] = [];
    const { user, container } = renderApp(<MessageBubble message={message(card(), { reactions: { peer: { e: "👍", n: 1, at: 1 } } })} peerPubKey="peer"
      onReply={() => {}} onReact={e => reacted.push(e)} reactionName={() => "Bot"} />);
    const surface = container.querySelector<HTMLElement>("[data-message-card]")!;
    // The chips sit under the card, not in it.
    const chip = screen.getByTestId("reaction-chip");
    expect(surface).not.toContainElement(chip);
    expect(surface.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await user.click(screen.getByTestId("message-options"));
    const rows = within(screen.getByTestId("message-menu")).getAllByRole("button").map(b => b.dataset.testid);
    expect(rows).toEqual(expect.arrayContaining(["message-reply", "message-react", "message-details"]));
    await user.click(screen.getByTestId("message-react"));
    await user.click(within(screen.getByTestId("reaction-bar")).getAllByRole("button")[0]);
    expect(reacted).toHaveLength(1);
  });

  it("a finger held on the card itself opens the quick bar, and does not open the card", async () => {
    const { container } = renderApp(<MessageBubble message={message(card())} peerPubKey="peer" onReact={() => {}} reactionName={() => "Bot"} />);
    const toggle = screen.getByTestId("status-card-toggle");
    vi.useFakeTimers();
    try {
      fireEvent.pointerDown(toggle, { pointerType: "touch", button: 0, clientX: 20, clientY: 20, pointerId: 1 });
      act(() => { vi.advanceTimersByTime(600); });
      fireEvent.pointerUp(toggle, { pointerType: "touch", clientX: 20, clientY: 20, pointerId: 1 });
      fireEvent.click(toggle);
    } finally { vi.useRealTimers(); }
    expect(screen.getByTestId("reaction-bar")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // The next tap opens it, as ever.
    fireEvent.pointerDown(toggle, { pointerType: "mouse", button: 0 });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector("[data-message-card]")).toBeInTheDocument();
  });

  it("in a 1:1 chat has no name over it", () => {
    renderApp(<MessageBubble message={message(card(), { nick: "Coordinator" })} peerPubKey="peer" peerNick="Coordinator" />);
    expect(screen.queryByTestId("message-nick")).not.toBeInTheDocument();
  });

  it("a quote of it, and the chat list, read its title, not its fallback text", () => {
    const c = card({ progress: 40, step: "CI" });
    const index = replyIndex([{ id: "m1", sender: "peer", text: statusCardText(c), card: c, timestamp: 1 } as never]);
    expect(quoteFor({ id: "m1", messageId: "m1" } as never, index, () => "Bot").snippet).toBe("Fix relay rotation");
    expect(messageSnippet({ text: statusCardText(c), card: c })).toBe("Fix relay rotation");
  });

  it("reads right to left in Arabic, the card at the start of the line", () => {
    const { container } = renderApp(<MessageBubble message={message(card({ progress: 67 }))} peerPubKey="peer" />, { language: "ar" });
    expect(screen.getByRole("group")).toHaveAccessibleName("مهمة: Fix relay rotation، قيد التنفيذ، 67%");
    expect(container.querySelector("[data-message-row]")!.className).toContain("justify-start");
  });
});

describe("how long a task has been at it", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("reads in minutes, hours and days, in the interface's language", () => {
    expect(durationIn("en")(10_000)).toBe("1 min");
    expect(durationIn("en")(12 * 60_000)).toBe("12 min");
    expect(durationIn("en")(80 * 60_000)).toBe("1 hr 20 min");
    expect(durationIn("en")(2 * 3_600_000)).toBe("2 hr");
    expect(durationIn("en")(51 * 3_600_000)).toMatch(/^2 days 3 hr$/);
    expect(durationIn("pt")(80 * 60_000)).toMatch(/^1 h 20 min$/);
  });

  it("while running, blocked or queued is since it started; once done or failed, how long it took; nothing without a start", () => {
    const start = NOW - 42 * 60_000;
    expect(taskElapsed(task({ startedAt: start }), NOW)).toEqual({ kind: "running", ms: 42 * 60_000 });
    expect(taskElapsed(task({ startedAt: start, status: "blocked" }), NOW)?.kind).toBe("blocked");
    expect(taskElapsed(task({ startedAt: start, status: "done", updatedAt: start + 30 * 60_000 }), NOW)).toEqual({ kind: "took", ms: 30 * 60_000 });
    // No update time on the card: the message's last change.
    expect(taskElapsed(task({ startedAt: start, status: "failed" }), NOW, start + 5 * 60_000)).toEqual({ kind: "took", ms: 5 * 60_000 });
    expect(taskElapsed(task({ startedAt: start, status: "cancelled" }), NOW)).toBeUndefined();
    expect(taskElapsed(task(), NOW)).toBeUndefined();
  });

  it("shows on the card and in the Tasks panel, and moves once a minute while the card is on screen", async () => {
    // Every card on screen.
    vi.stubGlobal("IntersectionObserver", class {
      constructor(private cb: IntersectionObserverCallback) {}
      observe(el: Element) { this.cb([{ target: el, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
      unobserve() {} disconnect() {}
    });
    vi.useFakeTimers({ now: NOW, toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    const c = card({ startedAt: NOW - 12.5 * 60_000 });
    renderApp(<><MessageBubble message={message(c)} peerPubKey="peer" /><TasksButton rows={[row("m1", c)]} /></>);
    expect(screen.getByTestId("status-card-elapsed")).toHaveTextContent("running for 12 min");
    const before = screen.getByTestId("status-card-elapsed").textContent;
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByTestId("status-card-elapsed").textContent).not.toBe(before);
    act(() => { screen.getByTestId("chat-tasks").click(); });
    expect(screen.getByTestId("chat-tasks-item-elapsed")).toHaveTextContent("running for 13 min");
  });

  it("stands still off screen", () => {
    vi.stubGlobal("IntersectionObserver", class {
      constructor(private cb: IntersectionObserverCallback) {}
      observe(el: Element) { this.cb([{ target: el, isIntersecting: false } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
      unobserve() {} disconnect() {}
    });
    vi.useFakeTimers({ now: NOW, toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    renderApp(<MessageBubble message={message(card({ startedAt: NOW - 12 * 60_000 }))} peerPubKey="peer" />);
    const before = screen.getByTestId("status-card-elapsed").textContent;
    expect(vi.getTimerCount()).toBe(0);
    act(() => { vi.advanceTimersByTime(5 * 60_000); });
    expect(screen.getByTestId("status-card-elapsed").textContent).toBe(before);
  });

  it("a finished one says how long it took; a cancelled one, or one with no start, says nothing", () => {
    renderApp(<>
      <MessageBubble message={message(card({ id: "a", status: "done", startedAt: NOW - 50 * 60_000, updatedAt: NOW - 8 * 60_000 }), { id: "a" })} peerPubKey="peer" />
      <MessageBubble message={message(card({ id: "b", status: "cancelled", startedAt: NOW - 50 * 60_000 }), { id: "b" })} peerPubKey="peer" />
      <MessageBubble message={message(card({ id: "c" }), { id: "c" })} peerPubKey="peer" />
    </>);
    expect(screen.getAllByTestId("status-card-elapsed").map(e => e.textContent)).toEqual(["took 42 min"]);
  });
});

describe("a routine card in the chat", () => {
  const routine = (extra: Record<string, unknown> = {}) => readStatusCard({ kind: "routine", id: "nightly", name: "Nightly bug hunt", schedule: "every day 01:00", state: "active", ...extra })!;

  it("is its name, then its schedule, next run and last run's result; opened, the whole name, the last run's result, when and words", async () => {
    const c = routine({ lastRun: { at: NOW - 2 * 3_600_000, result: "failed", summary: "CI flaked" }, nextRunAt: NOW + 3 * 3_600_000 + 60_000 });
    const { user } = renderApp(<MessageBubble message={message(c)} peerPubKey="peer" />);
    const shown = screen.getByTestId("status-card");
    expect(shown).toHaveAttribute("data-kind", "routine");
    const line = within(shown).getByTestId("status-card-toggle");
    expect(within(line).getByTestId("status-card-title")).toHaveTextContent("Nightly bug hunt");
    expect(within(line).getByTestId("status-card-schedule")).toHaveTextContent("every day 01:00");
    expect(within(line).getByTestId("status-card-next")).toHaveTextContent("in 3 hr.");
    // The name is cut to its line, and says itself whole on hover.
    expect(within(line).getByTestId("status-card-title")).toHaveClass("truncate");
    expect(within(line).getByTestId("status-card-title")).toHaveAttribute("title", "Nightly bug hunt");
    const last = within(line).getByTestId("status-card-last");
    expect(last).toHaveAttribute("data-result", "failed");
    expect(last).toHaveTextContent("FailedLast run: Failed");
    expect(last.className).toContain("text-danger-ink");
    // No block of its own inside (its facts go under the name only on a narrow card, by the stylesheet); nothing else until it is opened.
    expect(line.querySelectorAll("br, p, div")).toHaveLength(0);
    expect(screen.queryByTestId("status-card-details")).not.toBeInTheDocument();
    expect(screen.queryByTestId("message-text")).not.toBeInTheDocument();
    await user.click(line);
    const run = screen.getByTestId("status-card-last-run");
    expect(run).toHaveTextContent(/Failed\s*2 h ago/);
    expect(run).toHaveTextContent("Next in 3 hr.");
    expect(screen.getByTestId("status-card-summary")).toHaveTextContent("CI flaked");
    // Opened, the name wraps instead of being cut, and the card says when it last changed.
    expect(within(line).getByTestId("status-card-title")).not.toHaveClass("truncate");
    expect(screen.getByTestId("status-card-time").textContent).toMatch(/\d{1,2}:\d{2}/);
  });

  it("opens in place on its recent runs and cron line; a paused one shows no next run", async () => {
    const runs = [{ at: NOW - 86_400_000, result: "ok", summary: "12 issues" }, { at: NOW - 2 * 86_400_000, result: "skipped" }];
    const { user } = renderApp(<MessageBubble message={message(routine({ state: "paused", cron: "0 1 * * *", runs, lastRun: runs[0], nextRunAt: NOW + 60_000 }))} peerPubKey="peer" />);
    expect(screen.getByTestId("status-card-status")).toHaveTextContent("Paused");
    expect(screen.queryByTestId("status-card-next")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("status-card-toggle"));
    expect(screen.getAllByTestId("status-card-run").map(r => r.dataset.result)).toEqual(["ok", "skipped"]);
    expect(screen.getByTestId("status-card-details")).toHaveTextContent("Cron0 1 * * *");
    expect(screen.getByTestId("status-card-details")).toHaveTextContent("Scheduleevery day 01:00");
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
    const faces: Record<string, { key: string; name: string; picture?: string }> = {
      [hermes]: { key: hermes, name: "Hermes One", picture: "data:image/png;base64,iVBORw0KGgo=" }, [coordinator]: { key: coordinator, name: "Coordinator" },
    };
    const { user } = renderApp(<TasksButton rows={rows} nameOf={author => names[author] ?? "?"} faceOf={author => faces[author]} />);
    expect(screen.getByTestId("chat-tasks-count")).toHaveTextContent("3");
    await user.click(screen.getByTestId("chat-tasks"));
    const sections = screen.getAllByTestId("chat-tasks-sender");
    expect(sections.map(s => within(s).getByTestId("chat-tasks-sender-name").textContent)).toEqual(["Coordinator", "Hermes One"]);
    // Each bot's face before its name: its picture, else its initial in its colour.
    const face = (s: HTMLElement) => within(s.querySelector("h3")!).getByTestId("member-face");
    expect(face(sections[0])).toHaveTextContent("C");
    expect(face(sections[0]).querySelector("span")!.className).toMatch(/text-member-/);
    expect(face(sections[1]).querySelector("img")).toHaveAttribute("src", faces[hermes].picture);
    expect(sections.map(s => within(s).getByTestId("chat-tasks-sender-count").textContent)).toEqual(["2 active", "1 active"]);
    expect(within(sections[1]).getAllByTestId("chat-tasks-item").map(i => i.dataset.cardId)).toEqual(["bench"]);
    // A finished task goes to the folded section at the end, with its sender's name.
    await user.click(screen.getByTestId("chat-tasks-finished-toggle"));
    const done = within(screen.getByTestId("chat-tasks-finished")).getByTestId("chat-tasks-item");
    expect(done).toHaveAttribute("data-card-id", "nightly");
    expect(done).toHaveTextContent("Hermes One");
    expect(within(done).getByTestId("member-face")).toHaveAttribute("data-key", hermes);
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
    expect(within(sections[0]).getByTestId("chat-tasks-sender-name").parentElement!.className).toMatch(/\bsticky\b.*\btop-0\b.*\bh-8\b/);
    // The list keeps that much room above a row it scrolls to, and snaps its rows there: none stops half under a name.
    expect(screen.getByTestId("chat-tasks-scroll").className).toMatch(/\bsnap-y\b.*\bscroll-pt-8\b/);
    expect(screen.getAllByTestId("chat-tasks-item").every(r => r.className.includes("snap-start"))).toBe(true);
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
    expect(panel.className).toContain("max-h-[calc(100dvh_-_2.5rem_-_env(safe-area-inset-top))]");
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

describe("routines in a row in the chat", () => {
  const r = (id: string, extra: Record<string, unknown> = {}) => readStatusCard({ kind: "routine", id, name: `Zero · ${id}`, schedule: "every hour", state: "active", ...extra }) as RoutineCard;
  const msg = (id: string, c: StatusCard | undefined, member = "z", sender: "me" | "peer" = "peer") => ({ id, card: c, member, sender });

  it("fold from three in a row from one sender; another sender, a task or a text ends a run", () => {
    const rows = [
      msg("a1", r("1")), msg("a2", r("2")), msg("a3", r("3")),
      msg("t", card()),
      msg("b1", r("4")), msg("b2", r("5")),
      msg("c1", r("6"), "o"), msg("c2", r("7"), "o"), msg("c3", r("8"), "o"), msg("c4", r("9"), "o"),
      msg("x", undefined, "o"),
      msg("d1", r("10"), "o"), msg("d2", r("11"), "o"), msg("d3", r("12"), "z"),
    ];
    const stacks = routineStacks(rows, m => m);
    expect([...stacks].map(([first, run]) => [first, run.map(m => m.id)])).toEqual([["a1", ["a1", "a2", "a3"]], ["c1", ["c1", "c2", "c3", "c4"]]]);
  });

  const Stack = ({ n }: { n: number }) => {
    const cards = Array.from({ length: n }, (_, i) => r(`r${i}`, { nextRunAt: NOW + (i + 2) * 60_000 + 20_000, lastRun: { at: NOW - 1000, result: i === 1 ? "failed" : "ok" } }));
    return <RoutineStack name="Hermes Zero" mine={false} cards={cards}>
      {cards.map((c, i) => <MessageBubble key={i} message={message(c, { id: `m${i}` })} peerPubKey="peer" />)}
    </RoutineStack>;
  };

  it("show as one row saying whose, how many, the next run and how the last runs went; a tap opens their cards", async () => {
    const { user } = renderApp(<Stack n={10} />);
    const toggle = screen.getByTestId("routine-stack-toggle");
    // A card's row, not a bubble: the sender's name above it.
    expect(screen.getByTestId("routine-stack-name")).toHaveTextContent("~Hermes Zero");
    expect(toggle).toHaveTextContent("↻10 routines· next in 2 min.· ✕ 1 failed");
    expect(toggle).toHaveClass("status-card-surface");
    expect(toggle.className).not.toMatch(/\bbg-(sent|received)-bg\b/);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // Folded, the cards stay in the page (a jump finds them) but hidden.
    const list = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(list).toHaveAttribute("hidden");
    expect(within(list).getAllByTestId("status-card")).toHaveLength(10);
    expect(screen.queryAllByRole("button", { name: /Zero ·/ })).toHaveLength(0);
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(list).not.toHaveAttribute("hidden");
    expect(screen.getAllByRole("button", { name: /Zero ·/ })).toHaveLength(10);
  });

  it("open when something jumps to one of them", () => {
    renderApp(<Stack n={4} />);
    expect(screen.getByTestId("routine-stack")).not.toHaveAttribute("data-open");
    expect(jumpToMessage("m2")).toBe(true);
    expect(screen.getByTestId("routine-stack")).toHaveAttribute("data-open");
    expect(screen.getAllByTestId("status-card")).toHaveLength(4);
  });

  it("keep the sender's picture beside the folded row, and leave it to the last card once open (never both)", async () => {
    const cards = [1, 2, 3].map(i => readStatusCard({ kind: "routine", id: `r${i}`, name: `R${i}`, schedule: "hourly", state: "active" }) as RoutineCard);
    const author = { key: "z".repeat(52), name: "Hermes Zero", first: true, last: true };
    const { user } = renderApp(<RoutineStack name="Hermes Zero" cards={cards} mine={false} author={author}>
      {cards.map((c, i) => <MessageBubble key={c.id} message={message(c, { id: `m${i}` })} peerPubKey="peer" author={{ ...author, first: false, last: i === 2 }} />)}
    </RoutineStack>);
    const toggleRow = screen.getByTestId("routine-stack-toggle").closest(".message-row-x")!;
    expect(within(toggleRow as HTMLElement).getByTestId("sender-avatar")).toBeInTheDocument();
    await user.click(screen.getByTestId("routine-stack-toggle"));
    expect(within(toggleRow as HTMLElement).queryByTestId("sender-avatar")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("sender-avatar")).toHaveLength(1);
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
