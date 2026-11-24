import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../../../apps/ui/src/lib/types";
import type { LinkView, StoredMessage } from "../src/shared/types";
// covers: chats.created-marker

/**
 * The first-run import of the engine's links as chats (platform/sync.ts) never makes a second chat for a link that has
 * one. A restart whose page storage read without its chats (and without the import's mark) listed every chat twice
 * once the old rows were read again. The engine here keeps its links across a restart as its database does: what the
 * page told it (`noteChats`) is what `exportLinks` answers next time.
 */
const fake = vi.hoisted(() => {
  type Row = { id: string; seedB64: string; peerPubKeyZ32: string; encKeyB64: string; createdAt: number; hasChat?: true };
  const engine = {
    state: null as { links: LinkView[] } | null,
    messages: new Map<string, StoredMessage[]>(),
    /** The engine's own store of links, kept over a restart of the page. */
    rows: [] as Row[],
    calls: [] as [string, unknown][],
    /** While set, `exportLinks` answers once it resolves. */
    exportWait: undefined as Promise<void> | undefined,
    stateListeners: [] as (() => void)[],
    connect: async () => {},
    start() {},
    keepMarks() {},
    subscribe(listener: () => void) { engine.stateListeners.push(listener); return () => {}; },
    onMessages() { return () => {}; },
    changing: () => false,
    whole: () => true,
    askWhole() {},
    linkByPeer(peer: string) { return engine.state?.links.find((l) => l.peerPubKeyZ32 === peer); },
    async call(method: string, params?: unknown) {
      engine.calls.push([method, params]);
      if (method === "exportLinks") {
        await engine.exportWait;
        return engine.rows.map(({ id: _id, ...row }) => ({ ...row }));
      }
      if (method === "noteChats") {
        for (const id of (params as { linkIds: string[] }).linkIds) {
          const row = engine.rows.find((r) => r.id === id);
          if (row) row.hasChat = true;
        }
      }
      return undefined;
    },
  };
  return { engine };
});
vi.mock("../src/platform/engine", () => ({ engine: fake.engine }));

class MemoryStorage {
  readonly items = new Map<string, string>();
  get length() { return this.items.size; }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, String(value)); }
  removeItem(key: string) { this.items.delete(key); }
  clear() { this.items.clear(); }
}

// Loaded once up front: each page start evaluates these modules again, and transforming them inside a hook can outlast its timeout.
await import("../src/platform/sync");
const engine = fake.engine;
let sync: typeof import("../src/platform/sync");
let storage: typeof import("../../../apps/ui/src/lib/storage");

const N = 5;
const MARK = "gb-sessions-imported";
const views = (): LinkView[] => engine.rows.map((r) => ({ id: r.id, peerPubKeyZ32: r.peerPubKeyZ32, myPubKeyZ32: `me-${r.id}`, createdAt: r.createdAt, deliveryMode: "stream" }) as LinkView);
const session = (i: number, over: Partial<ChatSession> = {}): ChatSession => ({ id: `s${i}`, mySeedB64: `seed-${i}`, peerPubKeyB64: `peer-${i}`, encKeyB64: `enc-${i}`, messages: [], createdAt: 1, deliveryMode: "stream", ...over });
const rows = () => storage.listSessions().length;
const callsOf = (method: string) => engine.calls.filter(([m]) => m === method);

/** A page starting over `disk` (a restart: the page's modules start over, the engine's store stays). */
async function pageStart(disk: MemoryStorage) {
  vi.resetModules();
  vi.stubGlobal("localStorage", disk);
  vi.stubGlobal("window", new EventTarget());
  Object.assign(engine, { state: null, messages: new Map(), calls: [], stateListeners: [], exportWait: undefined });
  sync = await import("../src/platform/sync");
  storage = await import("../../../apps/ui/src/lib/storage");
}

/** Starts syncing and lets the engine report its links. */
async function start() {
  sync.startSessionSync();
  engine.state = { links: views() };
  for (const listener of engine.stateListeners) listener();
  await vi.advanceTimersByTimeAsync(0);
}

/** The chats a person made (each with its link in the engine), and the import's mark: storage as a running app leaves it. */
function madeChats(disk: MemoryStorage) {
  disk.setItem(MARK, "1");
  for (let i = 0; i < N; i++) disk.setItem(`ghostly_s${i}`, JSON.stringify(session(i)));
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
  engine.rows = Array.from({ length: N }, (_, i) => ({ id: `link-${i}`, seedB64: `seed-${i}`, peerPubKeyZ32: `peer-${i}`, encKeyB64: `enc-${i}`, createdAt: 1 }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("the first-run import of the engine's links", () => {
  it("a restart whose storage reads without the chats and the mark, the old ones read again later: one row per chat", async () => {
    const disk = new MemoryStorage();
    madeChats(disk);
    await pageStart(disk);
    await start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rows()).toBe(N);

    // The restart: this page's storage reads empty (another instance still held it).
    const empty = new MemoryStorage();
    await pageStart(empty);
    await start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(rows()).toBe(0);
    // No link goes for want of a chat it has, and nothing says the import was done.
    expect(callsOf("removeLink")).toEqual([]);
    expect(empty.getItem(MARK)).toBeNull();

    // The old rows are read again, next to whatever this page wrote.
    for (const [key, value] of disk.items) if (empty.getItem(key) === null) empty.setItem(key, value);
    window.dispatchEvent(new Event("session-updated"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rows()).toBe(N);
    expect(storage.listSessions().map((s) => s.id).sort()).toEqual(["s0", "s1", "s2", "s3", "s4"]);
    expect(callsOf("removeLink")).toEqual([]);
  });

  it("a first run (no mark, no chats) still makes one chat per link, once, and tells the engine they have one", async () => {
    const disk = new MemoryStorage();
    await pageStart(disk);
    await start();
    expect(rows()).toBe(N);
    expect(disk.getItem(MARK)).toBe("1");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(rows()).toBe(N);
    expect(callsOf("exportLinks")).toHaveLength(1);
    expect(engine.rows.every((r) => r.hasChat)).toBe(true);
    expect(callsOf("removeLink")).toEqual([]);
  });

  it("a second import over the same storage (its mark lost) makes no new row", async () => {
    const disk = new MemoryStorage();
    await pageStart(disk);
    await start();
    await vi.advanceTimersByTimeAsync(10_000);
    const first = storage.listSessions().map((s) => s.id).sort();

    disk.removeItem(MARK);
    await pageStart(disk);
    await start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(storage.listSessions().map((s) => s.id).sort()).toEqual(first);
    expect(disk.getItem(MARK)).toBe("1");
  });

  it("a chat stored while the engine answers (another page's) is found by a read after the answer: not made again", async () => {
    const disk = new MemoryStorage();
    await pageStart(disk);
    let answer!: () => void;
    engine.exportWait = new Promise<void>((resolve) => { answer = resolve; });
    await start();
    storage.saveSession(session(0, { id: "elsewhere" }));
    answer();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rows()).toBe(N);
    expect(storage.listSessions().filter((s) => s.peerPubKeyB64 === "peer-0").map((s) => s.id)).toEqual(["elsewhere"]);
  });

  it("asks the engine once while an import is under way, however many reconciles start meanwhile", async () => {
    const disk = new MemoryStorage();
    await pageStart(disk);
    let answer!: () => void;
    engine.exportWait = new Promise<void>((resolve) => { answer = resolve; });
    await start();
    for (let i = 0; i < 3; i++) {
      for (const listener of engine.stateListeners) listener();
      window.dispatchEvent(new Event("session-updated"));
    }
    await vi.advanceTimersByTimeAsync(5_000);
    answer();
    await vi.advanceTimersByTimeAsync(0);
    expect(callsOf("exportLinks")).toHaveLength(1);
    expect(rows()).toBe(N);
  });

  it("leaves chats already stored twice as they are: none deleted, none added", async () => {
    const disk = new MemoryStorage();
    madeChats(disk);
    disk.removeItem(MARK);
    disk.setItem("ghostly_copy0", JSON.stringify(session(0, { id: "copy0" })));
    await pageStart(disk);
    await start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(storage.listSessions().map((s) => s.id).sort()).toEqual(["copy0", "s0", "s1", "s2", "s3", "s4"]);
    expect(disk.getItem(MARK)).toBe("1");
    expect(callsOf("removeLink")).toEqual([]);
  });
});
