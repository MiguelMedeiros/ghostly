import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { addMessages, getLastReadCount, loadSession, markSessionAsRead, saveSession } from "../../lib/storage";
import type { ChatMessage, ChatSession } from "../../lib/types";

// covers: chat.scroll, chat.paired.receipts
describe("a message arriving in a long chat", () => {
  /*
   * A message arriving in a long chat (`addMessages`, as the session mirror calls it with the session it holds): it comes
   * after every message the chat has, so nothing is sorted again and nothing is looked for among the read ones. Sorting the
   * whole history and scanning it for a late row was a pass over every message of the chat per arrival.
   */

  const PEER = "peer".padEnd(52, "p");
  const T = 1_700_000_000_000;
  const COUNT = 5_000;
  const theirs = (i: number, at = T + i * 1000): ChatMessage => ({ id: `peer_${i}`, sender: "peer", text: `message ${i}`, timestamp: at });

  function longChat(): ChatSession {
    const session: ChatSession = { id: "chat-1", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: Array.from({ length: COUNT }, (_, i) => theirs(i)), createdAt: T - 1000 };
    saveSession(session);
    markSessionAsRead("chat-1");
    return loadSession("chat-1")!;
  }

  /** Whole-history passes: sorts and searches over arrays as long as the chat. */
  function passes() {
    const counted = { sorts: 0, finds: 0 };
    const { sort, findIndex } = Array.prototype;
    vi.spyOn(Array.prototype, "sort").mockImplementation(function (this: unknown[], compare) { if (this.length >= COUNT) counted.sorts++; return sort.call(this, compare); });
    vi.spyOn(Array.prototype, "findIndex").mockImplementation(function (this: unknown[], predicate, self) { if (this.length >= COUNT) counted.finds++; return findIndex.call(this, predicate, self); });
    return counted;
  }

  afterEach(() => { vi.restoreAllMocks(); });

  it("is put after the others without sorting them or looking among the read ones", () => {
    const held = longChat();
    const counted = passes();
    const updated = addMessages("chat-1", [theirs(COUNT), theirs(COUNT + 1)], false, held)!;
    vi.restoreAllMocks();
    expect(counted).toEqual({ sorts: 0, finds: 0 });
    expect(updated.messages.slice(-3).map((m) => m.id)).toEqual([`peer_${COUNT - 1}`, `peer_${COUNT}`, `peer_${COUNT + 1}`]);
    // Unread: the two new ones, after every one read.
    expect(getLastReadCount("chat-1")).toBe(COUNT);
    expect(loadSession("chat-1")!.messages).toHaveLength(COUNT + 2);
  });

  it("is told new from the ids that came, not from a set of every id the chat holds", () => {
    const held = longChat();
    const add = vi.spyOn(Set.prototype, "add");
    addMessages("chat-1", [theirs(COUNT)], false, held);
    const added = add.mock.calls.length;
    vi.restoreAllMocks();
    // It was the chat's 5,000 ids, one by one, for one row.
    expect(added).toBeLessThan(10);
    expect(loadSession("chat-1")!.messages).toHaveLength(COUNT + 1);
  });

  it("one that was held up on its way still sorts in among the read ones, and the unread count starts from it", () => {
    const held = longChat();
    const late = theirs(COUNT, T + 10.5 * 1000);
    const updated = addMessages("chat-1", [late], false, held)!;
    expect(updated.messages[11]!.id).toBe(`peer_${COUNT}`);
    expect(getLastReadCount("chat-1")).toBe(11);
  });

  it("one the chat has already, or deleted here, is not added again", () => {
    const held = longChat();
    saveSession({ ...held, deletedIds: [`peer_${COUNT}`] });
    const updated = addMessages("chat-1", [theirs(COUNT), theirs(COUNT - 1), theirs(COUNT + 1), theirs(COUNT + 1)])!;
    expect(updated.messages.slice(-2).map((m) => m.id)).toEqual([`peer_${COUNT - 1}`, `peer_${COUNT + 1}`]);
    expect(updated.messages).toHaveLength(COUNT + 1);
  });
});

// covers: chat.paired.storage
describe("a contact who rings and hangs up over and over", () => {
  /*
   * A contact who rang and hung up over and over left two lines a call ("Incoming audio call", "Missed audio call") in
   * the chat's stored copy, and none ever left: a paired chat's stored copy keeps its last `STORED_MESSAGES` rows of
   * those the engine keeps, and a call's line is one only the page keeps. 9,000 calls were 18,000 stored rows, 3 M
   * characters stringified on every later write, past WebKit's quota. A chat keeps its last call lines; older ones go
   * from this device as a deleted message does, and the unread count stays right.
   */

  const NOW = 1_800_000_000_000;
  const N = 1_000;
  const CALLS = 500;

  const storage = () => import("../../lib/storage");

  /** One ring from the chat's contact, missed. */
  async function ring(call: number) {
    const { addMessage } = await storage();
    const at = NOW + N + call * 10;
    addMessage("chat", { id: `system_call_call_received_${at}`, text: "Incoming audio call", sender: "system", timestamp: at, callEvent: { type: "call_received", hasVideo: false } });
    addMessage("chat", { id: `system_call_call_missed_${at}`, text: "Missed audio call", sender: "system", timestamp: at + 1, callEvent: { type: "call_missed", hasVideo: false } });
  }

  /** A paired chat of N messages the engine keeps, read, then CALLS rings from its contact. */
  async function rungChat() {
    const { saveSession, setEngineMessages, markSessionAsRead } = await storage();
    const messages: ChatMessage[] = Array.from({ length: N }, (_, i) => ({ id: `peer_${i}`, text: `message ${i}`, sender: "peer", timestamp: NOW + i }));
    const session: ChatSession = { id: "chat", profile: "paired-chat/1", mySeedB64: "seed", peerPubKeyB64: "p".repeat(52), encKeyB64: "enc", messages, createdAt: NOW };
    setEngineMessages("chat", new Set(messages.map((m) => m.id)));
    saveSession(session);
    markSessionAsRead("chat");
    for (let call = 0; call < CALLS; call++) await ring(call);
    return messages;
  }

  const storedRows = () => (JSON.parse(localStorage.getItem("ghostly_chat")!) as ChatSession).messages;

  it("leaves the chat's stored copy about as long as any chat's", async () => {
    const { STORED_MESSAGES, CALL_LINES, loadSession } = await storage();
    await rungChat();
    expect(storedRows().length).toBeLessThanOrEqual(STORED_MESSAGES + CALL_LINES);
    // The latest lines stay, in the stored copy and in the chat.
    const lines = loadSession("chat")!.messages.filter((m) => m.callEvent);
    expect(lines).toHaveLength(CALL_LINES);
    expect(lines[lines.length - 1]!.id).toBe(`system_call_call_missed_${NOW + N + (CALLS - 1) * 10}`);
    expect(storedRows().filter((m) => m.callEvent)).toEqual(lines);
    // Every message the engine keeps is still in the chat.
    expect(loadSession("chat")!.messages.filter((m) => !m.callEvent)).toHaveLength(N);
  });

  it("counts as unread the missed calls the chat still shows, and the next message after a reload", async () => {
    const { CALL_LINES, getUnreadCount, loadSession, markSessionAsRead } = await storage();
    const messages = await rungChat();
    expect(getUnreadCount(loadSession("chat")!)).toBe(CALL_LINES / 2);
    markSessionAsRead("chat");
    // One more: the oldest lines, read, make room for its two.
    await ring(CALLS);
    expect(getUnreadCount(loadSession("chat")!)).toBe(1);

    // The page reloads: its stored copy only, until the engine brings back the whole history.
    vi.resetModules();
    const again = await storage();
    again.setEngineMessages("chat", new Set(messages.map((m) => m.id)));
    expect(again.getUnreadCount(again.loadSession("chat")!)).toBe(1);
    again.addMessages("chat", messages, true);
    expect(again.getUnreadCount(again.loadSession("chat")!)).toBe(1);
    again.addMessage("chat", { id: "peer_new", text: "there?", sender: "peer", timestamp: NOW + N + (CALLS + 1) * 10 });
    expect(again.getUnreadCount(again.loadSession("chat")!)).toBe(2);
  });
});

// covers: chat.paired.storage
describe("a long chat read back after a message came", () => {
  /*
   * A long chat's stored copy holds its last rows; this page keeps the rest and puts them back on each read. A message
   * that came wrote the copy, and the chat list's read after it looked at every older row and merged them all with the
   * copy's, for a copy that was just the last rows of that same list. They go before it as they are.
   */

  const NOW = 1_800_000_000_000;
  const N = 3_000;
  const storage = () => import("../../lib/storage");

  /** A paired chat of N messages the engine keeps, stored by this page, and a message that came. */
  async function longChat() {
    const { addMessage, saveSession, setEngineMessages } = await storage();
    const history: ChatMessage[] = Array.from({ length: N }, (_, i) => ({ id: `peer_${i}`, text: `message ${i}`, sender: "peer", timestamp: NOW + i }));
    setEngineMessages("chat", new Set([...history.map((m) => m.id), "peer_new"]));
    saveSession({ id: "chat", profile: "paired-chat/1", mySeedB64: "seed", peerPubKeyB64: "p".repeat(52), encKeyB64: "enc", messages: history, createdAt: NOW });
    addMessage("chat", { id: "peer_new", text: "back?", sender: "peer", timestamp: NOW + N });
    return history;
  }

  /** Counts each look at the id of a row the stored copy left out. */
  function watchOlder(history: ChatMessage[], stored: number) {
    let looks = 0;
    for (const row of history.slice(0, history.length - stored)) {
      const id = row.id;
      Object.defineProperty(row, "id", { enumerable: true, get: () => (looks++, id) });
    }
    return () => looks;
  }

  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("puts the rows its stored copy left out before it without looking at each", async () => {
    const { loadSession, STORED_MESSAGES } = await storage();
    const history = await longChat();
    const stored = JSON.parse(localStorage.getItem("ghostly_chat")!) as ChatSession;
    expect(stored.messages.length).toBeLessThanOrEqual(STORED_MESSAGES);
    const looks = watchOlder(history, stored.messages.length - 1);
    const chat = loadSession("chat")!;
    // It was every one of them, and a merge of all.
    expect(looks()).toBe(0);
    expect(chat.older).toBeUndefined();
    expect(chat.messages).toHaveLength(N + 1);
    expect(chat.messages.map((m) => m.id)).toEqual([...history.map((m) => m.id), "peer_new"]);
  });

  it("leaves out an older row deleted since, here or by another page of the app", async () => {
    const { loadSession } = await storage();
    await longChat();
    // Another page deleted one: its stored copy names it, this page's rows still have it.
    const raw = JSON.parse(localStorage.getItem("ghostly_chat")!) as ChatSession;
    localStorage.setItem("ghostly_chat", JSON.stringify({ ...raw, deletedIds: ["peer_5"] }));
    const chat = loadSession("chat")!;
    expect(chat.messages).toHaveLength(N);
    expect(chat.messages.some((m) => m.id === "peer_5")).toBe(false);
    expect(chat.messages[chat.messages.length - 1]!.id).toBe("peer_new");
  });

  it("still merges a stored copy that is not the last rows of what this page holds", async () => {
    const { loadSession } = await storage();
    await longChat();
    // Another page wrote a row this one has not seen, among the stored copy's.
    const raw = JSON.parse(localStorage.getItem("ghostly_chat")!) as ChatSession;
    const other: ChatMessage = { id: "peer_other", text: "from the other page", sender: "peer", timestamp: NOW + N - 50.5 };
    const messages = [...raw.messages, other].sort((a, b) => a.timestamp - b.timestamp);
    localStorage.setItem("ghostly_chat", JSON.stringify({ ...raw, messages }));
    const chat = loadSession("chat")!;
    expect(chat.messages).toHaveLength(N + 2);
    const at = chat.messages.findIndex((m) => m.id === "peer_other");
    expect(chat.messages[at - 1]!.id).toBe(`peer_${N - 51}`);
    expect(chat.messages[at + 1]!.id).toBe(`peer_${N - 50}`);
  });

  it("puts a stored row another page moved back in time in its place among the older ones", async () => {
    const { loadSession } = await storage();
    await longChat();
    // A received row given an earlier place since (engine/arrival.ts), by another page: the stored copy's first.
    const raw = JSON.parse(localStorage.getItem("ghostly_chat")!) as ChatSession;
    const [first, ...rest] = raw.messages;
    localStorage.setItem("ghostly_chat", JSON.stringify({ ...raw, messages: [{ ...first, timestamp: NOW + 10.5 }, ...rest] }));
    const chat = loadSession("chat")!;
    expect(chat.messages).toHaveLength(N + 1);
    expect(chat.messages[11]!.id).toBe(first.id);
  });
});

// covers: chat.paired.storage
describe("a long chat whose last rows are heavy", () => {
  /*
   * A paired chat's stored copy kept its last `STORED_MESSAGES` rows whole, though the engine keeps them: a feed's link
   * thumbnails (~25 K characters each) and an agent's texts edited 20 times rode in it, and every message that came wrote
   * and parsed megabytes again. The copy stays about as long as any chat's; the chat still has every thumbnail and edit.
   */

  const NOW = 1_800_000_000_000;
  const N = 5_000;
  const THUMB = `data:image/jpeg;base64,/9j/${"A".repeat(25_200)}`;

  const storage = () => import("../../lib/storage");

  function rows(kind: "links" | "edits"): ChatMessage[] {
    return Array.from({ length: N }, (_, i) => {
      const m: ChatMessage = { id: `peer_${i}`, text: `message ${i}`, sender: "peer", timestamp: NOW + i };
      // 40 thumbnails among the last 200 rows; 25 texts edited 20 times.
      if (kind === "links" && i % 5 === 1) m.preview = { u: `https://news.example/${i}`, t: `Story ${i}`, s: "News", i: THUMB };
      if (kind === "edits" && i % 8 === 1) {
        const version = (k: number) => `Working on #${i}: ${"step ".repeat(240)}${k}`;
        m.text = version(20);
        m.edit = { seq: 20, at: NOW + i + 1, history: Array.from({ length: 19 }, (_, k) => ({ at: NOW + i, text: version(k + 1) })) };
      }
      return m;
    });
  }

  const storedRaw = () => localStorage.getItem("ghostly_chat")!;

  async function arrival(kind: "links" | "edits") {
    const { addMessage, saveSession, setEngineMessages } = await storage();
    const history = rows(kind);
    const session: ChatSession = { id: "chat", profile: "paired-chat/1", mySeedB64: "seed", peerPubKeyB64: "p".repeat(52), encKeyB64: "enc", messages: history, createdAt: NOW };
    setEngineMessages("chat", new Set(history.map((m) => m.id)));
    saveSession(session);
    addMessage("chat", { id: "peer_new", text: "back?", sender: "peer", timestamp: NOW + N });
    return history;
  }

  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it.each(["links", "edits"] as const)("keeps its stored copy about as long as any chat's (%s)", async (kind) => {
    const { loadSession } = await storage();
    const history = await arrival(kind);
    expect(storedRaw().length).toBeLessThan(250_000);
    const stored = JSON.parse(storedRaw()) as ChatSession;
    expect(stored.messages[stored.messages.length - 1]!.id).toBe("peer_new");
    expect(stored.older! + stored.messages.length).toBe(N + 1);
    // This page's chat has every row, heavy parts included.
    const chat = loadSession("chat")!;
    expect(chat.messages).toHaveLength(N + 1);
    expect(chat.messages.slice(0, N)).toEqual(history);
  });

  it("shows the thumbnails again once the engine's history is back after a reload", async () => {
    const history = await arrival("links");
    vi.resetModules();
    const again = await storage();
    again.setEngineMessages("chat", new Set([...history.map((m) => m.id), "peer_new"]));
    expect(again.loadSession("chat")!.messages.length).toBeLessThan(N + 1);
    again.addMessages("chat", history, true);
    const chat = again.loadSession("chat")!;
    expect(chat.messages).toHaveLength(N + 1);
    expect(chat.messages.filter((m) => m.preview?.i === THUMB)).toHaveLength(N / 5);
    expect(storedRaw().length).toBeLessThan(250_000);
  });
});
