import { type ReactNode, Profiler, useEffect } from "react";
import { act, screen, within, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { Sidebar } from "../../components/Sidebar";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { resetAppBadge, setAppBadgeTarget, useAppBadge } from "../../lib/appBadge";
import { addMessages, saveSession, loadSession } from "../../lib/storage";
import type { ChatMessage, ChatParams, ChatSession } from "../../lib/types";
import { renderApp } from "../render";
import { useChat } from "../../hooks/useChat";
import { windowIs } from "../viewport";
import { useLocation, useNavigate } from "react-router-dom";
import { fakeEngine, linkView, groupView } from "../fakeEngine";
import type { CardIndexRow } from "@ghostly/browser/shared/types";
import { readStatusCard, type TaskCard } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import { ChatRow, type ChatRowProps } from "../../components/ChatRow";
import { setChatOnCall } from "../../lib/chatsOnCall";
import { MessageBubble } from "../../components/MessageBubble";
import { formatAmount } from "../../lib/amount";
import { lookup } from "../i18n/locales";

// covers: app.attention.badge
describe("a message arriving in a chat", () => {
  /*
   * A message arriving in a long chat had the chat list and the app's badge each parse the chat's stored copy again (and
   * merge it with the messages it leaves out), one after the other on the same `session-updated`. They read the chats
   * through one cache: a chat that changed is read once for both.
   */

  const PEER = "peer".padEnd(52, "p");
  const T = Date.now() - 600_000;
  const theirs = (i: number): ChatMessage => ({ id: `peer_${i}`, sender: "peer", text: `message ${i}`, timestamp: T + i });

  function AppIcon({ children }: { children: ReactNode }) {
    useAppBadge();
    return children;
  }

  afterEach(() => { setAppBadgeTarget(null); vi.restoreAllMocks(); });

  it("has the chat list and the app's badge read the chat once between them", async () => {
    saveSession({ id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: Array.from({ length: 300 }, (_, i) => theirs(i)), createdAt: T - 1000 });
    const icon: number[] = [];
    resetAppBadge();
    setAppBadgeTarget({ setAppBadge: async (count) => { icon.push(count ?? 0); }, clearAppBadge: async () => { icon.push(0); } });
    renderApp(<UpdateProvider><AppIcon><Sidebar /></AppIcon></UpdateProvider>);
    await screen.findByText("message 299");

    act(() => void addMessages("chat-1", [theirs(300)]));
    // Each read of the chat's stored copy, from here on.
    const parse = JSON.parse;
    let reads = 0;
    vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      if (typeof text === "string" && text.includes('"id":"chat-1"') && text.includes('"messages"')) reads++;
      return parse(text, reviver);
    });
    act(() => void window.dispatchEvent(new Event("session-updated")));
    await screen.findByText("message 300");
    expect(icon[icon.length - 1]).toBe(301);
    expect(reads).toBe(1);
  });
});

// covers: chats.list.rows
describe("a call line in the chat list", () => {
  /*
   * A call line is written by the chat page itself (addSystemMessage), not by the engine. The chat list keeps its own
   * copy of each chat's last message, so the line must tell it at once: before, the list caught up only on its 3 s tick.
   */

  const NOW = Date.now();
  const key = "k".repeat(52);
  const session: ChatSession = { id: "c", profile: "paired-chat/1", mySeedB64: "seed-c", peerPubKeyB64: key, encKeyB64: "enc", nick: "Cleo", nickSource: "profile",
    messages: [{ id: "m1", text: "see you soon", sender: "peer", timestamp: NOW - 60_000 }], createdAt: NOW - 120_000 };
  const params: ChatParams = { sessionId: "c", profile: "paired-chat/1", seedB64: "seed-c", peerPubKeyB64: key, encKeyB64: "enc" } as ChatParams;
  const callLine: ChatMessage = { id: "call_ended_1", text: "Audio call ended", sender: "system", timestamp: NOW, callEvent: { type: "call_ended", hasVideo: false, duration: 65_000 } };

  let add: ((m: ChatMessage) => void) | undefined;
  let addMissed: ((m: ChatMessage, options: { rang?: string; seen?: boolean }) => string | undefined) | undefined;
  function ChatPage() {
    const { addSystemMessage, addMissedCallMessage } = useChat(params);
    useEffect(() => { add = addSystemMessage; addMissed = addMissedCallMessage; }, [addSystemMessage, addMissedCallMessage]);
    return null;
  }

  afterEach(() => { vi.useRealTimers(); add = undefined; addMissed = undefined; });

  it("shows as the chat's last message as soon as the chat page writes it, with one list render and no extra chat render", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    saveSession(session);
    const commits = { list: 0, chat: 0 };
    const { engine } = renderApp(
      <UpdateProvider>
        <Profiler id="list" onRender={() => { commits.list++; }}><Sidebar /></Profiler>
        <Profiler id="chat" onRender={() => { commits.chat++; }}><ChatPage /></Profiler>
      </UpdateProvider>,
    );
    engine.on("ensureLink", () => ({ linkId: "c" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const row = () => screen.getAllByTestId("chat-row").find(r => within(r).getByTestId("chat-row-name").textContent === "Cleo")!;
    expect(row()).toHaveTextContent("see you soon");

    const before = { ...commits };
    act(() => add!(callLine));
    const at = { list: commits.list - before.list, chat: commits.chat - before.chat, shown: row().textContent?.includes("Audio call ended") };
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    console.info(`call line: shown at once ${at.shown}; commits at once list ${at.list} chat ${at.chat}; after 3 s list ${commits.list - before.list} chat ${commits.chat - before.chat}`);
    // No timer had run: the list moved with the line itself, in one render of each.
    expect(at).toEqual({ list: 1, chat: 1, shown: true });
  });

  // agents#992: a burst of missed calls is one line, and the list says how many.
  it("a burst of missed calls is one line in the list, saying how many", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    saveSession(session);
    const { engine } = renderApp(<UpdateProvider><Sidebar /><ChatPage /></UpdateProvider>);
    engine.on("ensureLink", () => ({ linkId: "c" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    const row = () => screen.getAllByTestId("chat-row").find(r => within(r).getByTestId("chat-row-name").textContent === "Cleo")!;
    for (let i = 0; i < 12; i++) {
      const missed: ChatMessage = { id: `system_call_call_missed_${NOW + i}`, text: "Missed audio call", sender: "system", timestamp: NOW + i * 1_000, callEvent: { type: "call_missed", hasVideo: false } };
      act(() => { addMissed!(missed, {}); });
    }
    expect(row()).toHaveTextContent("12 missed audio calls");
  });
});

// covers: app.accessibility, chats.list.rail
describe("the chat list's landmark", () => {
  /*
   * The chat list is a landmark of its own, "Chats", as the account bar and the open page are: a screen reader's landmark
   * keys reach its New and Join, its search and its rows, folded to a rail or not, on a wide screen and on a phone. Only
   * the rail was one before; the full list, a new profile's first screen, was in none.
   */

  const NOW = Date.now();
  const chat = (id: string, nick: string): ChatSession =>
    ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: id.repeat(52), encKeyB64: "enc", messages: [], createdAt: NOW, nick });
  const list = () => renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
  const chats = () => screen.getByRole("navigation", { name: "Chats" });

  afterEach(() => vi.restoreAllMocks());

  it("holds a new profile's New, Join, search and empty list on a wide screen, and is the only one named Chats", () => {
    windowIs(false);
    list();
    const nav = chats();
    expect(nav).toBe(screen.getByTestId("sidebar"));
    expect(within(nav).getByTestId("sidebar-new-chat")).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Join chat" })).toBeInTheDocument();
    expect(within(nav).getByRole("searchbox", { name: "Search chats" })).toBeInTheDocument();
    expect(within(nav).getByText("It's quiet here...")).toBeInTheDocument();
    expect(screen.getAllByRole("navigation", { name: "Chats" })).toHaveLength(1);
  });

  it("holds the rows, and stays the one landmark when the list is folded to a rail", () => {
    windowIs(false);
    saveSession(chat("a", "Ana"));
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ chatListCollapsed: true }));
    list();
    const nav = chats();
    expect(nav).toHaveAttribute("data-collapsed", "true");
    expect(within(nav).getByTestId("chat-rail")).toBeInTheDocument();
    expect(within(nav).getByTestId("sidebar-new-chat")).toBeInTheDocument();
    expect(screen.getAllByRole("navigation", { name: "Chats" })).toHaveLength(1);
  });

  it("is the list's landmark on a phone too", () => {
    windowIs(true);
    saveSession(chat("a", "Ana"));
    list();
    const nav = chats();
    expect(within(nav).getByRole("heading", { level: 1, name: "Chats" })).toBeInTheDocument();
    expect(within(nav).getByTestId("chat-list")).toHaveTextContent("Ana");
  });
});

// covers: app.mobile-layout
describe("a long chat list on a phone", () => {
  /*
   * On a phone the open chat takes the chat list's place, and the list is `display: none` meanwhile (App.tsx). A browser
   * drops the scroll of a box that is not drawn: Back from a chat opened far down a long list came to the list's top,
   * and the person scrolled down again to the chat they had come from, every time. The list is put back where it was.
   * The test's DOM lays nothing out: a box is 600 px tall unless it is inside `hidden`, and the drop is done by hand.
   */

  const NOW = Date.now();
  const chat = (i: number): ChatSession => ({
    id: `c-${i}`, profile: "paired-chat/1", mySeedB64: `seed-${i}`, peerPubKeyB64: String(i).padStart(4, "0").repeat(13), encKeyB64: "enc",
    messages: [{ id: `m-${i}`, text: `hello ${i}`, sender: "peer", timestamp: NOW - i * 60_000 }], createdAt: NOW - i * 60_000, lastSyncAt: NOW - i * 60_000, nick: `Chat ${i}`,
  });

  /** App.tsx's phone layout, in short: the list's wrapper is hidden while anything else is open; Back goes home. */
  function Phone() {
    const { pathname } = useLocation();
    const navigate = useNavigate();
    return <>
      <div className={pathname === "/" ? "flex-1 flex min-h-0" : "hidden"}><Sidebar /></div>
      {pathname !== "/" && <button type="button" onClick={() => navigate("/")}>Back</button>}
    </>;
  }

  beforeEach(() => {
    windowIs(true);
    for (let i = 0; i < 40; i++) saveSession(chat(i));
    fakeEngine.update({ groups: [] });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) { return this.closest(".hidden") ? 0 : 600; });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("is where it was when Back comes from a chat opened far down it", async () => {
    renderApp(<UpdateProvider><Phone /></UpdateProvider>);
    const list = screen.getByTestId("chat-list");
    await screen.findByText("Chat 30");
    list.scrollTop = 2000;
    fireEvent.scroll(list);

    fireEvent.click(screen.getByText("Chat 30"));
    await screen.findByRole("button", { name: "Back" });
    expect(list.closest(".hidden")).not.toBeNull();
    // What the browser does to the list while it is not drawn.
    list.scrollTop = 0;
    fireEvent.scroll(list);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Back" })); });
    expect(list.closest(".hidden")).toBeNull();
    expect(list.scrollTop).toBe(2000);
  });

  it("stays at the top the person scrolled it to", async () => {
    renderApp(<UpdateProvider><Phone /></UpdateProvider>);
    const list = screen.getByTestId("chat-list");
    await screen.findByText("Chat 3");
    list.scrollTop = 2000;
    fireEvent.scroll(list);
    list.scrollTop = 0;
    fireEvent.scroll(list);

    fireEvent.click(screen.getByText("Chat 3"));
    await act(async () => { fireEvent.click(await screen.findByRole("button", { name: "Back" })); });
    expect(list.scrollTop).toBe(0);
  });
});

// covers: chats.list.search
describe("the chat list's search", () => {
  /*
   * The chat list's search, as the search inside a chat: a name a screen reader says once the placeholder is gone, a
   * polite line that says how many chats it found (or that it found none), and Escape to clear it.
   */

  const NOW = Date.now();
  const key = (c: string) => c.repeat(52);
  const chat = (id: string, nick: string, text: string): ChatSession =>
    ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: key(id), encKeyB64: "enc", messages: [{ id: `m-${id}`, text, sender: "peer", timestamp: NOW }], createdAt: NOW, lastSyncAt: NOW, nick });

  beforeEach(() => {
    saveSession(chat("a", "Alice", "first hello"));
    saveSession(chat("b", "Bob", "second hello"));
    fakeEngine.update({ links: [linkView({ id: "link-a", peerPubKeyZ32: key("a") }), linkView({ id: "link-b", peerPubKeyZ32: key("b") })] });
  });

  it("is a search field named apart from its placeholder", () => {
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    const box = screen.getByRole("searchbox", { name: "Search chats" });
    expect(box).toBe(screen.getByPlaceholderText("Search chats..."));
  });

  it("says politely how many chats it found, and that it found none", async () => {
    const { user } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    const status = screen.getByTestId("chat-list-search-status");
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveTextContent(/^$/);
    const box = screen.getByPlaceholderText("Search chats...");
    await user.type(box, "hello");
    expect(status).toHaveTextContent("2 chats found");
    await user.clear(box);
    await user.type(box, "second");
    expect(status).toHaveTextContent("1 chat found");
    await user.type(box, "zzzqqq");
    expect(status).toHaveTextContent("No results found");
    await user.clear(box);
    expect(status).toHaveTextContent(/^$/);
  });

  it("clears with Escape, the focus staying in the field, and lets a second Escape through", async () => {
    const { user } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    const box = screen.getByPlaceholderText("Search chats...");
    await user.type(box, "zzzqqq");
    expect(screen.queryAllByTestId("chat-row")).toHaveLength(0);
    let outside = 0;
    const count = (e: KeyboardEvent) => { if (e.key === "Escape") outside++; };
    document.addEventListener("keydown", count);
    try {
      await user.keyboard("{Escape}");
      expect(box).toHaveValue("");
      expect(box).toHaveFocus();
      expect(screen.getAllByTestId("chat-row")).toHaveLength(2);
      expect(outside).toBe(0);
      await user.keyboard("{Escape}");
      expect(outside).toBe(1);
    } finally {
      document.removeEventListener("keydown", count);
    }
  });
});

// covers: chats.list.rows, chat.tasks-board
describe("The chat list as the app starts", () => {
  const chat = (id: string, nick: string): ChatSession =>
    ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: id.repeat(52), encKeyB64: "enc", messages: [], createdAt: 1, nick });
  const task = readStatusCard({ kind: "task", id: "relay", title: "Fix relay rotation", status: "running" }) as TaskCard;
  const card: CardIndexRow = { linkId: "a", id: "m1", card: task, sender: "peer", timestamp: 1 };

  /** The rows of the chat list, top to bottom: a group's id or a chat's name. */
  const rows = () => [...screen.getByTestId("chat-list").querySelectorAll<HTMLElement>("[data-testid=group-row], [data-testid=chat-row]")]
    .map(r => r.dataset.group ?? within(r).getByTestId("chat-row-name").textContent);

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

// covers: chats.list.rows
describe("the chat list on an engine state that changes nothing it shows", () => {
  /*
   * The engine sends its whole state anew on every change, up to 20 a second while a file moves. The chat list is always
   * on screen: a state that changes nothing it shows (here, only a transfer's progress) draws none of it. It followed the
   * whole state (its groups, the chats mid-sync, the contacts' faces), and each state drew the list and its 30 rows again.
   */

  const NOW = Date.now();
  const key = (i: number) => `p${i}`.padEnd(52, "a");
  const chat = (i: number): ChatSession => ({ id: `chat-${i}`, profile: "paired-chat/1", mySeedB64: `seed-${i}`, peerPubKeyB64: key(i),
    encKeyB64: "enc", nick: `Contact ${i}`, createdAt: NOW, lastSyncAt: NOW - 60_000, messages: [{ id: `m-${i}`, text: `hello ${i}`, sender: "peer", timestamp: NOW - 60_000 }] });
  /** Every link and group as a new object, as each of the engine's states brings them. */
  const links = (patch: (i: number) => Partial<Parameters<typeof linkView>[0]> = () => ({})) =>
    Array.from({ length: 30 }, (_, i) => linkView({ id: `link-${i}`, peerPubKeyZ32: key(i), lastSyncAt: NOW - 60_000, ...patch(i) }));
  const groups = (name = "Climbing") => [groupView({ id: "g-1", name, status: "active", lastMessageAt: NOW - 60_000 })];

  beforeEach(() => {
    for (let i = 0; i < 30; i++) saveSession(chat(i));
    fakeEngine.update({ links: links(), groups: groups(), groupsLoaded: true });
  });

  it("is not drawn again", () => {
    let draws = 0;
    renderApp(<Profiler id="list" onRender={() => { draws++; }}><UpdateProvider><Sidebar /></UpdateProvider></Profiler>);
    expect(screen.getAllByTestId("chat-row")).toHaveLength(30);
    draws = 0;
    for (let i = 0; i < 20; i++) act(() => fakeEngine.update({ links: links(), groups: groups(), transfers: { [`t${i}`]: { bytes: i } } } as never));
    expect(draws).toBe(0);
  });

  it("but shows what does change: a group's name, a chat's first sync", () => {
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    act(() => fakeEngine.update({ groups: groups("Bouldering") }));
    expect(screen.getByTestId("group-row")).toHaveTextContent("Bouldering");
    const row = () => screen.getAllByTestId("chat-row").find((r) => within(r).getByTestId("chat-row-name").textContent === "Contact 3")!;
    expect(row().querySelector(".animate-ghost-boo")).toBeNull();
    act(() => fakeEngine.update({ links: links((i) => (i === 3 ? { lastSyncAt: 0, poll: { polling: true, nextAt: 0, interval: 0 } } : {})) }));
    expect(row().querySelector(".animate-ghost-boo")).not.toBeNull();
    act(() => fakeEngine.update({ links: links() }));
    expect(row().querySelector(".animate-ghost-boo")).toBeNull();
  });
});

// covers: chats.list.rows
describe("the chat list on an engine state that changes nothing it shows", () => {
  /*
   * Every row of the chat list reads its contact's link (picture, typing, DHT only, identities). Each looked it up with a
   * pass over the whole list of chats, six per row, on every engine state: N rows x N links, ~63 ms a state at 2,000
   * chats while nothing on screen changed. A row finds its contact in an index made once per state.
   */

  const N = 200;
  const NOW = Date.now();
  const key = (i: number) => `p${i}`.padEnd(52, "a");
  const chat = (i: number): ChatSession => ({ id: `chat-${i}`, profile: "paired-chat/1", mySeedB64: `seed-${i}`, peerPubKeyB64: key(i),
    encKeyB64: "enc", nick: `Contact ${i}`, createdAt: NOW, lastSyncAt: NOW - 60_000, messages: [{ id: `m-${i}`, text: `hello ${i}`, sender: "peer", timestamp: NOW - 60_000 }] });
  const links = () => Array.from({ length: N }, (_, i) => linkView({ id: `link-${i}`, peerPubKeyZ32: key(i), lastSyncAt: NOW - 60_000 }));

  /** Counts the items visited by array passes over the engine state's chats or group edges. */
  const PASSES = ["find", "findIndex", "findLast", "some", "every", "filter", "map", "forEach", "reduce", "flatMap"] as const;
  let visited = 0;
  const originals = new Map<string, unknown>();
  function countPasses() {
    for (const name of PASSES) {
      const original = (Array.prototype as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
      originals.set(name, original);
      Object.defineProperty(Array.prototype, name, {
        configurable: true, writable: true,
        value: function (this: unknown[], ...args: unknown[]) {
          if (this === engine.state?.links || this === engine.state?.edges) visited += this.length;
          return original.apply(this, args);
        },
      });
    }
  }

  beforeEach(() => {
    for (let i = 0; i < N; i++) saveSession(chat(i));
    fakeEngine.update({ links: links(), groups: [], groupsLoaded: true });
  });
  afterEach(() => {
    for (const [name, original] of originals) Object.defineProperty(Array.prototype, name, { configurable: true, writable: true, value: original });
    originals.clear();
  });

  it("does not have each row scan the whole list of chats", () => {
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    expect(screen.getAllByTestId("chat-row")).toHaveLength(N);
    countPasses();
    visited = 0;
    const states = 5;
    for (let i = 0; i < states; i++) act(() => fakeEngine.update({ links: links(), transfers: { [`t${i}`]: { bytes: i } } } as never));
    // A few passes over the list per state are linear; one per row is N x N (six per row was ~120,000 here).
    expect(visited / states).toBeLessThan(10 * N);
  });
});

// covers: chats.mute
describe("the chat list and the window's storage listeners", () => {
  /*
   * Another page of the app (another profile's, often) writes its keys many times a second, and the browser calls every
   * `storage` listener on the window for each write. A row of the chat list added its own (two for its mute, one for its
   * contact's face): 900 calls per write with 300 chats. The rows share one listener per store now.
   */

  const CHATS = 300;
  const props = (i: number) => ({ chatId: `chat-${i}`, density: "compact", active: false, label: `Contact ${i}`, named: true, keyLabel: "abcdef...uvwxyz", peerPubKey: `peer-${i}`,
    time: "12:00", unread: 1, pinned: false, syncing: false, creator: false, onOpen: () => {}, onTogglePin: () => {}, onDelete: () => {}, deleteLabel: "Delete" }) as ChatRowProps;
  const List = ({ n }: { n: number }) => <>{Array.from({ length: n }, (_, i) => <ChatRow key={i} {...props(i)} />)}</>;

  /** The window's `storage` listeners now. */
  let listening: Set<unknown>;
  beforeEach(() => {
    listening = new Set();
    const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === "storage") listening.add(listener);
      add(type, listener, options);
    });
    vi.spyOn(window, "removeEventListener").mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (type === "storage") listening.delete(listener);
      remove(type, listener, options);
    });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const rowOf = (chat: string) => screen.getAllByTestId("chat-row").find(r => r.dataset.chat === chat)!;
  /** Another page of the app writing `key`. */
  const writtenElsewhere = (key: string, value: string | null) => act(() => {
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: value, storageArea: localStorage }));
  });

  it(`${CHATS} rows add a few listeners, not three each`, () => {
    const { rerender } = renderApp(<List n={0} />);
    const without = listening.size;
    rerender(<List n={CHATS} />);
    expect(listening.size - without).toBeLessThanOrEqual(2);
    rerender(<List n={0} />);
    expect(listening.size).toBe(without);
  });

  it("a mute made in another page still shows on its row, and only on its row", () => {
    renderApp(<List n={CHATS} />);
    expect(rowOf("chat-7")).not.toHaveAttribute("data-muted");
    writtenElsewhere("ghostly_mute_chat-7", "forever");
    expect(rowOf("chat-7")).toHaveAttribute("data-muted", "true");
    expect(within(rowOf("chat-7")).getByTestId("chat-row-mute")).toHaveAttribute("data-muted", "forever");
    expect(rowOf("chat-8")).not.toHaveAttribute("data-muted");
    // Another profile's key for a chat of the same id is not this one's.
    writtenElsewhere("ghostly_abcde12345_mute_chat-8", "forever");
    expect(rowOf("chat-8")).not.toHaveAttribute("data-muted");
    writtenElsewhere("ghostly_mute_chat-7", null);
    expect(rowOf("chat-7")).not.toHaveAttribute("data-muted");
  });
});

// covers: chats.list.delete
describe("Delete chat from the chat list while a call is on in that chat", () => {
  const NOW = Date.now();
  const chat = (id: string, nick: string): ChatSession =>
    ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: id.repeat(52), encKeyB64: "enc", nick, messages: [], createdAt: NOW });
  const rowOf = (name: string) => screen.getAllByTestId("chat-row").find(r => within(r).getByTestId("chat-row-name").textContent === name)!;

  afterEach(() => setChatOnCall("a", false));

  // Deleted under its call, the chat was gone and the call talked on; its hang-up then never crossed to the contact.
  it("says to end the call first and keeps the chat; once the call is over it deletes", async () => {
    saveSession(chat("a", "Ana"));
    saveSession(chat("b", "Bo"));
    setChatOnCall("a", true);
    const { user } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    await user.click(within(rowOf("Ana")).getByRole("button", { name: "Delete chat" }));
    const dialog = screen.getByRole("dialog", { name: "Delete chat?" });
    expect(dialog).toHaveAccessibleDescription("A call is on in this chat. End it first, then delete the chat.");
    const confirm = within(dialog).getByRole("button", { name: "Delete chat" });
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(loadSession("a")).not.toBeNull();

    // The call ends while the dialog is open: Delete is on again, and deletes.
    act(() => setChatOnCall("a", false));
    expect(dialog).toHaveAccessibleDescription(/^This deletes the chat and its history from this device/);
    await user.click(within(dialog).getByRole("button", { name: "Delete chat" }));
    expect(loadSession("a")).toBeNull();
  });

  // A call ringing while Delete held the focus turned it off under the focus: Chromium dropped it to the page, where
  // Tab went nowhere and only Escape left the dialog. Cancel takes it, as when the dialog opens.
  it("hands the focus to Cancel when a call starts while Delete has it", async () => {
    saveSession(chat("a", "Ana"));
    const { user } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    await user.click(within(rowOf("Ana")).getByRole("button", { name: "Delete chat" }));
    const dialog = screen.getByRole("dialog", { name: "Delete chat?" });
    await user.keyboard("{Tab}");
    expect(within(dialog).getByRole("button", { name: "Delete chat" })).toHaveFocus();
    act(() => setChatOnCall("a", true));
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("leaves another chat's delete as it was", async () => {
    saveSession(chat("a", "Ana"));
    saveSession(chat("b", "Bo"));
    setChatOnCall("a", true);
    const { user } = renderApp(<UpdateProvider><Sidebar /></UpdateProvider>);
    await user.click(within(rowOf("Bo")).getByRole("button", { name: "Delete chat" }));
    const dialog = screen.getByRole("dialog", { name: "Delete chat?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete chat" }));
    expect(loadSession("b")).toBeNull();
    expect(loadSession("a")).not.toBeNull();
  });
});

// covers: chats.list.rows, chats.list.rail
describe("the open chat's row after a reload", () => {
  const NOW = Date.now();
  const chat = (id: string, at: number): ChatSession =>
    ({ id, profile: "paired-chat/1", mySeedB64: `seed-${id}`, peerPubKeyB64: id.padEnd(52, "x"), encKeyB64: "enc", messages: [], createdAt: at, nick: id });

  /*
   * happy-dom lays nothing out: the list and the rail are 800 px tall at the top of the window, and each row or rail place
   * is 60 px under the one before it, as a browser draws 40 chats. `scrollIntoView` is recorded.
   */
  const ROW = 60, VIEW = 800;
  const scrolled = vi.fn();
  const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 300, width: 300, height, x: 0, y: top, toJSON() {} }) as DOMRect;
  beforeEach(() => {
    scrolled.mockClear();
    Element.prototype.scrollIntoView = function (this: Element, how?: boolean | ScrollIntoViewOptions) { scrolled(this, how); };
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (this.matches("[data-testid=chat-list],[data-testid=chat-rail]")) return rect(0, VIEW);
      const rows = this.closest("[data-testid=chat-list],[data-testid=chat-rail]")?.querySelectorAll("[data-chat],[data-group]") ?? [];
      return rect([...rows].indexOf(this) * ROW, ROW);
    });
  });
  afterEach(() => { vi.restoreAllMocks(); delete (Element.prototype as Partial<Element>).scrollIntoView; });

  /** 40 chats, the newest first in the list: `c1` at the top, `c40` at its foot, far out of sight. */
  function fortyChats() {
    for (let i = 1; i <= 40; i++) saveSession(chat(`c${i}`, NOW - i * 60_000));
  }
  const sidebar = (route: string) => renderApp(<UpdateProvider><Sidebar /></UpdateProvider>, { route });
  const scrolledTo = () => scrolled.mock.calls.map(([el, how]) => [(el as Element).getAttribute("data-chat") ?? `group:${(el as Element).getAttribute("data-group")}`, how]);

  it("is brought into view once in a long list, and the list stays where it is on later draws", async () => {
    fortyChats();
    sidebar("/chat/c36");
    await screen.findAllByTestId("chat-row");
    expect(scrolledTo()).toEqual([["c36", { block: "center" }]]);

    // The list is read again (a message, a pin), the engine's state comes: nothing moves it again.
    act(() => { window.dispatchEvent(new Event("session-updated")); });
    act(() => fakeEngine.update({ groups: [] }));
    expect(scrolled).toHaveBeenCalledTimes(1);
  });

  it("moves nothing when the open chat's row is already in sight, nor when a row in sight is clicked", async () => {
    fortyChats();
    const { user } = sidebar("/chat/c3");
    await screen.findAllByTestId("chat-row");
    await user.click(within(screen.getByTestId("chat-list")).getAllByTestId("chat-row")[5]);
    expect(scrolled).not.toHaveBeenCalled();
  });

  it("brings a group's place on the rail into view, and the list's row again when the list unfolds", async () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ chatListCollapsed: true }));
    // The groups come first in the list and on the rail: 40 of them put the 36th out of sight.
    act(() => fakeEngine.update({ groups: Array.from({ length: 40 }, (_, i) => groupView({ id: `g${i + 1}`, name: `Group ${i + 1}`, status: "active", lastMessageAt: NOW - i * 60_000 })) }));
    const { user } = sidebar("/group/g36");
    await within(screen.getByTestId("chat-rail")).findAllByTestId("chat-rail-group");
    expect(scrolledTo()).toEqual([["group:g36", { block: "center" }]]);

    await user.click(screen.getByTestId("chat-list-toggle"));
    expect(screen.getByTestId("chat-list")).toBeInTheDocument();
    expect(scrolledTo()).toEqual([["group:g36", { block: "center" }], ["group:g36", { block: "center" }]]);
  });
});

// covers: app.i18n, chats.list.rows
describe("a payment this app refused, in the chat", () => {
  /*
   * agents#2252: the line this app writes when it refuses a contact's payment ("Could not receive 21 sats: …") showed in
   * English in every language, on the contact's side as a message of theirs, and said "sats" for test sats. It is the
   * app's own line now, said from the values the engine stores with it; a line stored before them is read from its English.
   */

  const REASON = "Ecash from 127.0.0.1 is not accepted";
  /** As the engine writes it now (shared/refusals.ts `refusedRow`), mirrored by sync.ts. */
  const refused: ChatMessage = {
    id: "peer_7_refused", text: `Could not receive 21 test sats: ${REASON}`, sender: "system", timestamp: 7,
    notice: { type: "paymentRefused", amount: 21, network: "testnet", reason: REASON },
  };
  /** As every version before stored it, and a session mirrored then still holds it: the contact's row, English text. */
  const older: ChatMessage = { id: "peer_8_refused", text: `Could not receive 21 sats: ${REASON}`, sender: "peer", timestamp: 8 };

  const said = (language: "ar" | "pt" | "ja", key: string, amount = 21) => lookup(language, `chat.refused.${key}`)!
    .replace("{{amount}}", formatAmount(amount, language))
    .replace("{{reason}}", lookup(language, "errors.cashu.mintNotAccepted")!.replace("{{host}}", "127.0.0.1"));

  it("is the app's own line in Arabic, in test sats, with the reason translated", () => {
    renderApp(<MessageBubble message={refused} />, { language: "ar" });
    const line = screen.getByTestId("refused-line");
    expect(line).toHaveTextContent(said("ar", "testSats"));
    expect(line.textContent).toContain("ساتس تجريبية");
    expect(screen.queryByText(/Could not receive/)).toBeNull();
    // Centred as the app's lines are, never a bubble on the contact's side.
    expect(line.closest("[data-message-row]")).toHaveAttribute("data-sender", "system");
    expect(document.querySelector('[data-sender="peer"]')).toBeNull();
  });

  it("leaves a contact's own message that says the same words as their message, under whichever id", () => {
    // A row the chat holds as the contact's is theirs: the mirror makes an older line of the app's its line from the
    // engine's row (platform/sync.ts), which tells the two apart; the words and the id alone do not.
    for (const id of ["peer_9", "peer_17900000000000_refused"]) {
      const { unmount } = renderApp(<MessageBubble message={{ ...older, id }} />, { language: "pt" });
      expect(screen.queryByTestId("refused-line")).toBeNull();
      expect(screen.getByText(older.text).closest("[data-message-row]")).toHaveAttribute("data-sender", "peer");
      unmount();
    }
  });

  it("says Fedimint's in its words, and a refusal before any amount was read", () => {
    const fedimint: ChatMessage = { id: "peer_10_refused", text: "Could not receive Fedimint ecash: These notes were already redeemed", sender: "system", timestamp: 10,
      notice: { type: "paymentRefused", amount: 5, network: "testnet", method: "fedimint", reason: "These notes were already redeemed" } };
    renderApp(<MessageBubble message={fedimint} />, { language: "ja" });
    expect(screen.getByTestId("refused-line")).toHaveTextContent(lookup("ja", "chat.refused.testSatsFedimint")!
      .replace("{{amount}}", formatAmount(5, "ja")).replace("{{reason}}", lookup("ja", "errors.pay.notesRedeemed")!));
  });

  it("is the chat list's last line in the app's language, not the stored English", () => {
    const key = "k".repeat(52);
    const session: ChatSession = { id: "c", profile: "paired-chat/1", mySeedB64: "seed-c", peerPubKeyB64: key, encKeyB64: "enc", nick: "Cleo", nickSource: "profile",
      messages: [{ id: "m1", text: "here you go", sender: "peer", timestamp: 1 }, refused], createdAt: 0 };
    saveSession(session);
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>, { language: "ja" });
    const row = screen.getAllByTestId("chat-row").find(r => within(r).getByTestId("chat-row-name").textContent === "Cleo")!;
    expect(row).toHaveTextContent(said("ja", "testSats"));
    expect(row.textContent).not.toContain("Could not receive");
  });

  it("leaves the chat list's last line the contact's when their row says those words", () => {
    const key = "q".repeat(52);
    const session: ChatSession = { id: "d", profile: "paired-chat/1", mySeedB64: "seed-d", peerPubKeyB64: key, encKeyB64: "enc", nick: "Dora", nickSource: "profile",
      messages: [{ ...older, id: "peer_17900000000000_refused" }], createdAt: 0 };
    saveSession(session);
    renderApp(<UpdateProvider><Sidebar /></UpdateProvider>, { language: "ja" });
    const row = screen.getAllByTestId("chat-row").find(r => within(r).getByTestId("chat-row-name").textContent === "Dora")!;
    expect(row).toHaveTextContent(older.text);
    expect(row.textContent).not.toContain(said("ja", "sats"));
  });
});
