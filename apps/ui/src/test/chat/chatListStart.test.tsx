import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CardIndexRow } from "@ghostly/browser/shared/types";
import { readStatusCard, type TaskCard } from "@ghostly/core";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { saveSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { fakeEngine, groupView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chats.list.rows, chat.tasks-board

const chat = (id: string, nick: string): ChatSession =>
  ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: id.repeat(52), encKeyB64: "enc", messages: [], createdAt: 1, nick });
const task = readStatusCard({ kind: "task", id: "relay", title: "Fix relay rotation", status: "running" }) as TaskCard;
const card: CardIndexRow = { linkId: "a", id: "m1", card: task, sender: "peer", timestamp: 1 };

/** The rows of the chat list, top to bottom: a group's id or a chat's name. */
const rows = () => [...screen.getByTestId("chat-list").querySelectorAll<HTMLElement>("[data-testid=group-row], [data-testid=chat-row]")]
  .map(r => r.dataset.group ?? within(r).getByTestId("chat-row-name").textContent);

describe("The chat list as the app starts", () => {
  it("draws no row until the engine has loaded its groups, then the groups and the chats at once: no row drawn first is pushed down", () => {
    // The chats are in the page's storage at once; the groups come with the engine's state, after every chat's history.
    saveSession(chat("a", "Ana"));
    fakeEngine.update({ groups: [], groupsLoaded: undefined });
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    expect(rows()).toEqual([]);
    expect(screen.getByTestId("chat-list")).toHaveAttribute("aria-busy", "true");

    act(() => fakeEngine.update({ groups: [groupView({ id: "g1", status: "active" })], groupsLoaded: true }));
    expect(rows()).toEqual(["g1", "Ana"]);
    expect(screen.getByTestId("chat-list")).not.toHaveAttribute("aria-busy");
  });

  it("keeps the place of the way to the Tasks board from the last start, before the cards are read", async () => {
    let answer: (rows: CardIndexRow[]) => void = () => {};
    fakeEngine.on("statusCardIndex", () => new Promise<CardIndexRow[]>(done => { answer = done; }));
    saveSession(chat("a", "Ana"));
    const first = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    // The first start of a profile with a card: the way comes once the cards are read.
    expect(screen.queryByTestId("sidebar-tasks")).not.toBeInTheDocument();
    await waitFor(() => expect(fakeEngine.callsTo("statusCardIndex")).toHaveLength(1));
    act(() => answer([card]));
    expect(await screen.findByTestId("sidebar-tasks")).toHaveAccessibleName("Tasks, 1 active");
    first.unmount();

    // The next start: it is there with the first rows, before the cards are read, and what they say fills it in.
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    expect(screen.getByTestId("sidebar-tasks")).toBeInTheDocument();
    expect(rows()).toEqual(["Ana"]);
    await waitFor(() => expect(fakeEngine.callsTo("statusCardIndex")).toHaveLength(2));
    act(() => answer([card]));
    await waitFor(() => expect(screen.getByTestId("sidebar-tasks")).toHaveAccessibleName("Tasks, 1 active"));
  });

  it("forgets the way to the Tasks board once the cards read say there are none", async () => {
    fakeEngine.on("statusCardIndex", () => [card]);
    const first = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    await screen.findByTestId("sidebar-tasks");
    first.unmount();

    fakeEngine.on("statusCardIndex", () => []);
    const second = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    await waitFor(() => expect(screen.queryByTestId("sidebar-tasks")).not.toBeInTheDocument());
    second.unmount();
    // Nor is it drawn at the start after that.
    fakeEngine.on("statusCardIndex", () => new Promise<CardIndexRow[]>(() => {}));
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    expect(screen.queryByTestId("sidebar-tasks")).not.toBeInTheDocument();
  });
});
