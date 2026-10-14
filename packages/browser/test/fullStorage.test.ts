import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ChatSession } from "../../../apps/ui/src/lib/types";
import type { LinkView, StoredMessage } from "../src/shared/types";
// covers: chat.paired.storage

/**
 * The page's storage full (another profile's chats on the same origin, or this one's many chats). The engine keeps what
 * came (IndexedDB) and the contact is told it was delivered; the page's mirror could not write the chat's session, read
 * it back without the new rows, and showed nothing: not in the list, not in the chat, not after a reload. My own sends
 * stayed on the clock. Now a session whose write fails is kept by the page and read from there.
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

const LINK = "link-1", PEER = "peer-1", SESSION = "s1", KEY = `ghostly_${SESSION}`;
const at = (i: number) => 1_700_000_000_000 + i * 60_000;
const joined: StoredMessage = { linkId: LINK, id: "peer_join", text: "👋 Ana joined", sender: "peer", timestamp: at(0), via: "datalink" };
const text = (i: number): StoredMessage => ({ linkId: LINK, id: `peer_t${i}`, text: `Text ${i} 👻`, sender: "peer", timestamp: at(i), via: "datalink" });
const link = { id: LINK, peerPubKeyZ32: PEER, myPubKeyZ32: "me-1", createdAt: 1, deliveryMode: "stream", profile: "paired-chat/1" } as unknown as LinkView;
const session: ChatSession = { id: SESSION, profile: "paired-chat/1", mySeedB64: "seed-1", peerPubKeyB64: PEER, encKeyB64: "enc-1", messages: [], createdAt: 1, deliveryMode: "stream" };

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
async function engineSpeaks() {
  sync.startSessionSync();
  engine.state = { links: [link] };
  for (const listener of engine.stateListeners) listener();
  await vi.advanceTimersByTimeAsync(0);
}
/** The engine stores these and tells the page. */
function comes(list: StoredMessage[]) {
  engine.messages.set(LINK, list);
  for (const listener of engine.messageListeners) listener(LINK, list);
}
const shown = () => storage.loadSession(SESSION)!.messages.map((m) => m.id);
const listed = () => storage.listSessions().find((s) => s.id === SESSION)!;

beforeEach(async () => {
  vi.useFakeTimers({ now: at(100) });
  engine.messages = new Map([[LINK, [joined]]]);
  space = new QuotaStorage(Infinity);
  space.items.set("gb-sessions-imported", "1");
  vi.stubGlobal("localStorage", space);
  vi.stubGlobal("window", new EventTarget());
  await page();
  // The chat as it was, its join line read.
  storage.saveSession(session);
  await engineSpeaks();
  storage.markSessionAsRead(SESSION);
  // Then another profile on the same origin fills what is left.
  for (let i = 0; space.used < 100_000; i++) space.items.set(`ghostly_qqqqqqqqqq_f${i}`, "x".repeat(5_000));
  space.quota = space.used;
}, 60_000);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("the page's storage full", () => {
  it("shows the contact's new texts in the list and the chat, counted as unread, and after a reload", async () => {
    comes([joined, text(1), text(2), text(3)]);
    expect(shown()).toEqual(["peer_join", "peer_t1", "peer_t2", "peer_t3"]);
    expect(storage.getUnreadCount(listed())).toBe(3);
    expect(listed().messages.at(-1)!.id).toBe("peer_t3");

    // Opened: read.
    storage.markSessionAsRead(SESSION);
    expect(storage.getUnreadCount(listed())).toBe(0);

    // A reload: the engine's copy brings them back, still unread as the stored count says.
    await page();
    await engineSpeaks();
    expect(shown()).toEqual(["peer_join", "peer_t1", "peer_t2", "peer_t3"]);
    expect(listed().messages.at(-1)!.id).toBe("peer_t3");
    expect(storage.getUnreadCount(listed())).toBe(0);
  });

  it("turns my send delivered when the contact confirms it", async () => {
    const mine: ChatMessage = { id: "me_r1", text: "reply while full", sender: "me", timestamp: at(5), delivery: "sending" };
    storage.addMessage(SESSION, mine);
    expect(storage.loadSession(SESSION)!.messages.find((m) => m.id === "me_r1")?.delivery).toBe("sending");
    comes([joined, { linkId: LINK, id: "me_r1", text: mine.text, sender: "me", timestamp: at(5), via: "datalink", delivery: "delivered" }]);
    expect(storage.loadSession(SESSION)!.messages.find((m) => m.id === "me_r1")?.delivery).toBe("delivered");
    expect(listed().messages.find((m) => m.id === "me_r1")?.delivery).toBe("delivered");
  });

  it("writes the session again once there is room, and the page reads that", async () => {
    comes([joined, text(1)]);
    space.quota = Infinity;
    comes([joined, text(1), text(2)]);
    expect((JSON.parse(space.getItem(KEY)!) as ChatSession).messages.map((m) => m.id)).toEqual(["peer_join", "peer_t1", "peer_t2"]);
    await page();
    expect(shown()).toEqual(["peer_join", "peer_t1", "peer_t2"]);
  });
});
