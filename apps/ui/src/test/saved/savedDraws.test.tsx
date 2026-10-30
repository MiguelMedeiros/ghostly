import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SavedMessage, StoredMessage } from "@ghostly/browser/shared/types";
import { Saved } from "../../pages/Saved";
import { saveSession } from "../../lib/storage";
import { groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.saved

/** When the Saved view draws its rows again: the saved list, a group's name or an author's name changing, not every engine state. */

const draws = vi.hoisted(() => ({ n: 0 }));
// Each row says its time once per draw: the count of those is the count of rows drawn.
vi.mock("../../lib/chatList", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/chatList")>();
  return { ...real, formatListTime: (...args: Parameters<typeof real.formatListTime>) => { draws.n++; return real.formatListTime(...args); } };
});

const PEER = "peerkeyalice";
const NOW = Date.now();
const message = (linkId: string, id: string, patch: Partial<StoredMessage> = {}): StoredMessage => ({ linkId, id, text: `text ${id}`, sender: "peer", timestamp: NOW - 5 * 60_000, via: "datalink", ...patch });
const rows: SavedMessage[] = [
  { savedAt: NOW, message: message("group:g1", "k:1", { member: "hermes-key" }) },
  { savedAt: NOW - 1000, message: message("link-1", "peer_1") },
];

const links = () => [linkView({ id: "link-1", peerPubKeyZ32: PEER, peerNick: "Alice" })];
const crew = (patch: { name?: string; hermes?: string; lastMessageAt?: number } = {}) => groupView({
  id: "g1", name: patch.name ?? "Crew", status: "active", canSend: true, lastMessageAt: patch.lastMessageAt ?? NOW - 2000,
  members: [{ key: "me-key", me: true, nick: "Me" }, { key: "hermes-key", me: false, nick: patch.hermes ?? "Hermes" }] as never,
});
const other = (lastMessageAt: number) => groupView({ id: "g2", name: "Other", status: "active", canSend: true, lastMessageAt });

describe("the Saved view's rows", () => {
  it("are not drawn again on an engine state that changes nothing they show, and are when a group's or an author's name does", async () => {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages: [], createdAt: 1_700_000_000_000, nick: "Alice" });
    const { engine } = renderApp(<Saved />, { route: "/saved" });
    engine.on("savedMessages", () => rows).setState({ links: links(), groups: [crew(), other(NOW - 1000)] });
    await waitFor(() => expect(screen.getAllByTestId("saved-row")).toHaveLength(2));
    const before = draws.n;

    // Twenty states, as while a file moves or a group catches up: new arrays each, the other group moving up and down.
    for (let i = 0; i < 20; i++) act(() => engine.setState({ links: links(), groups: i % 2 ? [crew(), other(NOW + i)] : [other(NOW - 1000), crew({ lastMessageAt: NOW + i })] }));
    expect(draws.n).toBe(before);

    // The group renamed: its row says so.
    act(() => engine.setState({ links: links(), groups: [crew({ name: "Crew 2" }), other(NOW)] }));
    const [group, chat] = screen.getAllByTestId("saved-row");
    expect(within(group).getByTestId("saved-chat")).toHaveTextContent("Crew 2");
    expect(draws.n).toBe(before + 1);
    // The author renamed: the row again, the 1:1 row never.
    act(() => engine.setState({ links: links(), groups: [crew({ name: "Crew 2", hermes: "Hermes Bot" }), other(NOW)] }));
    expect(within(screen.getAllByTestId("saved-row")[0]).getByTestId("saved-author")).toHaveTextContent("Hermes Bot");
    expect(draws.n).toBe(before + 2);
    expect(within(chat).getByTestId("saved-chat")).toHaveTextContent("Alice");
  });
});
