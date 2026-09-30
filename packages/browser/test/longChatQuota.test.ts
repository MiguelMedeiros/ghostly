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
