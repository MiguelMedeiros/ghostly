import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { foldText } from "../../lib/chatSearch";
import { loadSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { Chat } from "../../pages/Chat";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.paired.storage

/*
 * Where the engine sends a page each chat's newest page only (the extension's pages), the chat that opens shows, searches
 * and jumps over its whole history. The chat list's search asks for none: the engine searches what it did not send.
 */

// The real sync (the setup stubs it out).
vi.unmock("@ghostly/browser/platform/sync");
vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {} }));

const NOW = Date.now();
const N = 1_000;
const KEPT = 200;
const PAGE = 400;
const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, MESSAGE_CHANGES_TICK_MS * 2)));

/** A paired chat of N messages, as a page that just loaded finds it (its last KEPT stored), and its link. */
function reloadedChat(id: string) {
  const peer = id.padEnd(52, "p");
  const linkId = `link-${id}`;
  const row = (i: number): StoredMessage => ({ linkId, id: `peer_${i}`, text: `${id} message ${i}`, sender: "peer", timestamp: NOW - (N - i) * 1_000, via: "datalink" });
  const stored: ChatSession = {
    id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: peer, encKeyB64: "enc", label: id, createdAt: NOW - N * 2_000,
    messages: Array.from({ length: KEPT }, (_, k) => { const m = row(N - KEPT + k); return { id: m.id, text: m.text, sender: "peer", timestamp: m.timestamp }; }),
    older: N - KEPT,
  };
  localStorage.setItem(`ghostly_${id}`, JSON.stringify(stored));
  const history = Array.from({ length: N }, (_, i) => row(i));
  return { linkId, peer, history, link: linkView({ id: linkId, peerPubKeyZ32: peer, profile: "paired-chat/1", pairing: { status: "ready" } } as never) };
}

describe("a page sent each chat's newest page", () => {
  it("asks for the open chat's whole history, and shows all of it once it comes", async () => {
    const chat = reloadedChat("open");
    const other = reloadedChat("shut");
    const { engine } = renderApp(<Chat sessionId="open" visible onCallChange={() => {}} callLayer={null} />, { route: "/chat/open" });
    engine.on("ensureLink", () => ({ linkId: chat.linkId })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    engine.update({ links: [chat.link, other.link] });
    engine.newestPage(chat.linkId, chat.history.slice(-PAGE));
    engine.newestPage(other.linkId, other.history.slice(-PAGE));
    await tick();
    // The open chat's only: the other one's newest page and its stored copy make its whole history.
    expect(engine.historyAsks).toEqual([chat.linkId]);
    engine.messages(chat.linkId, chat.history);
    await tick();
    expect(loadSession("open")!.messages).toHaveLength(N);
  });

  it("finds a chat by a message older than its page through the engine, and asks for no whole history", async () => {
    const a = reloadedChat("ana");
    const b = reloadedChat("bea");
    fakeEngine.update({ links: [a.link, b.link] });
    const { user, engine } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    // The engine reads the histories it keeps: "ana message 1" is in ana's (its rows 1, 10 to 19, 100 to 199), and bea's has no "ana".
    engine.on("chatsFound", ({ query, linkIds }) => linkIds.filter((id) => (id === a.linkId ? a : b).history.some((m) => foldText(m.text).includes(query))));
    engine.newestPage(a.linkId, a.history.slice(-PAGE));
    engine.newestPage(b.linkId, b.history.slice(-PAGE));
    await tick();
    const box = screen.getByPlaceholderText("Search chats...");
    // Only in the oldest messages, which neither the page nor the stored copy holds.
    await user.type(box, "ana message 1");
    await tick();
    expect(engine.historyAsks).toEqual([]);
    expect(engine.callsTo("chatsFound").slice(-1)[0]).toEqual({ query: "ana message 1", linkIds: [a.linkId, b.linkId] });
    expect(screen.queryByText("ana")).not.toBeNull();
    expect(screen.queryByText("bea")).toBeNull();
  });

  it("drops a chat found by an older message once that message is deleted, with the same search still typed", async () => {
    const a = reloadedChat("dan");
    const b = reloadedChat("eve");
    fakeEngine.update({ links: [a.link, b.link] });
    const { user, engine } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    let history = a.history.filter((m) => m.id === "peer_1").concat(a.history.slice(-PAGE));
    engine.on("chatsFound", ({ query, linkIds }) => linkIds.filter((id) => id === a.linkId && history.some((m) => foldText(m.text).includes(query))));
    engine.newestPage(a.linkId, a.history.slice(-PAGE));
    engine.newestPage(b.linkId, b.history.slice(-PAGE));
    await tick();
    await user.type(screen.getByPlaceholderText("Search chats..."), "dan message 1");
    await tick();
    expect(screen.queryByText("dan")).not.toBeNull();
    // Deleted in the engine: the page only hears the id, of a row it never held.
    history = history.filter((m) => !foldText(m.text).includes("dan message 1"));
    act(() => engine.emit({ kind: "message-changes", linkId: a.linkId, messages: [], deleted: ["peer_1"] }));
    await waitFor(() => expect(screen.queryByText("dan")).toBeNull());
  });

  it("finds a chat by an older message when its newest page comes after the search was typed", async () => {
    const a = reloadedChat("fay");
    fakeEngine.update({ links: [a.link] });
    const { user, engine } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    engine.on("chatsFound", ({ query, linkIds }) => linkIds.filter((id) => id === a.linkId && a.history.some((m) => foldText(m.text).includes(query))));
    await user.type(screen.getByPlaceholderText("Search chats..."), "fay message 1");
    await tick();
    expect(screen.queryByText("fay")).toBeNull();
    act(() => engine.newestPage(a.linkId, a.history.slice(-PAGE)));
    await waitFor(() => expect(screen.queryByText("fay")).not.toBeNull());
  });

  it("asks the engine again once per burst of changes, and not for a change in a chat it did not ask about", async () => {
    const a = reloadedChat("gil");
    const whole = reloadedChat("hal");
    fakeEngine.update({ links: [a.link, whole.link] });
    const { user, engine } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    engine.on("chatsFound", () => []);
    engine.newestPage(a.linkId, a.history.slice(-PAGE));
    engine.messages(whole.linkId, whole.history);
    await tick();
    await user.type(screen.getByPlaceholderText("Search chats..."), "x");
    await tick();
    const asked = engine.callsTo("chatsFound").length;
    expect(engine.callsTo("chatsFound").slice(-1)[0]).toEqual({ query: "x", linkIds: [a.linkId] });
    act(() => engine.emit({ kind: "message-changes", linkId: whole.linkId, messages: [], deleted: ["peer_1"] }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(engine.callsTo("chatsFound")).toHaveLength(asked);
    for (let i = 0; i < 5; i++) {
      act(() => engine.emit({ kind: "message-changes", linkId: a.linkId, messages: [], deleted: [`peer_${i}`] }));
      await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
    }
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
    const again = engine.callsTo("chatsFound").length - asked;
    expect(again).toBeGreaterThan(0);
    expect(again).toBeLessThan(5);
  });

  it("asks the engine nothing where every chat's whole history is here", async () => {
    const a = reloadedChat("cal");
    fakeEngine.update({ links: [a.link] });
    const { user, engine } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    engine.messages(a.linkId, a.history);
    await tick();
    await user.type(screen.getByPlaceholderText("Search chats..."), "cal message 1");
    await tick();
    expect(engine.callsTo("chatsFound")).toEqual([]);
    expect(screen.queryByText("cal")).not.toBeNull();
  });
});
