import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readStatusCard, type TaskCard, type UsageCard } from "@ghostly/core";
import type { CardIndexRow, StoredMessage } from "@ghostly/browser/shared/types";
import { useUsageByPeer } from "../../hooks/useUsage";
import { useWorkingByPeer } from "../../hooks/useWorking";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.status-cards.working

/*
 * The engine sends a new state a few times a second while nothing happens, and every 50 ms while a file moves: each a
 * new copy of the chats. The working marks and the usage meters come from the card index, which holds every card of
 * the profile: they are worked out again when a card changes, not at every state.
 */

const counts = vi.hoisted(() => ({ entries: 0, usage: 0 }));

vi.mock("../../lib/taskBoard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/taskBoard")>();
  return { ...actual, boardEntries: (...args: Parameters<typeof actual.boardEntries>) => { counts.entries++; return actual.boardEntries(...args); } };
});

vi.mock("../../lib/usage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/usage")>();
  return { ...actual, usageByChat: (...args: Parameters<typeof actual.usageByChat>) => { counts.usage++; return actual.usageByChat(...args); } };
});

const NOW = Date.now();
const MIN = 60_000;
const task = (extra: Record<string, unknown> = {}) => readStatusCard({ kind: "task", id: "run", title: "Ship the fix", status: "running", ...extra }) as TaskCard;
const usage = readStatusCard({ kind: "usage", id: "usage", label: "Claude", left: 62 }) as UsageCard;
const row = (id: string, linkId: string, card: CardIndexRow["card"], editedAt: number): CardIndexRow => ({ linkId, id, card, sender: "peer", timestamp: NOW - 60 * MIN, editedAt });
const links = [linkView({ id: "link-1", peerPubKeyZ32: "peer-hermes" }), linkView({ id: "link-2", peerPubKeyZ32: "peer-idle" })];

/** The contacts' marks and meters, as the chat list reads them. */
function Marks() {
  const working = useWorkingByPeer(), meters = useUsageByPeer();
  return <ul>
    {[...working].map(([peer, found]) => <li key={peer} data-testid={`working-${peer}`}>{found.title}</li>)}
    {[...meters].map(([peer, found]) => <li key={peer} data-testid={`usage-${peer}`}>{found.card.left}</li>)}
  </ul>;
}

describe("the chat list's working marks and usage meters", () => {
  beforeEach(() => { counts.entries = 0; counts.usage = 0; });

  it("are not worked out again by an engine state that changes no card, and follow a card that changes", async () => {
    const { engine } = renderApp(<Marks />);
    let rows = [row("card-1", "link-1", task(), NOW - MIN), row("card-2", "link-1", usage, NOW - MIN)];
    engine.on("statusCardIndex", () => rows).setState({ links, groups: [] });
    expect(await screen.findByTestId("working-peer-hermes")).toHaveTextContent("Ship the fix");
    expect(screen.getByTestId("usage-peer-hermes")).toHaveTextContent("62");
    counts.entries = 0; counts.usage = 0;

    // The same chats again, each state a new copy (as the engine's are).
    for (let i = 0; i < 5; i++) act(() => engine.setState(structuredClone(engine.state)));
    expect(counts).toEqual({ entries: 0, usage: 0 });
    expect(screen.getByTestId("working-peer-hermes")).toHaveTextContent("Ship the fix");

    // The contact's key comes with a later state (a chat just paired): the mark follows, from the cards already read.
    act(() => engine.setState({ links: [linkView({ id: "link-1", peerPubKeyZ32: "peer-renamed" }), links[1]], groups: [] }));
    expect(screen.getByTestId("working-peer-renamed")).toHaveTextContent("Ship the fix");
    expect(screen.queryByTestId("working-peer-hermes")).not.toBeInTheDocument();
    expect(counts).toEqual({ entries: 0, usage: 0 });

    // The task is done: the index is read again, and the mark goes.
    rows = [row("card-1", "link-1", task({ status: "done" }), NOW), rows[1]];
    act(() => engine.messages("link-1", [{ id: "card-1", linkId: "link-1", sender: "peer", text: "", timestamp: NOW - 60 * MIN, via: "datalink", card: rows[0].card, edit: { seq: 1, at: NOW, history: [] } } as StoredMessage]));
    await waitFor(() => expect(screen.queryByTestId("working-peer-renamed")).not.toBeInTheDocument());
    expect(screen.getByTestId("usage-peer-renamed")).toHaveTextContent("62");
    expect(counts).toEqual({ entries: 1, usage: 1 });
  });
});
