import type { ReactNode } from "react";
import { act, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MESSAGE_CHANGES_TICK_MS } from "@ghostly/browser/platform/engine";
import type { StoredMessage } from "@ghostly/browser/shared/types";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { resetAppBadge, setAppBadgeTarget, useAppBadge } from "../../lib/appBadge";
import { loadSession, saveSession, setStorageProfile as setProfile } from "../../lib/storage";
import { Chat } from "../../pages/Chat";
import { linkView, fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
import { ANNOUNCE_WINDOW_MS } from "../../components/chat/MessageAnnouncer";
import type { ChatMessage } from "../../lib/types";

/*
 * A message arriving in a long open chat had each part of the page read the chat again, one after the other on the same
 * `session-updated`: the session sync, the chat list with the app's badge, and the open chat, each parsing its stored
 * copy and merging it with the thousands of messages it leaves out. They read the chats through one cache: a chat that
 * changed is read once per arrival, for all of them.
 */

// The real sync (the setup stubs it out).
vi.unmock("@ghostly/browser/platform/sync");
vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {}, playCue: vi.fn() }));

// covers: chat.paired.storage
describe("a message arriving in a long open chat", () => {
  const PEER = "peer".padEnd(52, "p");
  const LINK = "link-1";
  const NOW = Date.now();
  const N = 1_000;
  const row = (i: number): StoredMessage => ({ linkId: LINK, id: `peer_${i}`, text: `message ${i}`, sender: "peer", timestamp: NOW - (N - i) * 1_000 }) as StoredMessage;
  const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, MESSAGE_CHANGES_TICK_MS * 2)));

  function AppIcon({ children }: { children: ReactNode }) {
    useAppBadge();
    return children;
  }

  afterEach(() => { setAppBadgeTarget(null); vi.restoreAllMocks(); });

  it("is read once by the whole page: the sync, the chat list, the badge and the chat", async () => {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: NOW - N * 2_000 });
    resetAppBadge();
    setAppBadgeTarget({ setAppBadge: async () => {}, clearAppBadge: async () => {} });
    const { engine } = renderApp(
      <UpdateProvider><AppIcon><Sidebar /><Chat sessionId="chat-1" visible onCallChange={() => {}} callLayer={null} /></AppIcon></UpdateProvider>,
      { route: "/chat/chat-1" },
    );
    engine.on("ensureLink", () => ({ linkId: LINK })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }));
    engine.update({ links: [linkView({ id: LINK, peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
    engine.messages(LINK, Array.from({ length: N }, (_, i) => row(i)));
    await tick();
    await screen.findAllByText(`message ${N - 1}`);

    // Each read of the chat's stored copy, from here on.
    const parse = JSON.parse;
    let reads = 0;
    vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      if (typeof text === "string" && text.includes('"id":"chat-1"') && text.includes('"messages"')) reads++;
      return parse(text, reviver);
    });
    for (let i = 0; i < 3; i++) {
      engine.emit({ kind: "message-changes", linkId: LINK, messages: [{ ...row(N + i), timestamp: NOW + i }], deleted: [] });
      await tick();
      await screen.findAllByText(`message ${N + i}`);
    }
    expect(reads).toBe(3);
    expect(loadSession("chat-1")!.messages).toHaveLength(N + 3);
  });
});

// covers: app.accessibility, chat.paired.send
/**
 * A 1:1 chat draws once before its stored messages are read (an empty list): the messages they bring were there
 * before, and a screen reader is told nothing of them. Opening a chat said "2 new messages from Ana" every time. One
 * that comes after them is news, and is said.
 */

// The real sync (the setup stubs it out): a contact's message reaches the open chat as it does in the app.
describe("Chat: the stored messages of a 1:1 chat that opens", () => {
  const PEER = "peer".padEnd(52, "p");
  const LINK = "link-1";
  const NOW = Date.now();
  const row = (id: string, text: string, at: number): StoredMessage => ({ linkId: LINK, id, text, sender: "peer", timestamp: NOW + at }) as StoredMessage;
  const HISTORY = [row("peer_1", "Morning", -2_000), row("peer_2", "Coffee at ten?", -1_000)];

  /** Past the window in which messages that come together are read out as one line (on the fake clock: at once). */
  const pastWindow = () => act(() => vi.advanceTimersByTimeAsync(ANNOUNCE_WINDOW_MS + 200));
  afterEach(() => { vi.useRealTimers(); });

  it("are not read out as new messages; one that comes after them is", { timeout: 10_000 }, async () => {
    // The announcer's window runs on a fake clock that also keeps real time.
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout"] });
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

// covers: chat.paired.delete-message
/*
 * Delete for everyone of a message of mine in a long 1:1 chat. The engine tells the page the row went before it answers,
 * but the page hears it at the end of its change tick: the chat deleted the row from its session first, and that write
 * had the mirror's tick walk the whole history and save the chat again. The removal is mirrored when the engine answers,
 * from what changed only: the chat is saved once, and the delete after it finds the row gone.
 */

// The real sync (the setup stubs it out).
describe("delete for everyone in a long chat", () => {
  const NOW = 1_700_000_000_000;
  const N = 1_000;
  const PEER = "l".repeat(52);
  const LINK = "link-l";

  const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, MESSAGE_CHANGES_TICK_MS * 2)));

  afterEach(() => { localStorage.clear(); setProfile(""); });

  it("in a long chat, the removal is saved once: no second write of the chat, nor a whole pass after it", async () => {
    const row = (i: number): StoredMessage => ({ linkId: LINK, id: `peer_${i}`, text: `message ${i}`, sender: "peer", timestamp: NOW + i * 1_000 }) as StoredMessage;
    const mine = { linkId: LINK, id: "me_w1", ref: "w1", text: "wrong chat", sender: "me", timestamp: NOW + N * 1_000, delivery: "delivered", via: "datalink" } as StoredMessage;
    saveSession({ id: "chat-l", profile: "paired-chat/1", mySeedB64: "seed-l", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages: [], createdAt: NOW - 1_000 });
    fakeEngine.update({ links: [linkView({ id: LINK, peerPubKeyZ32: PEER, profile: "paired-chat/1", dataLink: "open" } as never)] });
    const { startSessionSync } = await import("@ghostly/browser/platform/sync");
    startSessionSync();
    fakeEngine.messages(LINK, [...Array.from({ length: N }, (_, i) => row(i)), mine]);
    await tick();
    expect(loadSession("chat-l")!.messages).toHaveLength(N + 1);

    const { user, engine } = renderApp(<Chat sessionId="chat-l" visible onCallChange={() => {}} callLayer={null} />);
    // As the engine does (engine/node.ts removeMessage): the row's change is told, then the call answered.
    engine.on("removeMessage", ({ messageId }) => {
      engine.emit({ kind: "message-changes", linkId: LINK, messages: [], deleted: [messageId] });
      return { error: null };
    });
    const bubble = (await screen.findByText("wrong chat")).closest<HTMLElement>("[data-message-id]")!;
    await user.click(within(bubble).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-delete-everyone"));

    // Each time the chat is turned into its stored text (a save, written or not), from the confirm on.
    const stringify = JSON.stringify;
    let saves = 0;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
      const text = stringify(...args);
      if (typeof text === "string" && text.includes('"mySeedB64":"seed-l"')) saves++;
      return text;
    });
    try {
      await user.click(screen.getByTestId("message-delete-confirm"));
      await waitFor(() => expect(screen.queryByText("wrong chat")).not.toBeInTheDocument());
      await tick();
    } finally {
      spy.mockRestore();
    }
    expect(engine.callsTo("removeMessage")).toEqual([{ linkId: LINK, messageId: "me_w1" }]);
    expect(saves).toBe(1);
    const session = loadSession("chat-l")!;
    expect(session.messages).toHaveLength(N);
    expect(session.deletedIds).toContain("me_w1");
  });
});

// covers: chat.edit, chat.paired.delete-message
/*
 * The composer's edit bar follows the message as the chat has it, as the reply bar does: one of mine deleted while I
 * edit it (here from its ⋮, or for everyone from another of my devices) ends the edit, its words with it, and the
 * draft set aside comes back. Enter then sends that draft, not an edit of a message that is gone.
 */
describe("an edit bar on a message of mine that is deleted", () => {
  const PEER = "peer".padEnd(52, "p"), LINK = "link-heron";
  const WIRE = "M".repeat(22);
  const mine: StoredMessage = { linkId: LINK, id: `me_${WIRE}`, wireId: WIRE, text: "heron note 8812", sender: "me", timestamp: Date.now() - 60_000, delivery: "delivered", via: "datalink" };
  const hello: StoredMessage = { linkId: LINK, id: `peer_${"H".repeat(22)}`, text: "hello there", sender: "peer", timestamp: Date.now() - 120_000, via: "datalink" };
  const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, MESSAGE_CHANGES_TICK_MS * 2)));

  async function openChat() {
    saveSession({ id: "heron", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", messages: [], createdAt: Date.now() - 600_000 });
    const utils = renderApp(<Chat sessionId="heron" visible onCallChange={() => {}} callLayer={null} />, { route: "/chat/heron" });
    utils.engine.on("ensureLink", () => ({ linkId: LINK })).on("setActiveLink", () => undefined).on("sendMessage", () => ({ error: null }))
      .on("editMessage", () => ({ error: "Only your own text messages can be edited", refused: true }))
      .update({ links: [linkView({ id: LINK, peerPubKeyZ32: PEER, profile: "paired-chat/1", pairing: { status: "ready" } } as never)] });
    utils.engine.messages(LINK, [hello, mine]);
    await tick();
    await screen.findByText("heron note 8812");
    return utils;
  }

  const row = (id: string) => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!;
  const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");

  it("closes with its words, the draft comes back, and Enter sends the draft", async () => {
    const { engine, user } = await openChat();
    fireEvent.change(field(), { target: { value: "my draft" } });
    await user.click(within(row(mine.id)).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-edit"));
    await tick();
    expect(screen.getByTestId("composer-edit")).toHaveTextContent("heron note 8812");
    expect(field()).toHaveValue("heron note 8812");
    fireEvent.change(field(), { target: { value: "heron note 8813" } });

    act(() => engine.emit({ kind: "message-changes", linkId: LINK, messages: [], deleted: [mine.id] }));
    await tick();
    expect(row(mine.id)).toBeNull();
    expect(screen.queryByTestId("composer-edit")).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("heron note 8812");
    expect(field()).toHaveValue("my draft");

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await tick();
    expect(engine.callsTo("editMessage")).toEqual([]);
    expect(engine.callsTo("sendMessage").filter((c) => c.text === "my draft").length).toBe(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("deleted from its own ⋮ while it is edited: the edit ends as Cancel would", async () => {
    const { engine, user } = await openChat();
    engine.on("deleteMessage", ({ messageId }: { messageId: string }) => {
      setTimeout(() => engine.emit({ kind: "message-changes", linkId: LINK, messages: [], deleted: [messageId] }));
      return { everyone: false };
    });
    await user.click(within(row(mine.id)).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-edit"));
    await tick();
    expect(screen.getByTestId("composer-edit")).toBeInTheDocument();

    await user.click(within(row(mine.id)).getByTestId("message-options"));
    await user.click(screen.getByTestId("message-delete"));
    await user.click(screen.getByTestId("message-delete-confirm"));
    await tick();
    expect(engine.callsTo("deleteMessage").length).toBe(1);
    expect(row(mine.id)).toBeNull();
    expect(screen.queryByTestId("composer-edit")).not.toBeInTheDocument();
    expect(field()).toHaveValue("");
  });
});
