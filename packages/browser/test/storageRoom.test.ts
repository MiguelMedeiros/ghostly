import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatSession } from "../../../apps/ui/src/lib/types";
import type { LinkView, StoredMessage } from "../src/shared/types";
// covers: chat.paired.storage

/**
 * Many chats fill the page's storage: each keeps its last messages in localStorage (`STORED_MESSAGES`), and no bound on
 * how many chats. A chat whose session no longer fits was only kept in the page, so after a reload what came was back
 * only once the engine spoke. Now a write that hits the quota makes room: the other chats' stored copies keep fewer of
 * the messages the engine keeps (the oldest chats first), and the write is tried again.
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
    // No change tick here: every list comes whole.
    changing: () => false,
    linkByPeer(peer: string) { return fake.engine.state?.links.find((l) => l.peerPubKeyZ32 === peer); },
    async call() { return undefined; },
  },
}));
vi.mock("../src/platform/engine", () => ({ engine: fake.engine }));

/** localStorage with a quota, in characters, as a browser has one: a write past it throws and changes nothing. */
class QuotaStorage {
  readonly items = new Map<string, string>();
  constructor(public quota: number) {}
  get used() { let n = 0; for (const [k, v] of this.items) n += k.length + v.length; return n; }
  get length() { return this.items.size; }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) {
    const next = this.used - (this.items.get(key)?.length ?? -key.length) + String(value).length;
    if (next > this.quota) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    this.items.set(key, String(value));
  }
  removeItem(key: string) { this.items.delete(key); }
  clear() { this.items.clear(); }
}

const CHATS = 6, HISTORY = 300;
const at = (i: number) => 1_700_000_000_000 + i * 60_000;
const linkOf = (c: number) => ({ id: `link-${c}`, peerPubKeyZ32: `peer-${c}`, myPubKeyZ32: "me-1", createdAt: 1, deliveryMode: "stream", profile: "paired-chat/1" }) as unknown as LinkView;
const text = (c: number, i: number): StoredMessage => ({ linkId: `link-${c}`, id: `peer_c${c}_${i}`, text: `Chat ${c}, text ${i}: the nightly run finished, every check green 👻`, sender: "peer", timestamp: at(i) + c, via: "datalink" });
/** Longer than the room left: it fits only once room is made. */
const long = (c: number, i: number): StoredMessage => ({ ...text(c, i), text: `A long one: ${"lorem ipsum ".repeat(200)}` });
const historyOf = (c: number) => Array.from({ length: HISTORY }, (_, i) => text(c, i));
const sessionOf = (c: number): ChatSession => ({ id: `s${c}`, profile: "paired-chat/1", mySeedB64: `seed-${c}`, peerPubKeyB64: `peer-${c}`, encKeyB64: "enc", messages: [], createdAt: c, deliveryMode: "stream" });
/** A call's line: only this page keeps it, so no room is ever made by dropping it. */
const callLine: ChatMessage = { id: "call_1", text: "📞 Call ended", sender: "system", timestamp: at(3) + 1, callEvent: { type: "ended", duration: 60 } } as ChatMessage;

const engine = fake.engine;
let space: QuotaStorage;
let sync: typeof import("../src/platform/sync");
let storage: typeof import("../../../apps/ui/src/lib/storage");

async function page() {
  vi.resetModules();
  engine.stateListeners = [];
  engine.messageListeners = [];
  sync = await import("../src/platform/sync");
  storage = await import("../../../apps/ui/src/lib/storage");
}
async function engineSpeaks() {
  sync.startSessionSync();
  engine.state = { links: Array.from({ length: CHATS }, (_, c) => linkOf(c)) };
  for (const listener of engine.stateListeners) listener();
  for (const [id, messages] of engine.messages) for (const listener of engine.messageListeners) listener(id, messages);
  await vi.advanceTimersByTimeAsync(100);
}
function comes(c: number, list: StoredMessage[]) {
  engine.messages.set(`link-${c}`, list);
  for (const listener of engine.messageListeners) listener(`link-${c}`, list);
}
const kept = (c: number) => JSON.parse(space.getItem(`ghostly_s${c}`)!) as ChatSession;

beforeEach(async () => {
  vi.useFakeTimers({ now: at(HISTORY + 10) });
  engine.messages = new Map(Array.from({ length: CHATS }, (_, c) => [`link-${c}`, historyOf(c)]));
  space = new QuotaStorage(Infinity);
  space.items.set("gb-sessions-imported", "1");
  vi.stubGlobal("localStorage", space);
  vi.stubGlobal("window", new EventTarget());
  await page();
  for (let c = 0; c < CHATS; c++) storage.saveSession({ ...sessionOf(c), messages: c === 0 ? [callLine] : [] });
  await engineSpeaks();
  // Every chat stored with its last messages, and the storage full.
  expect(kept(1).messages).toHaveLength(storage.STORED_MESSAGES);
  space.quota = space.used + 50;
}, 60_000);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("the page's storage full of this profile's chats", () => {
  it("makes room in the other chats' stored copies, so what came is stored and there after a reload", async () => {
    const last = HISTORY + 5;
    comes(5, [...historyOf(5), long(5, last)]);
    expect(kept(5).messages.at(-1)!.id).toBe(`peer_c5_${last}`);
    // The chat least recently active (the first made, all else equal) gave its room; the chat that came keeps its last messages.
    expect(kept(0).messages.length).toBeLessThan(storage.STORED_MESSAGES);
    expect(kept(5).messages.length).toBe(storage.STORED_MESSAGES);
    // The call's line, which only the page keeps, stays.
    expect(kept(0).messages.some((m) => m.id === "call_1")).toBe(true);

    // A chat that gave room still reads whole.
    expect(storage.loadSession("s0")!.messages).toHaveLength(HISTORY + 1);

    // A reload, before the engine speaks: what came is there, counted as unread.
    await page();
    const listed = storage.listSessions().find((s) => s.id === "s5")!;
    expect(listed.messages.at(-1)!.id).toBe(`peer_c5_${last}`);
    expect(storage.getUnreadCount(listed)).toBeGreaterThan(0);
    await engineSpeaks();
    expect(storage.loadSession("s0")!.messages).toHaveLength(HISTORY + 1);
  });

  it("does not give the room back at the next write of a chat that gave it", async () => {
    comes(5, [...historyOf(5), long(5, HISTORY + 5)]);
    const small = kept(0).messages.length;
    comes(0, [...historyOf(0), long(0, HISTORY + 6)]);
    expect(kept(0).messages.at(-1)!.id).toBe(`peer_c0_${HISTORY + 6}`);
    expect(kept(0).messages.length).toBeLessThanOrEqual(small + 1);
    expect(kept(5).messages.at(-1)!.id).toBe(`peer_c5_${HISTORY + 5}`);
  });
});
