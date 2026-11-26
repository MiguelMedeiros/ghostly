import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../../../apps/ui/src/lib/types";
import type { LinkView, StoredMessage } from "../src/shared/types";
// covers: chat.paired.storage

/**
 * A page's attach to the engine (the web app's start, the extension's pages after every new peer) brings each chat's
 * newest page, one after the other, and the mirror (`platform/sync.ts`) finds each one's chat by its contact's key. Each
 * of those finds walked every key of the page's storage: the attach cost the chats times every stored key (8M `key()`
 * reads at 2,000 chats). The chats' keys are read once for the attach, and a chat stored or removed meanwhile
 * is still where the mirror looks, as `sessionForPeer` finds it.
 */
const fake = vi.hoisted(() => ({
  engine: {
    state: null as { links: LinkView[]; groups: unknown[] } | null,
    messages: new Map<string, StoredMessage[]>(),
    deletedIds: new Map<string, readonly string[]>(),
    stateListeners: [] as (() => void)[],
    messageListeners: [] as ((linkId: string, messages: StoredMessage[]) => void)[],
    connect: async () => {},
    start() {},
    keepMarks() {},
    // No change tick here: every list comes whole.
    changing: () => false,
    whole: () => true,
    askWhole() {},
    subscribe(listener: () => void) { fake.engine.stateListeners.push(listener); return () => {}; },
    onMessages(listener: (linkId: string, messages: StoredMessage[]) => void) { fake.engine.messageListeners.push(listener); return () => {}; },
    linkByPeer(peer: string) {
      // By the contact's key, as the engine's own does (one map per list of links).
      const links = fake.engine.state?.links ?? [];
      let byPeer = fake.byPeer.get(links);
      if (!byPeer) {
        fake.byPeer.set(links, byPeer = new Map());
        for (const l of links) if (!byPeer.has(l.peerPubKeyZ32)) byPeer.set(l.peerPubKeyZ32, l);
      }
      return byPeer.get(peer);
    },
    async call() { return undefined; },
  },
  byPeer: new WeakMap<LinkView[], Map<string, LinkView>>(),
}));
vi.mock("../src/platform/engine", () => ({ engine: fake.engine }));

/** localStorage, its `key(i)` as cheap as a browser's and counted. */
class MemoryStorage {
  private readonly items = new Map<string, string>();
  private order: string[] | undefined;
  keyReads = 0;
  get length() { return this.items.size; }
  key(index: number) {
    this.keyReads++;
    return (this.order ??= [...this.items.keys()])[index] ?? null;
  }
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (!this.items.has(key)) this.order = undefined;
    this.items.set(key, String(value));
  }
  removeItem(key: string) { if (this.items.delete(key)) this.order = undefined; }
  clear() { this.items.clear(); this.order = undefined; }
}

// Loaded once up front: each test re-evaluates these modules, and transforming them inside a hook can outlast its timeout.
await import("../src/platform/sync");
let sync: typeof import("../src/platform/sync");
let storage: typeof import("../../../apps/ui/src/lib/storage");
let store: MemoryStorage;

beforeEach(async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  vi.resetModules();
  vi.stubGlobal("localStorage", store = new MemoryStorage());
  vi.stubGlobal("window", new EventTarget());
  Object.assign(fake.engine, { state: null, messages: new Map(), deletedIds: new Map(), stateListeners: [], messageListeners: [] });
  sync = await import("../src/platform/sync");
  storage = await import("../../../apps/ui/src/lib/storage");
  localStorage.setItem("gb-sessions-imported", "1");
}, 60_000);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const peer = (i: number) => `peer-${i}`;
const link = (i: number) => ({ id: `link-${i}`, peerPubKeyZ32: peer(i), myPubKeyZ32: "me", createdAt: 1, deliveryMode: "stream", profile: "paired-chat/1" }) as unknown as LinkView;
const row = (i: number, n: number) => ({ linkId: `link-${i}`, id: `peer_${n}`, text: `hello ${n}`, sender: "peer", timestamp: 1_000 + n, via: "datalink" }) as StoredMessage;
const chat = (i: number, over: Partial<ChatSession> = {}) => storage.saveSession({
  id: `s${i}`, mySeedB64: `seed-${i}`, peerPubKeyB64: peer(i), encKeyB64: "enc", messages: [], createdAt: 1, deliveryMode: "stream", profile: "paired-chat/1", ...over,
});

/** `count` chats, each with its link, two messages and a draft (a second key of its own), mirrored once at the start. */
function chats(count: number) {
  for (let i = 0; i < count; i++) {
    chat(i);
    localStorage.setItem(`${storage.getPrefix()}draft_s${i}`, "typed");
    fake.engine.messages.set(`link-${i}`, [row(i, 0), row(i, 1)]);
  }
  fake.engine.state = { links: Array.from({ length: count }, (_, i) => link(i)), groups: [] };
  sync.startSessionSync();
  for (const listener of fake.engine.stateListeners) listener();
}

/** The engine's attach for these chats: each one's newest page, one after the other, with `extra` new rows each. */
function attach(ids: number[], extra: number[] = []) {
  for (const i of ids) {
    const list = [row(i, 0), row(i, 1), ...extra.map((n) => row(i, n))];
    fake.engine.messages.set(`link-${i}`, list);
    for (const listener of fake.engine.messageListeners) listener(`link-${i}`, list);
  }
}
const all = (count: number) => Array.from({ length: count }, (_, i) => i);
const ids = (sessionId: string) => storage.loadSession(sessionId)!.messages.map((m) => m.id);

/** The page loads again over the same storage: nothing mirrored yet, and the engine's first state mirrors every chat. */
async function reload() {
  vi.resetModules();
  vi.stubGlobal("window", new EventTarget());
  Object.assign(fake.engine, { stateListeners: [], messageListeners: [] });
  sync = await import("../src/platform/sync");
  storage = await import("../../../apps/ui/src/lib/storage");
  sync.startSessionSync();
}

describe("a page's attach to the engine", () => {
  it.each([300, 2_000])("with %i chats and nothing new reads the stored keys a few times for all of them, not once per chat", async (CHATS) => {
    chats(CHATS);
    expect(ids(`s${CHATS - 1}`)).toEqual(["peer_0", "peer_1"]);
    // About two keys a chat: one walk of them is 2 x CHATS reads; one per chat was 2 x CHATS x CHATS.
    expect(localStorage.length).toBeGreaterThan(2 * CHATS);

    // The extension's pages, once the peer started again: every chat's newest page again, one after the other.
    store.keyReads = 0;
    attach(all(CHATS));
    expect(store.keyReads).toBeLessThan(CHATS * 20);

    // The web app's start: the engine's first state, with every chat's history.
    await reload();
    store.keyReads = 0;
    for (const listener of fake.engine.stateListeners) listener();
    expect(store.keyReads).toBeLessThan(CHATS * 20);
    expect(ids(`s${CHATS - 1}`)).toEqual(["peer_0", "peer_1"]);
    attach([0], [2]);
    expect(ids("s0")).toEqual(["peer_0", "peer_1", "peer_2"]);
  }, 120_000);

  it("finds a chat stored during it, for a contact who had none", () => {
    chats(5);
    attach([0, 1], [2]);
    chat(9);
    fake.engine.state = { ...fake.engine.state!, links: [...fake.engine.state!.links, link(9)] };
    attach([9], [2]);
    expect(ids("s9")).toEqual(["peer_0", "peer_1", "peer_2"]);
  });

  it("puts a contact's messages in the chat the list shows first, a second one stored during it included", () => {
    chats(5);
    attach([0, 1], [2]);
    // A newer chat with contact 2: the chat list shows it first, and it is the one its messages go to.
    chat(2, { id: "s2again", mySeedB64: "seed-2-again", lastSyncAt: 2_000_000 });
    expect(storage.sessionIdForPeer(peer(2))).toBe("s2again");
    attach([2], [3]);
    expect(ids("s2again")).toEqual(["peer_0", "peer_1", "peer_3"]);
    expect(ids("s2")).toEqual(["peer_0", "peer_1"]);
  });

  it("puts a contact's messages in their other chat once the one it found is deleted", () => {
    chats(5);
    chat(3, { id: "s3old", mySeedB64: "seed-3-old", lastSyncAt: 1 });
    chat(3, { lastSyncAt: 2_000_000 });
    attach([0, 3], [2]);
    expect(ids("s3")).toContain("peer_2");
    storage.deleteSession("s3");
    expect(storage.sessionIdForPeer(peer(3))).toBe("s3old");
    attach([3], [4]);
    expect(ids("s3old")).toContain("peer_4");
  });

  it("finds a chat another page stored during it", () => {
    chats(5);
    attach([0, 1], [2]);
    // The extension's second tab stored a newer chat with contact 1, without a word to this page yet.
    const other: ChatSession = { id: "s1tab", mySeedB64: "seed-1-tab", peerPubKeyB64: peer(1), encKeyB64: "enc", messages: [], createdAt: 1, lastSyncAt: 2_000_000, deliveryMode: "stream", profile: "paired-chat/1" };
    localStorage.setItem(`${storage.getPrefix()}s1tab`, JSON.stringify(other));
    attach([1], [3]);
    expect(ids("s1tab")).toEqual(["peer_0", "peer_1", "peer_3"]);
  });
});
