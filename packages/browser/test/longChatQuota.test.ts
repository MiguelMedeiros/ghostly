import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatSession } from "../../../apps/ui/src/lib/types";
import type { LinkView, StoredMessage } from "../src/shared/types";
// covers: chat.paired.storage

/**
 * A long 1:1 chat past what the page's storage holds. The engine keeps a chat's history (IndexedDB); the page mirrors it
 * into the chat's localStorage session, which the chat list and the chat read (`platform/sync.ts`). A chat of thousands
 * of messages overflowed that storage (5 MB in WebKit, the Desktop app's), its writes failed without a word, and the
 * chat stopped showing what came. Now the session keeps only the chat's last messages, and those the engine does not
 * keep (a call's line): the chat reads the rest from the engine's copy, which the page holds.
 */
const fake = vi.hoisted(() => ({
  engine: {
    state: null as { links: LinkView[] } | null,
    messages: new Map<string, StoredMessage[]>(),
    stateListeners: [] as (() => void)[],
    messageListeners: [] as ((linkId: string, messages: StoredMessage[]) => void)[],
    connect: async () => {},
    subscribe(listener: () => void) { fake.engine.stateListeners.push(listener); return () => {}; },
    onMessages(listener: (linkId: string, messages: StoredMessage[]) => void) { fake.engine.messageListeners.push(listener); return () => {}; },
    linkByPeer(peer: string) { return fake.engine.state?.links.find((l) => l.peerPubKeyZ32 === peer); },
    async call() { return undefined; },
  },
}));
vi.mock("../src/platform/engine", () => ({ engine: fake.engine }));

/** localStorage with a quota, in characters, as a browser has one: a write past it throws and changes nothing. */
class QuotaStorage {
  readonly items = new Map<string, string>();
  writes: string[] = [];
  constructor(public quota: number) {}
  get used() { let n = 0; for (const [k, v] of this.items) n += k.length + v.length; return n; }
  get length() { return this.items.size; }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) {
    const next = this.used - (this.items.get(key)?.length ?? -key.length) + String(value).length;
    if (next > this.quota) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    this.items.set(key, String(value));
    this.writes.push(key);
  }
  removeItem(key: string) { this.items.delete(key); }
  clear() { this.items.clear(); }
}

const COUNT = 5_000;
const LINK = "link-1", PEER = "peer-1", SESSION = "s1", KEY = `ghostly_${SESSION}`;
const at = (i: number) => 1_700_000_000_000 + i * 60_000;
/** The engine's rows: every third mine (delivered), the rest the contact's, texts about as long as a bot's lines. */
const stored = (i: number): StoredMessage => ({
  linkId: LINK, id: i % 3 === 0 ? `me_w${i}` : `peer_w${i}`, text: `Report ${i}: the nightly run finished, every check green, nothing left to do.`,
  sender: i % 3 === 0 ? "me" : "peer", timestamp: at(i), via: "datalink", ...(i % 3 === 0 && { delivery: "delivered" as const }),
});
/** As the mirror writes a row into the session. */
const row = (m: StoredMessage): ChatMessage => ({ id: m.id, text: m.text, sender: m.sender as "me" | "peer", timestamp: m.timestamp, ...(m.delivery && { delivery: m.delivery }) });
/** A call's line: only this page keeps it (the chat adds it; the engine never had it). */
const callLine = (i: number): ChatMessage => ({ id: `call_${i}`, text: "📞 Call ended", sender: "system", timestamp: at(i) + 1, callEvent: { type: "ended", duration: 60 } } as ChatMessage);
const link = { id: LINK, peerPubKeyZ32: PEER, myPubKeyZ32: "me-1", createdAt: 1, deliveryMode: "stream", profile: "paired-chat/1" } as unknown as LinkView;
const session = (messages: ChatMessage[]): ChatSession => ({ id: SESSION, profile: "paired-chat/1", mySeedB64: "seed-1", peerPubKeyB64: PEER, encKeyB64: "enc-1", messages, createdAt: 1, deliveryMode: "stream" });

const engine = fake.engine;
let space: QuotaStorage;
let sync: typeof import("../src/platform/sync");
let storage: typeof import("../../../apps/ui/src/lib/storage");

/** This page's modules, fresh: a page (re)loaded over the same storage. */
async function page() {
  vi.resetModules();
  engine.stateListeners = [];
  engine.messageListeners = [];
  sync = await import("../src/platform/sync");
  storage = await import("../../../apps/ui/src/lib/storage");
}
/** The engine reports its state (and, with it, the chat's history). */
async function engineSpeaks() {
  sync.startSessionSync();
  engine.state = { links: [link] };
  for (const listener of engine.stateListeners) listener();
  await vi.advanceTimersByTimeAsync(0);
}
const kept = () => JSON.parse(space.getItem(KEY)!) as ChatSession & { older?: number };

beforeEach(async () => {
  vi.useFakeTimers({ now: at(COUNT + 10) });
  const history = Array.from({ length: COUNT }, (_, i) => stored(i));
  engine.messages = new Map([[LINK, history]]);
  // The page's copy stopped at 4,000 messages: every write since failed at the quota. Three calls long ago.
  const stale = session([...history.slice(0, 4_000).map(row), callLine(10), callLine(500), callLine(3_990)].sort((a, b) => a.timestamp - b.timestamp));
  space = new QuotaStorage(0);
  space.items.set("gb-sessions-imported", "1");
  space.items.set(KEY, JSON.stringify(stale));
  space.items.set(`ghostly_read_${SESSION}`, "4003");
  // Full: a little room for small writes, none for the chat to grow.
  space.quota = space.used + 20_000;
  vi.stubGlobal("localStorage", space);
  vi.stubGlobal("window", new EventTarget());
  await page();
}, 60_000);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("a long chat past the page's storage", () => {
  it("opens whole and current from the engine's copy, and its session keeps only its last messages and its calls", async () => {
    await engineSpeaks();
    // Written, and small: the last messages and the three calls.
    expect(space.writes).toContain(KEY);
    const small = kept();
    expect(small.messages.length).toBeLessThanOrEqual(storage.STORED_MESSAGES + 3);
    expect(small.messages.filter(m => m.callEvent)).toHaveLength(3);
    expect(small.older).toBe(COUNT + 3 - small.messages.length);
    expect(space.getItem(KEY)!.length).toBeLessThan(80_000);

    // The chat reads all of it: 5,000 messages and the calls, in order, the newest there.
    const whole = storage.loadSession(SESSION)!;
    expect(whole.messages).toHaveLength(COUNT + 3);
    expect(whole.messages.at(-1)!.id).toBe(stored(COUNT - 1).id);
    expect(whole.messages.filter(m => m.callEvent).map(m => m.id)).toEqual(["call_10", "call_500", "call_3990"]);
    expect(whole.messages.every((m, i, all) => i === 0 || all[i - 1].timestamp <= m.timestamp)).toBe(true);
    // The 1,000 that never reached the session count as unread, as they would have.
    expect(storage.getUnreadCount(storage.listSessions()[0])).toBe(1_000 - 333);
    storage.markSessionAsRead(SESSION);
    expect(storage.getUnreadCount(storage.listSessions()[0])).toBe(0);

    // A new one comes: shown, counted, and the session stays small.
    const next = [...engine.messages.get(LINK)!, stored(COUNT + 2)]; // the contact's
    engine.messages.set(LINK, next);
    for (const listener of engine.messageListeners) listener(LINK, next);
    expect(storage.loadSession(SESSION)!.messages).toHaveLength(COUNT + 4);
    expect(storage.getUnreadCount(storage.listSessions()[0])).toBe(1);
    expect(kept().messages.length).toBeLessThanOrEqual(storage.STORED_MESSAGES + 3);
  });

  it("after a reload, shows its last messages at once, the rest when the engine speaks, and writes nothing for it", async () => {
    await engineSpeaks();
    storage.markSessionAsRead(SESSION);
    await page();
    // Before the engine has spoken: its last messages, and nothing unread.
    const first = storage.loadSession(SESSION)!;
    expect(first.messages.length).toBeLessThanOrEqual(storage.STORED_MESSAGES + 3);
    expect(first.messages.at(-1)!.id).toBe(stored(COUNT - 1).id);
    expect(storage.getUnreadCount(storage.listSessions()[0])).toBe(0);
    // Then all of it, from the engine's copy, with the calls; the session as it was, not written again.
    space.writes = [];
    await engineSpeaks();
    expect(storage.loadSession(SESSION)!.messages).toHaveLength(COUNT + 3);
    expect(space.writes).not.toContain(KEY);
  });

  it("two pages over one storage (the extension's) settle: once both have mirrored, neither writes the chat again", async () => {
    await engineSpeaks();
    const first = { sync, storage };
    await page();
    await engineSpeaks();
    space.writes = [];
    // Both pages hear the engine's state again, and a list one of them has not caught up with yet.
    for (const listener of engine.stateListeners) listener();
    const behind = engine.messages.get(LINK)!.slice(0, -1);
    for (const listener of engine.messageListeners) listener(LINK, behind);
    await vi.advanceTimersByTimeAsync(0);
    expect(space.writes).not.toContain(KEY);
    expect(first.storage.loadSession(SESSION)!.messages).toHaveLength(COUNT + 3);
    expect(storage.loadSession(SESSION)!.messages).toHaveLength(COUNT + 3);
  });

  it("gives the chat list the same session while nothing changed (the sync's reconcile tells an unchanged list by them)", async () => {
    await engineSpeaks();
    const cache: import("../../../apps/ui/src/lib/storage").SessionCache = new Map();
    const first = storage.listSessions(cache)[0];
    expect(first.messages).toHaveLength(COUNT + 3);
    expect(storage.listSessions(cache)[0]).toBe(first);
  });

  it("deleting a message of a session read without its older ones keeps the unread count right", async () => {
    await engineSpeaks();
    storage.markSessionAsRead(SESSION);
    await page();
    // Before the engine speaks: only its last messages here.
    expect(storage.loadSession(SESSION)!.older).toBeGreaterThan(0);
    storage.deleteMessage(SESSION, stored(COUNT - 2).id);
    expect(storage.getUnreadCount(storage.listSessions()[0])).toBe(0);
    await engineSpeaks();
    const all = storage.loadSession(SESSION)!.messages;
    expect(all).toHaveLength(COUNT + 2);
    expect(all.some(m => m.id === stored(COUNT - 2).id)).toBe(false);
    expect(storage.getUnreadCount(storage.listSessions()[0])).toBe(0);
  });

  it("keeps a chat the engine does not keep (a compatibility chat before its link) whole", async () => {
    // No link for it: nothing says the engine has these, so none of them leaves the session.
    engine.messages = new Map();
    sync.startSessionSync();
    engine.state = { links: [] };
    for (const listener of engine.stateListeners) listener();
    await vi.advanceTimersByTimeAsync(0);
    expect(kept().messages.length).toBe(4_003);
    expect(storage.loadSession(SESSION)!.messages).toHaveLength(4_003);
  });
});

describe("no message has the page's storage as its only copy", () => {
  /** A small seeded generator: the same cases every run. */
  const random = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296; };
  /** Every id the chat has: what the session held, what the engine holds, and what the page added since. */
  let truth: Set<string>;
  const engineRows = () => engine.messages.get(LINK) ?? [];
  const storedIds = () => new Set(kept().messages.map(m => m.id));
  /** Ids whose only copy is gone: in neither the stored session nor the engine's copy (the engine's are all kept). */
  const lost = () => { const s = storedIds(), e = new Set(engineRows().map(m => m.id)); return [...truth].filter(id => !s.has(id) && !e.has(id)); };
  /** Ids the chat does not show once its page has heard the engine. */
  const unseen = () => { const shown = new Set(storage.loadSession(SESSION)!.messages.map(m => m.id)); return [...truth].filter(id => !shown.has(id)); };

  /**
   * A session from before (1.0.0, or older: from before the engine kept history), whole in localStorage, of every kind
   * of row: the engine's that the mirror writes; mine the engine has but the mirror never writes (the chat put them in
   * itself: a file I sent); rows the engine never had (a chat from before it kept history); page-only lines (calls);
   * and the engine's rows the session never got.
   */
  function scenario(next: () => number, size: number) {
    const engineList: StoredMessage[] = [];
    const rows: ChatMessage[] = [];
    for (let i = 0; i < size; i++) {
      const kind = next();
      if (kind < 0.55) { const m = stored(i); engineList.push(m); if (next() < 0.9) rows.push(row(m)); }
      else if (kind < 0.7) {
        const m: StoredMessage = { ...stored(i), id: `me_file${i}`, sender: "me", delivery: undefined, file: { id: `f${i}`, name: "a.pdf", size: 1, mime: "application/pdf" } } as StoredMessage;
        engineList.push(m);
        rows.push({ id: m.id, text: m.text, sender: "me", timestamp: m.timestamp });
      } else if (kind < 0.85) rows.push({ id: `peer_${at(i)}`, text: `Old line ${i}`, sender: "peer", timestamp: at(i) });
      else rows.push(callLine(i));
    }
    engine.messages = new Map([[LINK, engineList]]);
    space.items.set(KEY, JSON.stringify(session(rows.sort((a, b) => a.timestamp - b.timestamp))));
    space.quota = Infinity;
    truth = new Set([...rows.map(m => m.id), ...engineList.map(m => m.id)]);
  }

  it("holds through long sessions of every kind, messages coming, the page's own lines, reloads and a second page", { timeout: 60_000 }, async () => {
    for (let run = 0; run < 12; run++) {
      const next = random(run + 1);
      await page();
      scenario(next, 150 + Math.floor(next() * 900));
      for (let step = 0; step < 8; step++) {
        const what = next();
        if (what < 0.35) await engineSpeaks();
        else if (what < 0.55) {
          // Messages come: the engine has them (stored, then told), the page's mirror hears them.
          const list = [...engineRows()];
          const from = list.length + 10_000 + step * 50;
          for (let k = 0; k < 1 + Math.floor(next() * 40); k++) { const m = stored(from + k); list.push(m); truth.add(m.id); }
          engine.messages.set(LINK, list);
          for (const listener of engine.messageListeners) listener(LINK, list);
        } else if (what < 0.75) {
          // A line only this page keeps (a call's), at any time, even among old messages.
          const line = { ...callLine(Math.floor(next() * 12_000)), id: `call_new${run}_${step}` };
          storage.addMessage(SESSION, line);
          truth.add(line.id);
        } else if (what < 0.9) await page();
        else { await page(); await engineSpeaks(); await page(); }
        expect(lost(), `run ${run}, step ${step}`).toEqual([]);
      }
      // Heard by a fresh page, the chat shows every one of them.
      await page();
      await engineSpeaks();
      expect(unseen(), `run ${run}`).toEqual([]);
      expect(lost(), `run ${run}`).toEqual([]);
    }
  });

  it("a long session written whole by 1.0.0 is stored anew on the first open after the update, and loses nothing", async () => {
    const next = random(42);
    scenario(next, 5_000);
    const before = storage.loadSession(SESSION)!.messages;
    expect(before.length).toBeGreaterThan(4_000);
    await engineSpeaks();
    // Stored anew, small, with every row the engine does not bring back.
    expect(kept().messages.length).toBeLessThan(before.length / 2);
    expect(lost()).toEqual([]);
    // After a reload, the chat has each row as it was, and the engine's that the session never got.
    await page();
    await engineSpeaks();
    const after = new Map(storage.loadSession(SESSION)!.messages.map(m => [m.id, m]));
    for (const m of before) expect(after.get(m.id)?.text, m.id).toBe(m.text);
    expect(unseen()).toEqual([]);
  });

  it("a change to an older message is a new row, so its bubble is drawn again", async () => {
    await engineSpeaks();
    const older = stored(10);
    const drawn = storage.loadSession(SESSION)!.messages.find(m => m.id === older.id)!;
    const list = engine.messages.get(LINK)!.map(m => m.id === older.id ? { ...m, reactions: { peer: { e: "❤️", n: 1, at: 5 } } } : m);
    engine.messages.set(LINK, list);
    for (const listener of engine.messageListeners) listener(LINK, list);
    const now = storage.loadSession(SESSION)!.messages.find(m => m.id === older.id)!;
    expect(now.reactions).toEqual({ peer: { e: "❤️", n: 1, at: 5 } });
    // The row the bubble was drawn from is as it was: comparing the two, the bubble sees the change.
    expect(drawn.reactions).toBeUndefined();
  });
});
