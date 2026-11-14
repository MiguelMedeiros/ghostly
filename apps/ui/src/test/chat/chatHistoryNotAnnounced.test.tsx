import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { ANNOUNCE_WINDOW_MS } from "../../components/chat/MessageAnnouncer";
import { saveSession } from "../../lib/storage";
import type { ChatMessage } from "../../lib/types";
import { Chat } from "../../pages/Chat";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.accessibility, chat.paired.send

/**
 * A 1:1 chat draws once before its stored messages are read (an empty list): the messages they bring were there
 * before, and a screen reader is told nothing of them. Opening a chat said "2 new messages from Ana" every time. One
 * that comes after them is news, and is said.
 */

// The real sync (the setup stubs it out): a contact's message reaches the open chat as it does in the app.
vi.unmock("@ghostly/browser/platform/sync");
vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const PEER = "peer".padEnd(52, "p");
const LINK = "link-1";
const NOW = Date.now();
const row = (id: string, text: string, at: number): StoredMessage => ({ linkId: LINK, id, text, sender: "peer", timestamp: NOW + at }) as StoredMessage;
const HISTORY = [row("peer_1", "Morning", -2_000), row("peer_2", "Coffee at ten?", -1_000)];

/** Past the window in which messages that come together are read out as one line. */
const pastWindow = () => act(() => new Promise(resolve => setTimeout(resolve, ANNOUNCE_WINDOW_MS + 200)));

describe("Chat: the stored messages of a 1:1 chat that opens", () => {
  it("are not read out as new messages; one that comes after them is", { timeout: 10_000 }, async () => {
    saveSession({
      id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", createdAt: NOW - 60_000,
      messages: HISTORY.map(({ id, sender, text, timestamp }): ChatMessage => ({ id, sender, text, timestamp })),
    });
    const { engine } = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />, { route: "/chat/chat-1" });
    engine.on("ensureLink", () => ({ linkId: LINK })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    engine.update({ links: [linkView({ id: LINK, peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
    engine.messages(LINK, HISTORY);
    // Every line the live region takes: what a screen reader is given to read.
    const heard: string[] = [];
    const region = screen.getByTestId("chat-announcement");
    new MutationObserver(() => { if (region.textContent) heard.push(region.textContent); }).observe(region, { childList: true, characterData: true, subtree: true });
    expect(await screen.findByText("Coffee at ten?")).toBeInTheDocument();
    await pastWindow();
    expect(heard).toEqual([]);

    engine.emit({ kind: "message-changes", linkId: LINK, messages: [row("peer_3", "See you there", 60_000)], deleted: [] });
    await act(() => new Promise(resolve => setTimeout(resolve, MESSAGE_CHANGES_TICK_MS * 2)));
    expect(await screen.findByText("See you there")).toBeInTheDocument();
    await pastWindow();
    expect(heard).toEqual(["Ana: See you there"]);
  });
});
