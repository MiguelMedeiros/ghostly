import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { loadSession } from "../../lib/storage";
import type { ChatSession } from "../../lib/types";
import { Chat } from "../../pages/Chat";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.paired.storage

/*
 * Where the engine sends a page each chat's newest page only (the extension's pages), the chat that opens shows, searches
 * and jumps over its whole history, and the chat list's search reads every chat's messages: each asks for the whole
 * histories it reads, while it reads them. A chat list with nothing searched asks for none.
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

  it("asks for every chat's whole history while the chat list searches, and none before", async () => {
    const a = reloadedChat("ana");
    const b = reloadedChat("bea");
    fakeEngine.update({ links: [a.link, b.link] });
    const { user, engine } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    engine.newestPage(a.linkId, a.history.slice(-PAGE));
    engine.newestPage(b.linkId, b.history.slice(-PAGE));
    await tick();
    expect(engine.historyAsks).toEqual([]);
    await user.type(screen.getByPlaceholderText("Search chats..."), "message 3");
    expect([...engine.historyAsks].sort()).toEqual([a.linkId, b.linkId]);
  });
});
