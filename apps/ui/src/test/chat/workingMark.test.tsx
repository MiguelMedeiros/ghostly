import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readStatusCard, type TaskCard, type UsageCard } from "@ghostly/core";
import type { CardIndexRow, StoredMessage } from "@ghostly/browser/shared/types";
import { ChatRow, type ChatRowProps } from "../../components/ChatRow";
import { WorkingDot } from "../../components/chat/WorkingMark";
import { useWorkingByPeer } from "../../hooks/useWorking";
import { WORKING_FRESH_MS, workingByChat, workingQuietMs, workingState, type WorkingEntry } from "../../lib/working";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.status-cards.working

/** Whether a bot is working (WISP 405 § Showing a card): what its running task cards say, and the dot on its chat's row. */

const NOW = Date.now();
const MIN = 60_000;
const task = (extra: Record<string, unknown> = {}) => readStatusCard({ kind: "task", id: "t1", title: "Ship the fix", status: "running", ...extra }) as TaskCard;
const usage = readStatusCard({ kind: "usage", id: "usage", label: "Claude", left: 62 }) as UsageCard;
let n = 0;
const row = (linkId: string, card: CardIndexRow["card"], patch: Partial<CardIndexRow> = {}): CardIndexRow => ({ linkId, id: `m${++n}`, card, sender: "peer", timestamp: NOW - 60 * MIN + n, ...patch });
const entry = (over: Partial<WorkingEntry> = {}): WorkingEntry => ({ title: "Ship the fix", at: NOW - MIN, count: 1, ...over });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("a chat's running tasks", () => {
  it("a running task updated lately is working; one gone quiet for more than 15 minutes is stale", () => {
    const fresh = workingByChat([row("link-1", task({ step: "Running the tests" }), { editedAt: NOW - 14 * MIN })]).get("link-1")!;
    expect(fresh).toEqual({ title: "Ship the fix", step: "Running the tests", at: NOW - 14 * MIN, count: 1 });
    expect(workingState(fresh, NOW)).toBe("working");
    expect(workingState(fresh, NOW + MIN)).toBe("working");
    expect(workingState(fresh, NOW + MIN + 1)).toBe("stale");
    expect(WORKING_FRESH_MS).toBe(15 * MIN);
    // Never edited: when it was sent counts.
    const old = workingByChat([row("link-1", task(), { timestamp: NOW - 40 * MIN })]).get("link-1")!;
    expect(workingState(old, NOW)).toBe("stale");
    expect(workingQuietMs(old, NOW)).toBe(40 * MIN);
  });

  it("no running task, no mark: queued, blocked and finished tasks, routines and usage cards say nothing", () => {
    const rows = [
      ...(["queued", "blocked", "done", "failed", "cancelled"] as const).map((status, i) => row("link-1", task({ id: `t${i}`, status }), { editedAt: NOW })),
      row("link-1", readStatusCard({ kind: "routine", id: "r1", name: "Nightly", schedule: "daily", state: "active" }) as CardIndexRow["card"], { editedAt: NOW }),
      row("link-1", usage, { editedAt: NOW }),
    ];
    expect(workingByChat(rows).size).toBe(0);
  });

  it("the newest message of a card stands for it: a task sent again as done is no longer running", () => {
    const rows = [row("link-1", task(), { timestamp: NOW - 10 * MIN }), row("link-1", task({ status: "done" }), { timestamp: NOW - 5 * MIN })];
    expect(workingByChat(rows).size).toBe(0);
  });

  it("several running tasks: the one updated last gives the title and the time, the rest are counted", () => {
    const rows = [
      row("link-1", task({ id: "a", title: "Old one" }), { editedAt: NOW - 50 * MIN }),
      row("link-1", task({ id: "b", title: "Newest", step: "Step 2" }), { editedAt: NOW - 2 * MIN }),
      row("link-1", task({ id: "c", title: "Middle" }), { editedAt: NOW - 20 * MIN }),
      row("link-2", task({ id: "a", title: "Other bot" }), { editedAt: NOW - 30 * MIN }),
    ];
    const by = workingByChat(rows);
    expect(by.get("link-1")).toEqual({ title: "Newest", step: "Step 2", at: NOW - 2 * MIN, count: 3 });
    expect(workingState(by.get("link-1")!, NOW)).toBe("working");
    expect(by.get("link-2")).toMatchObject({ title: "Other bot", count: 1 });
    expect(workingState(by.get("link-2")!, NOW)).toBe("stale");
  });

  it("a card of mine and a group's are not a contact's work", () => {
    const rows = [row("link-1", task(), { sender: "me", editedAt: NOW }), row("group:g1", task(), { member: "bot-key", editedAt: NOW })];
    expect(workingByChat(rows).size).toBe(0);
  });

  it("a sender's clock ahead: an update from the future is working, and never a negative time", () => {
    const ahead = workingByChat([row("link-1", task(), { editedAt: NOW + 5 * MIN })]).get("link-1")!;
    expect(workingState(ahead, NOW)).toBe("working");
    expect(workingQuietMs(ahead, NOW)).toBe(0);
  });
});

describe("the dot", () => {
  it("working: the accent, a pulse only for who allows motion, and its name, title and step for a pointer", () => {
    renderApp(<WorkingDot entry={entry({ step: "Running the tests" })} testId="dot" />);
    const dot = screen.getByTestId("dot");
    expect(dot).toHaveAttribute("data-state", "working");
    expect(dot).toHaveAccessibleName("Working");
    expect(dot).toHaveAttribute("title", "Working · Ship the fix · Running the tests");
    expect(dot.firstElementChild!.className).toContain("bg-accent");
    expect(dot.firstElementChild!.className).toContain("motion-safe:animate-pulse");
    expect(dot.firstElementChild!.className).not.toMatch(/(^| )animate-/);
  });

  it("stale: a muted ring, still, and says for how long nothing came", () => {
    renderApp(<WorkingDot entry={entry({ at: NOW - 40.5 * MIN })} testId="dot" />);
    const dot = screen.getByTestId("dot");
    expect(dot).toHaveAttribute("data-state", "stale");
    expect(dot).toHaveAccessibleName("No update for 40 min");
    expect(dot).toHaveAttribute("title", "No update for 40 min · Ship the fix");
    // A ring, not a filled dot: told from working by its shape too, whatever the theme's colours.
    expect(dot.firstElementChild!.className).toContain("border-text-muted");
    expect(dot.firstElementChild!.className).not.toMatch(/animate|bg-/);
  });

  it("turns stale by itself once the task has been quiet for 15 minutes", () => {
    // The row is on screen: the page's clock moves only what is.
    vi.stubGlobal("IntersectionObserver", class {
      constructor(private cb: IntersectionObserverCallback) {}
      observe(el: Element) { this.cb([{ target: el, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
      unobserve() {} disconnect() {}
    });
    vi.useFakeTimers({ now: NOW, toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    renderApp(<WorkingDot entry={entry({ at: NOW - 13 * MIN })} testId="dot" />);
    expect(screen.getByTestId("dot")).toHaveAttribute("data-state", "working");
    act(() => { vi.advanceTimersByTime(2 * MIN); });
    expect(screen.getByTestId("dot")).toHaveAttribute("data-state", "working");
    act(() => { vi.advanceTimersByTime(MIN); });
    expect(screen.getByTestId("dot")).toHaveAttribute("data-state", "stale");
  });

  it("says it in the app's language", () => {
    renderApp(<WorkingDot entry={entry({ at: NOW - 40.5 * MIN })} testId="dot" />, { language: "pt" });
    expect(screen.getByTestId("dot")).toHaveAccessibleName(/^Sem atualização há 40 min/);
  });
});

describe("the dot's place on a chat's row", () => {
  const props = (over: Partial<ChatRowProps> = {}) => ({ chatId: "chat-1", density: "compact", active: false, label: "Hermes", named: true, keyLabel: "abcdef...uvwxyz", peerPubKey: "peer", time: "12:00",
    unread: 2, pinned: false, syncing: false, creator: false, onOpen: () => {}, onTogglePin: () => {}, onDelete: () => {}, deleteLabel: "Delete", ...over }) as ChatRowProps;
  const meter: ChatRowProps["usage"] = { card: usage, messageId: "m1", at: NOW - MIN };
  const trailing = () => screen.getByTestId("chat-row-preview").nextElementSibling;
  /** The classes that give an element its width. */
  const widths = (el: Element) => el.className.split(" ").filter((c) => /^(min-w-|w-|gap-|shrink)/.test(c)).sort().join(" ");

  it("comfortable: right after the key and before the meter; a row with a meter and no task keeps the dot's place empty", () => {
    const { rerender } = renderApp(<ChatRow {...props({ density: "comfortable" })} usage={meter} working={entry()} />);
    const key = screen.getByTestId("chat-row-key");
    const dot = screen.getByTestId("chat-row-working");
    expect(key.nextElementSibling).toBe(dot);
    expect(dot.nextElementSibling).toBe(screen.getByTestId("chat-row-usage"));
    expect(trailing()).not.toContainElement(dot);
    const taken = widths(dot);
    rerender(<ChatRow {...props({ density: "comfortable" })} usage={meter} />);
    expect(screen.queryByTestId("chat-row-working")).not.toBeInTheDocument();
    const gap = screen.getByTestId("chat-row-working-gap");
    expect(screen.getByTestId("chat-row-key").nextElementSibling).toBe(gap);
    expect(gap.nextElementSibling).toBe(screen.getByTestId("chat-row-usage"));
    expect(widths(gap)).toBe(taken);
    expect(gap).toHaveAttribute("aria-hidden", "true");
  });

  it("comfortable, no meter: the dot alone after the key, and nothing kept once it goes", () => {
    const { rerender } = renderApp(<ChatRow {...props({ density: "comfortable" })} working={entry()} />);
    expect(screen.getByTestId("chat-row-key").nextElementSibling).toBe(screen.getByTestId("chat-row-working"));
    expect(screen.getByTestId("chat-row-unread").parentElement).toBe(trailing());
    rerender(<ChatRow {...props({ density: "comfortable" })} />);
    expect(screen.getByTestId("chat-row-key").nextElementSibling).toBeNull();
  });

  it.each([2, 0])("compact: starts the trailing column, before the meter; the column and the count (%i unread) stay put when it comes and goes", (unread) => {
    const { rerender } = renderApp(<ChatRow {...props({ unread })} usage={meter} />);
    const shape = () => {
      const column = trailing()!.firstElementChild!;
      const start = column.firstElementChild!;
      return { column: column.className, start: start.className, first: widths(start.firstElementChild!), second: start.lastElementChild, children: column.childElementCount,
        last: unread ? column.lastElementChild : null };
    };
    const without = shape();
    expect(without.column).toContain("min-w-[119px]");
    expect(without.column).toContain("justify-between");
    expect(trailing()!.firstElementChild!.firstElementChild!.firstElementChild).toBe(screen.getByTestId("chat-row-working-gap"));
    rerender(<ChatRow {...props({ unread })} usage={meter} working={entry()} />);
    const withDot = shape();
    expect(trailing()!.firstElementChild!.firstElementChild!.firstElementChild).toBe(screen.getByTestId("chat-row-working"));
    expect(withDot.second).toBe(screen.getByTestId("chat-row-usage"));
    expect({ ...withDot, second: null, last: null }).toEqual({ ...without, second: null, last: null });
    expect(withDot.children).toBe(unread ? 2 : 1);
    if (unread) expect(withDot.last).toBe(screen.getByTestId("chat-row-unread"));
  });

  it("compact, no meter: the dot starts the same column, the count at its end; no column without it", () => {
    const { rerender } = renderApp(<ChatRow {...props()} working={entry({ at: NOW - 40 * MIN })} />);
    const dot = screen.getByTestId("chat-row-working");
    expect(dot).toHaveAttribute("data-state", "stale");
    const column = trailing()!.firstElementChild!;
    expect(column.className).toContain("min-w-[119px]");
    expect(column.firstElementChild!.firstElementChild).toBe(dot);
    expect(column.lastElementChild).toBe(screen.getByTestId("chat-row-unread"));
    expect(screen.queryByTestId("chat-row-usage")).not.toBeInTheDocument();
    rerender(<ChatRow {...props()} />);
    expect(screen.queryByTestId("chat-row-working")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-row-working-gap")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-row-unread").parentElement).toBe(trailing());
  });
});

/** The contacts' marks from the engine's card index, as the chat list reads them. */
function Marks() {
  const by = useWorkingByPeer();
  return <ul>{[...by].map(([peer, found]) => <li key={peer} data-testid={`working-${peer}`}>{found.title} · {found.count}</li>)}<li data-testid="working-count">{by.size}</li></ul>;
}

describe("the chat list's marks", () => {
  it("come from the card index, by the contact's key, and go when the task is done", async () => {
    const rendered = renderApp(<Marks />);
    const links = [linkView({ id: "link-1", peerPubKeyZ32: "peer-hermes" }), linkView({ id: "link-2", peerPubKeyZ32: "peer-idle" })];
    let rows = [row("link-1", task({ id: "run" }), { id: "card-1", editedAt: NOW - MIN }), row("link-2", task({ status: "done" }), { editedAt: NOW })];
    rendered.engine.on("statusCardIndex", () => rows).setState({ links, groups: [] });
    expect(await screen.findByTestId("working-peer-hermes")).toHaveTextContent("Ship the fix · 1");
    expect(screen.getByTestId("working-count")).toHaveTextContent("1");
    rows = [row("link-1", task({ id: "run", status: "done" }), { id: "card-1", editedAt: NOW })];
    act(() => rendered.engine.messages("link-1", [{ id: "card-1", linkId: "link-1", sender: "peer", text: "", timestamp: NOW - 60 * MIN, via: "datalink", card: rows[0].card, edit: { seq: 1, at: NOW, history: [] } } as StoredMessage]));
    await waitFor(() => expect(screen.getByTestId("working-count")).toHaveTextContent("0"));
  });
});
