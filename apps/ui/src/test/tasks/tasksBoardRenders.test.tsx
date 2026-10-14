import { act, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readStatusCard, statusCardText, type TaskCard } from "@ghostly/core";
import type { CardIndexRow, GroupMemberView, StoredMessage } from "@ghostly/browser/shared/types";
import { saveSession } from "../../lib/storage";
import { Tasks } from "../../pages/Tasks";
import type { ChatSession } from "../../lib/types";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.tasks-board

/*
 * The engine sends a new state every few hundred milliseconds while nothing happens (its links poll and publish), and
 * one every 50 ms while a file moves: each a new copy. The board is built again, and a card drawn again, only when
 * what it shows changes. Counted by what each step calls: the entries, the columns, a card's name for a screen reader.
 */

const counts = vi.hoisted(() => ({ entries: 0, model: 0, card: 0 }));

vi.mock("../../lib/taskBoard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/taskBoard")>();
  return {
    ...actual,
    boardEntries: (...args: Parameters<typeof actual.boardEntries>) => { counts.entries++; return actual.boardEntries(...args); },
    boardModel: (...args: Parameters<typeof actual.boardModel>) => { counts.model++; return actual.boardModel(...args); },
    boardCardLabel: (...args: Parameters<typeof actual.boardCardLabel>) => { counts.card++; return actual.boardCardLabel(...args); },
  };
});

const NOW = Date.now();
const PEER = "peerkeycoordinator";
const PICTURE = "data:image/jpeg;base64,AAAA";
const task = (extra: Record<string, unknown> = {}) => readStatusCard({ kind: "task", id: "relay", title: "Fix relay rotation", status: "running", ...extra }) as TaskCard;
const session = (patch: Partial<ChatSession> = {}): ChatSession =>
  ({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages: [], createdAt: 1_700_000_000_000, nick: "Coordinator", ...patch });
const member = (patch: Partial<GroupMemberView>) => ({ role: "member", me: false, online: true, missing: 0, ...patch }) as GroupMemberView;
const members = [member({ key: "me-key", me: true, nick: "Me" }), member({ key: "hermes-key", nick: "Hermes One" })];
const link = linkView({ id: "link-1", peerPubKeyZ32: PEER, peerNick: "Coordinator" });
const group = groupView({ id: "g1", name: "Sala de Máquinas", status: "active", members });
const rows: CardIndexRow[] = [
  { linkId: "link-1", id: "m1", card: task(), sender: "peer", timestamp: NOW - 10 * 60_000 },
  { linkId: "group:g1", id: "m2", card: task({ id: "docs", title: "Write the WISP", status: "queued" }), sender: "peer", member: "hermes-key", timestamp: NOW - 9 * 60_000 },
  { linkId: "group:g1", id: "m3", card: task({ id: "ci", title: "Fix the flaky spec", status: "done" }), sender: "peer", member: "hermes-key", timestamp: NOW - 8 * 60_000 },
];

/** The engine's state again, as a copy (the worker's states come through postMessage). */
const sameStateAgain = () => act(() => { fakeEngine.setState(structuredClone(fakeEngine.state)); });
const reset = () => { counts.entries = 0; counts.model = 0; counts.card = 0; };
const card = (id: string) => screen.getByTestId("tasks-board").querySelector<HTMLElement>(`[data-testid="board-card"][data-card-id="${id}"]`)!;

describe("the Tasks board on a state that changes nothing it shows", () => {
  let current = rows;
  beforeEach(async () => {
    current = rows;
    saveSession(session());
    fakeEngine.on("statusCardIndex", () => current);
    fakeEngine.update({ links: [link], groups: [group] });
    renderApp(<Tasks />, { route: "/tasks" });
    await waitFor(() => expect(screen.getAllByTestId("board-card")).toHaveLength(3));
    expect(counts.entries).toBeGreaterThan(0);
    expect(counts.model).toBeGreaterThan(0);
    expect(counts.card).toBeGreaterThanOrEqual(3);
    reset();
  });

  it("is not built again and draws no card again, by the engine's next state or the chats read again from storage", () => {
    sameStateAgain();
    sameStateAgain();
    act(() => { window.dispatchEvent(new Event("session-updated")); });
    expect(counts).toEqual({ entries: 0, model: 0, card: 0 });
  });

  it("nor by a state that changes what the board does not show: a member going offline, a message in a group, a chat's connection", () => {
    act(() => { fakeEngine.update({
      links: [{ ...link, peerOnline: false, dataLink: "idle" }],
      groups: [{ ...group, lastMessageAt: NOW, members: [members[0], { ...members[1], online: false, missing: 2 }] }],
    }); });
    expect(counts).toEqual({ entries: 0, model: 0, card: 0 });
  });

  it("but a group renamed, a member's new name and a contact's new picture show at once", () => {
    act(() => { fakeEngine.update({ groups: [{ ...group, name: "Engine Room" }] }); });
    expect(within(card("docs")).getByTestId("board-card-chat")).toHaveTextContent("Engine Room");
    expect(counts.entries).toBe(1);

    act(() => { fakeEngine.update({ groups: [{ ...group, name: "Engine Room", members: [members[0], { ...members[1], nick: "Hermes Two" }] }] }); });
    expect(within(card("docs")).getByTestId("board-card-bot")).toHaveTextContent("Hermes Two");

    expect(card("relay").querySelector("img")).toBeNull();
    act(() => { fakeEngine.update({ links: [{ ...link, peerAvatar: PICTURE }] }); });
    expect(card("relay").querySelector("img")).toHaveAttribute("src", PICTURE);
  });

  it("and so does a chat the person renamed", () => {
    saveSession(session({ label: "Boss" }));
    act(() => { window.dispatchEvent(new Event("session-updated")); });
    expect(within(card("relay")).getByTestId("board-card-bot")).toHaveTextContent("Boss");
    expect(counts.entries).toBe(1);
  });

  it("an edited card builds the board once, and the states after it nothing", async () => {
    const done = task({ status: "done", progress: 100 });
    current = [{ ...rows[0], card: done, editedAt: NOW }, rows[1], rows[2]];
    act(() => fakeEngine.messages("link-1", [{ linkId: "link-1", id: "m1", text: statusCardText(done), sender: "peer", timestamp: rows[0].timestamp, via: "datalink", card: done, edit: { seq: 1, at: NOW, history: [] } } as StoredMessage]));
    await waitFor(() => expect(card("relay")).toHaveAttribute("data-status", "done"));
    expect(counts.entries).toBe(1);
    reset();
    sameStateAgain();
    expect(counts).toEqual({ entries: 0, model: 0, card: 0 });
  });
});
