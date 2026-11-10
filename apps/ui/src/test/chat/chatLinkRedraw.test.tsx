import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { LinkView, StoredMessage } from "@ghostly/browser/shared/types";
import { saveSession } from "../../lib/storage";
import { Chat } from "../../pages/Chat";
import { linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: chat.typing, chat.paired.status, chat.paired.storage, chat.status.shown

/*
 * The open chat's link changes all the time in ways the page itself shows nothing of: each poll of the contact's
 * address (polling, then the next one's time and the sync's), the contact typing, coming online or going away. The
 * header's own parts follow those; the page, with its 100-odd message rows, is not drawn again for them. And a row is
 * drawn again only when what it shows changes: a message arriving draws its own row, not the others.
 */

const counts = vi.hoisted(() => ({ page: 0, rows: 0 }));

// One per drawing of the chat page: it reads its link once per draw.
vi.mock("../../hooks/useChatLink", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useChatLink")>();
  return { ...actual, useChatLink: (...args: Parameters<typeof actual.useChatLink>) => { counts.page++; return actual.useChatLink(...args); } };
});

// One per drawing of a message row.
vi.mock("../../components/MessageBubble", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/MessageBubble")>();
  return { ...actual, MessageBubble: (props: Parameters<typeof actual.MessageBubble>[0]) => { counts.rows++; return actual.MessageBubble(props); } };
});

// The real sync (the setup stubs it out): messages come from the engine's history as they do in the app.
vi.unmock("@ghostly/browser/platform/sync");
vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const PEER = "peer".padEnd(52, "p");
const LINK = "link-1";
const NOW = Date.now();
const N = 150;
const row = (i: number): StoredMessage => ({ linkId: LINK, id: `peer_${i}`, text: `message ${i}`, sender: "peer", timestamp: NOW - (N - i) * 1_000 }) as StoredMessage;
const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, MESSAGE_CHANGES_TICK_MS * 2)));
const reset = () => { counts.page = 0; counts.rows = 0; };

afterEach(() => { vi.restoreAllMocks(); });

async function openChat() {
  saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: NOW - N * 2_000 });
  const { engine } = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />, { route: "/chat/chat-1" });
  engine.on("ensureLink", () => ({ linkId: LINK })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
  /** The engine's state with the chat's link as `patch` makes it: a new object every time, as the engine's states bring. */
  const link = (patch: Partial<LinkView> = {}) => act(() => engine.update({ links: [linkView({ id: LINK, peerPubKeyZ32: PEER, profile: "paired-chat/1",
    pairing: { status: "ready" }, poll: { polling: false, nextAt: NOW, interval: 4_000 }, ...patch } as never)] }));
  link();
  engine.messages(LINK, Array.from({ length: N }, (_, i) => row(i)));
  await tick();
  await screen.findAllByText(`message ${N - 1}`);
  await tick();
  return { engine, link };
}

describe("the open chat on a change of its link that it does not show", () => {
  it("draws neither the page nor its message rows for the link's polls", async () => {
    const { link } = await openChat();
    expect(counts.rows).toBeGreaterThanOrEqual(100);

    // Ten minutes of polls at the web's 4 s: polling, then done with the next one's time and the last sync.
    reset();
    for (let i = 1; i <= 150; i++) {
      link({ poll: { polling: true, nextAt: NOW + i * 4_000, interval: 4_000 }, lastSyncAt: NOW + (i - 1) * 4_000 });
      link({ poll: { polling: false, nextAt: NOW + (i + 1) * 4_000, interval: 4_000 }, lastSyncAt: NOW + i * 4_000, lastMessageAt: NOW + i });
    }
    await tick();
    expect(counts).toEqual({ page: 0, rows: 0 });

    // A change the page shows still draws it: the link's status (the header's connection).
    link({ status: "offline" });
    await tick();
    expect(counts.page).toBeGreaterThan(0);
    expect(counts.rows).toBe(0);
  });

  it("shows the contact typing in the header without drawing the page or its rows, nor them for the contact's presence", async () => {
    const { link } = await openChat();

    reset();
    for (let i = 0; i < 50; i++) {
      link({ peerTyping: true, peerLastSeenAt: NOW + i });
      expect(screen.getByTestId("chat-typing")).toBeInTheDocument();
      link({ peerTyping: false, peerLastSeenAt: NOW + i });
      expect(screen.queryByTestId("chat-typing")).toBeNull();
    }
    await tick();
    expect(counts).toEqual({ page: 0, rows: 0 });

    // The contact coming and going: the page still reads it for a pairing's steps, but no row is drawn for it.
    for (let i = 0; i < 20; i++) {
      link({ peerOnline: false });
      link({ peerOnline: true });
    }
    await tick();
    expect(counts.rows).toBe(0);
  });

  it("shows the contact's presence and status in the header without drawing the page or its rows", async () => {
    const { link } = await openChat();

    reset();
    link({ peerPresence: "active", peerStatus: { availability: "busy", emoji: "🌴", text: "On holiday" } });
    expect(screen.getByTestId("chat-avatar-presence")).toHaveAttribute("data-tone", "busy");
    expect(screen.getByTestId("chat-presence-presence")).toHaveTextContent("Online, busy");
    expect(screen.getByTestId("chat-presence-status-text")).toHaveTextContent("On holiday");
    for (let i = 0; i < 20; i++) link({ peerPresence: i % 2 ? "idle" : "active", peerStatus: { availability: "busy", emoji: "🌴", text: "On holiday" } });
    // Gone: no dot, no status.
    link({});
    expect(screen.queryByTestId("chat-avatar-presence")).toBeNull();
    expect(screen.queryByTestId("chat-presence")).toBeNull();
    await tick();
    expect(counts).toEqual({ page: 0, rows: 0 });
  });

  it("draws a message arriving as its own row only, none of the rows already there", async () => {
    const { engine, link } = await openChat();

    reset();
    engine.emit({ kind: "message-changes", linkId: LINK, messages: [{ ...row(N), timestamp: NOW + 1 }], deleted: [] });
    // The link says when its last message came: nothing the page shows.
    link({ lastMessageAt: NOW + 1 });
    await tick();
    await screen.findAllByText(`message ${N}`);
    expect(counts.rows).toBe(1);
  });
});
