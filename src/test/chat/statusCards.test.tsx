import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { readStatusCard, statusCardText, type StatusCard } from "@ghostly/core";
import { MessageBubble } from "../../components/MessageBubble";
import { TasksButton } from "../../components/chat/TasksButton";
import { activeTaskCount, cardEntries, type CardRow } from "../../lib/statusCards";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";

// covers: chat.status-cards

/** Status cards in the chat (WISP 4xx · Status Cards): the card instead of its text, opened in place; the Tasks button. */

const NOW = Date.now();
const card = (extra: Record<string, unknown> = {}): StatusCard => readStatusCard({ kind: "task", id: "relay", title: "Fix relay rotation", status: "running", ...extra })!;
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

  it("shows a done task's bar full and a failed one in red", () => {
    renderApp(<><MessageBubble message={message(card({ status: "done" }), { id: "a" })} peerPubKey="peer" /><MessageBubble message={message(card({ status: "failed", progress: 30 }), { id: "b" })} peerPubKey="peer" /></>);
    const [done, failed] = screen.getAllByTestId("status-card");
    expect(done.querySelector("[role=progressbar] > div")).toHaveStyle({ width: "100%" });
    expect(failed.querySelector("[role=progressbar] > div")!.className).toContain("bg-danger");
  });

  it("reads right to left in Arabic", () => {
    renderApp(<MessageBubble message={message(card({ status: "blocked" }))} peerPubKey="peer" />, { language: "ar" });
    expect(screen.getByTestId("status-card-status")).toHaveTextContent("متوقفة");
  });

  it("shows a message without a card, or a kind it does not draw, as its text", () => {
    renderApp(<MessageBubble message={{ id: "m", text: "🔁 Nightly", sender: "peer", timestamp: 1, card: readStatusCard({ kind: "routine", id: "r", name: "Nightly", schedule: "daily", state: "active" }) }} peerPubKey="peer" />);
    expect(screen.queryByTestId("status-card")).not.toBeInTheDocument();
    expect(screen.getByTestId("message-text")).toHaveTextContent("🔁 Nightly");
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
    expect(within(within(panel).getByTestId("chat-tasks-finished")).getAllByTestId("chat-tasks-item").map(i => i.dataset.cardId)).toEqual(["b"]);
    expect(within(panel).queryByTestId("chat-tasks-routines")).not.toBeInTheDocument();
    await user.click(within(panel).getAllByTestId("chat-tasks-item").find(i => i.dataset.cardId === "b")!);
    expect(screen.queryByTestId("chat-tasks-panel")).not.toBeInTheDocument();
    expect(screen.getByText("card b").closest("[data-message-id]")).toHaveAttribute("data-reply-flash");
  });

  it("shows no count once every task is finished", () => {
    renderApp(<TasksButton rows={[row("m1", card({ status: "done" }))]} />);
    expect(screen.getByTestId("chat-tasks")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-tasks-count")).not.toBeInTheDocument();
  });
});
