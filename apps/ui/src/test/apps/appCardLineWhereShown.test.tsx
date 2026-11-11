import { act, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appCardId, type AppCard } from "@ghostly/core";
import type { GroupMemberView, StoredMessage } from "@ghostly/browser/shared/types";
import { Sidebar } from "../../components/Sidebar";
import { ANNOUNCE_WINDOW_MS, MessageAnnouncer, type Announceable } from "../../components/chat/MessageAnnouncer";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { forgetInstalledApps } from "../../lib/apps/installed";
import { messageSnippet } from "../../lib/replies";
import { saveSession } from "../../lib/storage";
import type { ChatMessage, ChatSession } from "../../lib/types";
import { Chat } from "../../pages/Chat";
import { GroupChat } from "../../pages/GroupChat";
import { Saved } from "../../pages/Saved";
import { fakeEngine, groupView, linkView } from "../fakeEngine";
import { renderApp } from "../render";
import { hideApps, showApps } from "./showApps";

// covers: apps.chat.card

/*
 * An app card's message reads the same in every view of it. Its bubble draws the card only in a 1:1 chat where Apps
 * shows; in a group, or with Apps off, it shows the message's text. Its quote, the pinned bar, the chat list, Saved and
 * the screen reader then say that text too, never "🧩 App: Chess 1.2.0" over words the bubble shows otherwise.
 */

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

const KEY = "yz7moxucbd4u8aqtk5ir8khn4emft7zskr7qo7x876ntwxfiegoo";
const REF = `${KEY}/chess`;
const CARD: AppCard = { kind: "app", id: appCardId(REF), ref: REF, digest: "ExPDNDfgZ_QT1mf4KwxD-xeFAYukL50YWZ1YuFsKkp4", sequence: 7, title: "Chess",
  version: "1.2.0", url: "https://raw.githubusercontent.com/ana/chess/HEAD/app.ghostlyapp", opened: true };
/** What the bubble shows where it draws no card. */
const TEXT = "Your move after lunch, the board is set";
const LINE = "🧩 App: Chess 1.2.0";
const NOW = Date.now();
const WIRE = "A".repeat(22), REPLY = "B".repeat(22);

/** The words a message's bubble shows. */
const bubbleText = (id: string) => within(document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!).getByTestId("message-text");

beforeEach(() => {
  forgetInstalledApps();
  fakeEngine.on("appList", () => []);
});
afterEach(() => {
  hideApps();
  forgetInstalledApps();
  vi.useRealTimers();
});

describe("a 1:1 chat's page", () => {
  /** Alice's app card, pinned, and my reply to it. */
  function openChat() {
    const card = { id: `peer_${WIRE}`, text: TEXT, card: CARD, sender: "peer", timestamp: NOW - 120_000 } as ChatMessage;
    const reply = { id: `me_${REPLY}`, text: "what is this?", sender: "me", timestamp: NOW - 60_000, replyTo: { id: WIRE, snippet: TEXT, from: "peer", messageId: `peer_${WIRE}` } } as ChatMessage;
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: "peer".padEnd(52, "p"), encKeyB64: "a2V5", label: "Alice", messages: [card, reply], createdAt: NOW - 600_000 });
    const view = renderApp(<Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} />);
    view.engine.on("ensureLink", () => ({ linkId: "link-1" })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    view.engine.update({ links: [linkView({ id: "link-1", peerPubKeyZ32: "peer".padEnd(52, "p"), profile: "paired-chat/1", pairing: { status: "ready" }, pin: { id: WIRE, by: "peer", at: NOW, messageId: `peer_${WIRE}` } } as never)] });
    return view;
  }
  const quote = () => within(document.querySelector<HTMLElement>(`[data-message-id="me_${REPLY}"]`)!).getByTestId("reply-quote-snippet");

  it("with Apps off: the bubble shows the text, and so do the reply's quote and the pinned bar", async () => {
    openChat();
    await waitFor(() => expect(bubbleText(`peer_${WIRE}`)).toHaveTextContent(TEXT));
    expect(screen.queryByTestId("app-card")).not.toBeInTheDocument();
    expect(quote()).toHaveTextContent(TEXT);
    expect(screen.getByTestId("pinned-snippet")).toHaveTextContent(TEXT);
    expect(document.body).not.toHaveTextContent(LINE);
  });

  it("with Apps on: the bubble draws the card, and the quote and the pinned bar say its line", async () => {
    showApps();
    openChat();
    await screen.findByTestId("app-card");
    await waitFor(() => expect(quote()).toHaveTextContent(LINE));
    expect(screen.getByTestId("pinned-snippet")).toHaveTextContent(LINE);
  });
});

describe("a group's page, with Apps on", () => {
  const ME = "me".padEnd(52, "y"), ALICE = "alice".padEnd(52, "y");
  const member = (patch: Partial<GroupMemberView>): GroupMemberView => ({ key: ME, role: "member", me: false, online: true, missing: 0, ...patch });
  const CARD_ID = `${ALICE}:1:0`, MINE = `${ME}:1:0`;

  it("the bubble shows the text, and so do a reply's quote and the pinned bar", async () => {
    showApps();
    const stored = (patch: Partial<StoredMessage>): StoredMessage => ({ linkId: "group:group-1", id: "g1", text: "", sender: "peer", timestamp: NOW - 120_000, via: "datalink", ...patch });
    const messages = [
      stored({ id: CARD_ID, text: TEXT, card: CARD, member: ALICE }),
      stored({ id: MINE, text: "what is this?", sender: "me", timestamp: NOW - 60_000, replyTo: { id: CARD_ID, snippet: TEXT, from: "peer", member: ALICE, messageId: CARD_ID } }),
    ];
    fakeEngine.on("groupMessages", () => messages).on("updateSettings", () => undefined);
    fakeEngine.update({ groups: [groupView({ status: "active", epoch: 1, members: [member({ key: ME, me: true }), member({ key: ALICE, nick: "Alice" })], pin: { id: CARD_ID, by: ALICE, at: NOW } } as never)] });
    renderApp(<Routes><Route path="/group/:groupId" element={<GroupChat />} /></Routes>, { route: "/group/group-1" });
    await waitFor(() => expect(bubbleText(CARD_ID)).toHaveTextContent(TEXT));
    // Apps shows on this device, and the bubble still draws no card in a group.
    expect(screen.queryByTestId("app-card")).not.toBeInTheDocument();
    const quote = within(document.querySelector<HTMLElement>(`[data-message-id="${MINE}"]`)!).getByTestId("reply-quote-snippet");
    expect(quote).toHaveTextContent(TEXT);
    expect(screen.getByTestId("pinned-snippet")).toHaveTextContent(TEXT);
    expect(document.body).not.toHaveTextContent(LINE);
  });
});

describe("a quote's or the pinned bar's line", () => {
  const message = { text: TEXT, card: CARD };
  it("is the text unless the chat draws the card", () => {
    expect(messageSnippet(message)).toBe(TEXT);
    expect(messageSnippet(message, undefined, true)).toBe(LINE);
  });
});

describe("the screen reader", () => {
  const history: Announceable[] = [{ id: "h1", sender: "peer", text: "hi" }];
  const said = (linkId: string) => {
    vi.useFakeTimers();
    const view = renderApp(<MessageAnnouncer chat="c" linkId={linkId} messages={history} nameOf={() => "Ana"} />);
    view.rerender(<MessageAnnouncer chat="c" linkId={linkId} messages={[...history, { id: "m1", sender: "peer", text: TEXT, card: CARD }]} nameOf={() => "Ana"} />);
    act(() => { vi.advanceTimersByTime(ANNOUNCE_WINDOW_MS); });
    return screen.getByTestId("chat-announcement");
  };

  it("in a group, with Apps on: reads the text", async () => {
    showApps();
    expect(said("group:group-1")).toHaveTextContent(`Ana: ${TEXT}`);
  });

  it("in a 1:1 chat with Apps off: reads the text", () => {
    expect(said("link-1")).toHaveTextContent(`Ana: ${TEXT}`);
  });

  it("in a 1:1 chat with Apps on: reads the card's line", async () => {
    showApps();
    expect(said("link-1")).toHaveTextContent(`Ana: ${LINE}`);
  });
});

describe("Saved", () => {
  function openSaved(message: StoredMessage) {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: "peerkeyalice", encKeyB64: "a2V5", messages: [], createdAt: NOW, nick: "Alice" });
    const rendered = renderApp(<Saved />, { route: "/saved" });
    rendered.engine.on("savedMessages", () => [{ savedAt: NOW, message }])
      .setState({ links: [linkView({ id: "link-1", peerPubKeyZ32: "peerkeyalice", peerNick: "Alice" })],
        groups: [groupView({ id: "group-1", name: "Friends", status: "active" } as never)] });
    return rendered;
  }

  it("a group's app card, with Apps on, reads as its text", async () => {
    showApps();
    openSaved({ linkId: "group:group-1", id: "g1", text: TEXT, card: CARD, sender: "peer", member: "alice".padEnd(52, "y"), timestamp: NOW - 60_000, via: "datalink" });
    await waitFor(() => expect(screen.getByTestId("saved-text")).toHaveTextContent(TEXT));
  });

  it("a 1:1 chat's app card, with Apps off, reads as its text", async () => {
    openSaved({ linkId: "link-1", id: "peer_1", text: TEXT, card: CARD, sender: "peer", timestamp: NOW - 60_000, via: "datalink" });
    await waitFor(() => expect(screen.getByTestId("saved-text")).toHaveTextContent(TEXT));
  });

  it("a 1:1 chat's app card, with Apps on, reads as the card's line", async () => {
    showApps();
    openSaved({ linkId: "link-1", id: "peer_1", text: TEXT, card: CARD, sender: "peer", timestamp: NOW - 60_000, via: "datalink" });
    await waitFor(() => expect(screen.getByTestId("saved-text")).toHaveTextContent(LINE));
  });
});

describe("the chat list's row", () => {
  function openList() {
    const message = { id: "m1", text: TEXT, card: CARD, sender: "peer", timestamp: NOW } as ChatMessage;
    saveSession({ id: "a", profile: "paired-chat/1", mySeedB64: "seed-a", peerPubKeyB64: "a".repeat(52), encKeyB64: "enc", nick: "Ana", createdAt: NOW, messages: [message] } as unknown as ChatSession);
    const view = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    const row = screen.getAllByTestId("chat-row").find((r) => within(r).getByTestId("chat-row-name").textContent === "Ana")!;
    return { ...view, preview: () => within(row).getByTestId("chat-row-preview") };
  }

  it("with Apps off: says the text, and asks the engine for no app list", async () => {
    const { preview, engine } = openList();
    await act(async () => {});
    expect(engine.callsTo("appList")).toEqual([]);
    expect(preview()).toHaveTextContent(TEXT);
    expect(preview()).not.toHaveTextContent(LINE);
  });

  it("with Apps on: says the card's line", async () => {
    showApps();
    const { preview } = openList();
    await waitFor(() => expect(preview()).toHaveTextContent(LINE));
  });
});
