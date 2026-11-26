import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../../../apps/ui/src/lib/types";
import type { LinkView, StoredMessage } from "../src/shared/types";
// covers: chat.paired.storage

/**
 * An attach (a page that starts on the web, an extension tab after its offscreen document started again) posts every
 * chat's history, one at a time. Chats with rows their stored session lacks are each written, but the page is told
 * once for all of them: each `session-updated` runs the sync's reconcile (a walk of every key of localStorage and a
 * compare of every chat) and every reader of it. One each, 2,000 chats took about 17 s.
 */
const fake = vi.hoisted(() => ({
  engine: {
    state: null as { links: LinkView[] } | null,
    messages: new Map<string, StoredMessage[]>(),
    deletedIds: new Map<string, readonly string[]>(),
    stateListeners: [] as (() => void)[],
    messageListeners: [] as ((linkId: string, messages: StoredMessage[]) => void)[],
    connect: async () => {},
    start() {},
    keepMarks() {},
    subscribe(listener: () => void) { fake.engine.stateListeners.push(listener); return () => {}; },
    onMessages(listener: (linkId: string, messages: StoredMessage[]) => void) { fake.engine.messageListeners.push(listener); return () => {}; },
    // No change tick: every list comes whole, as at an attach.
    changing: () => false,
    whole: () => true,
    askWhole() {},
    linkByPeer(peer: string) { return fake.engine.state?.links.find((l) => l.peerPubKeyZ32 === peer); },
    async call() { return undefined; },
  },
}));
vi.mock("../src/platform/engine", () => ({ engine: fake.engine }));

class MemoryStorage {
  private readonly items = new Map<string, string>();
  keys = 0;
  get length() { return this.items.size; }
  key(index: number) { this.keys++; return [...this.items.keys()][index] ?? null; }
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, String(value)); }
  removeItem(key: string) { this.items.delete(key); }
  clear() { this.items.clear(); }
}

const CHATS = 300;
const engine = fake.engine;
const row = (i: number, n: number): StoredMessage => ({ linkId: `link-${i}`, id: `peer_${i}_${n}`, text: `hi ${n}`, sender: "peer", timestamp: 1_000 + n, via: "datalink" });
const link = (i: number) => ({ id: `link-${i}`, peerPubKeyZ32: `peer-${i}`, myPubKeyZ32: "me", createdAt: 1, deliveryMode: "stream" }) as LinkView;
const session = (i: number): ChatSession => ({
  id: `s${i}`, mySeedB64: `seed-${i}`, peerPubKeyB64: `peer-${i}`, encKeyB64: "enc", createdAt: 1, deliveryMode: "stream",
  messages: [{ id: `peer_${i}_0`, text: "hi 0", sender: "peer", timestamp: 1_000 }],
});

let space: MemoryStorage;
let told: number;
let storage: typeof import("../../../apps/ui/src/lib/storage");

beforeEach(async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  vi.resetModules();
  space = new MemoryStorage();
  vi.stubGlobal("localStorage", space);
  const page = new EventTarget();
  vi.stubGlobal("window", page);
  told = 0;
  page.addEventListener("session-updated", () => told++);
  Object.assign(engine, { state: null, messages: new Map(), stateListeners: [], messageListeners: [] });
  storage = await import("../../../apps/ui/src/lib/storage");
  space.setItem("gb-sessions-imported", "1");
  for (let i = 0; i < CHATS; i++) storage.saveSession(session(i));
}, 60_000);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("an attach with a new row in each chat", () => {
  it("tells the page once for all of them, and walks the stored keys a few times, not once per chat", async () => {
    const sync = await import("../src/platform/sync");
    sync.startSessionSync();
    engine.state = { links: Array.from({ length: CHATS }, (_, i) => link(i)) };
    for (const listener of engine.stateListeners) listener();
    await vi.advanceTimersByTimeAsync(0);
    told = 0;
    space.keys = 0;
    // As the engine posts them: one chat's history at a time, each with a row its session lacks.
    for (let i = 0; i < CHATS; i++) {
      const messages = [row(i, 0), row(i, 1)];
      engine.messages.set(`link-${i}`, messages);
      for (const listener of engine.messageListeners) listener(`link-${i}`, messages);
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(told).toBe(1);
    // A walk of the stored keys reads every one of them: one per chat finds its session (`sessionForPeer`), and a few
    // reconciles, not one more per chat.
    expect(space.keys).toBeLessThanOrEqual((CHATS + 5) * space.length);
    for (let i = 0; i < CHATS; i++) expect(storage.loadSession(`s${i}`)!.messages.map((m) => m.id)).toEqual([`peer_${i}_0`, `peer_${i}_1`]);
  });
});
