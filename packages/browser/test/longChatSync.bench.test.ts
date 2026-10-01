import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import type { LinkView, StoredMessage } from "../src/shared/types";
// covers: chat.paired.storage

/**
 * What one change in a long chat costs the page that keeps the chat list (`platform/sync.ts`), with a chat of 2000
 * messages and a group of 2000 in the engine's store (fake-indexeddb) and a few short chats around them, median of 5:
 * one message arriving, one edit and one reaction (the engine stores it and tells the page, the page mirrors it and its
 * state change runs the chat list's reconcile), and a reconcile when nothing changed (every `session-updated` and
 * every 5 s). Only when asked: `npx vitest run test/longChatSync.bench.test.ts --mode bench` in packages/browser.
 */
const fake = vi.hoisted(() => ({
  engine: {
    state: null as { links: LinkView[]; groups: unknown[] } | null,
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

class MemoryStorage {
  private readonly items = new Map<string, string>();
  get length() { return this.items.size; }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, String(value)); }
  removeItem(key: string) { this.items.delete(key); }
  clear() { this.items.clear(); }
}

const RUNS = 5;
const CHATS = { long: 2000, a: 50, b: 50, c: 50 } as const;
const T0 = 1_700_000_000_000;
const message = (linkId: string, i: number): StoredMessage => ({
  linkId, id: `${i % 2 ? "peer" : "me"}_${T0 + i * 1000}`, text: `message number ${i}, about as long as a chat line gets. `.repeat(2),
  sender: i % 2 ? "peer" : "me", timestamp: T0 + i * 1000, via: "datalink", delivery: "delivered",
});
const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const link = (id: string) => ({ id, peerPubKeyZ32: `peer-${id}`, myPubKeyZ32: "me", createdAt: 1, deliveryMode: "stream", profile: "paired-chat/1", peerNick: `nick-${id}` }) as unknown as LinkView;

describe.skipIf(!process.env.GHOSTLY_BENCH && import.meta.env.MODE !== "bench")("a change in a long chat", () => {
  it("costs the page that keeps the chat list", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("window", new EventTarget());
    vi.resetModules();
    localStorage.setItem("gb-sessions-imported", "1");
    const { db } = await import("../src/engine/db");
    const sync = await import("../src/platform/sync");
    const storage = await import("../../../apps/ui/src/lib/storage");
    for (const [linkId, count] of [...Object.entries(CHATS), ["group:g", 2000]] as const) for (let i = 0; i < count; i++) await db.putMessage(message(linkId, i));
    for (const chat of Object.keys(CHATS)) {
      storage.saveSession({ id: chat, mySeedB64: `seed-${chat}`, peerPubKeyB64: `peer-${chat}`, encKeyB64: "enc", messages: [], createdAt: 1, deliveryMode: "stream", profile: "paired-chat/1" });
      fake.engine.messages.set(chat, await db.getMessages(chat));
    }
    fake.engine.messages.set("group:g", await db.getMessages("group:g"));
    fake.engine.state = { links: Object.keys(CHATS).map(link), groups: [] };
    sync.startSessionSync();
    for (const listener of fake.engine.stateListeners) listener();
    expect(storage.loadSession("long")!.messages).toHaveLength(2000);

    // What the engine does on a change today: store it, read the whole history, send it; then its state changes.
    // Engine: store it and read the whole history to send. Page: mirror what came, then the state change.
    const change = async (linkId: string, stored: StoredMessage) => {
      let start = performance.now();
      await db.putMessage(stored);
      const list = await db.getMessages(linkId);
      const engineMs = performance.now() - start;
      start = performance.now();
      fake.engine.messages.set(linkId, list);
      for (const listener of fake.engine.messageListeners) listener(linkId, list);
      fake.engine.state = { ...fake.engine.state!, links: fake.engine.state!.links.map((l) => ({ ...l })) };
      for (const listener of fake.engine.stateListeners) listener();
      return [engineMs, performance.now() - start];
    };
    const rows = ["one message arriving", "one edit", "one reaction"].map((what) => ({ what, ms: [[], [], [], []] as number[][] }));
    const record = (row: number, col: number, ms: number[]) => { rows[row]!.ms[col]!.push(ms[0]!); rows[row]!.ms[col + 1]!.push(ms[1]!); };
    const reconcile: number[] = [], stateOnly: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      for (const [col, linkId] of [[0, "long"], [2, "group:g"]] as const) {
        const n = 2000 + run;
        record(0, col, await change(linkId, { ...message(linkId, n), sender: "peer", id: `peer_${T0 + n * 1000}` }));
        const mine = message(linkId, 2 * run);
        const edited = { ...mine, text: `edited ${run}`, edit: { seq: run + 1, at: T0 + run, history: [] } };
        record(1, col, await change(linkId, edited));
        record(2, col, await change(linkId, { ...edited, reactions: { peer: { e: "👍", n: run + 1, at: T0 + run } } }));
      }
      let start = performance.now();
      window.dispatchEvent(new Event("session-updated"));
      reconcile.push(performance.now() - start);
      // A new state with nothing new in it (a contact's presence, a typing note): reconcile, and the mirror of every chat.
      fake.engine.state = { ...fake.engine.state!, links: fake.engine.state!.links.map((l) => ({ ...l })) };
      start = performance.now();
      for (const listener of fake.engine.stateListeners) listener();
      stateOnly.push(performance.now() - start);
    }
    expect(storage.loadSession("long")!.messages).toHaveLength(2000 + RUNS);
    const fmt = (xs: number[]) => `${median(xs).toFixed(2).padStart(8)} ms`;
    const head = ["chat engine", "chat page", "group engine", "group page"].map((h) => h.padStart(11)).join(" ");
    console.log([
      `\n${"change".padEnd(28)} ${head}`,
      ...rows.map(({ what, ms }) => `${what.padEnd(28)} ${ms.map(fmt).join(" ")}`),
      `${"session-updated, 5 s tick".padEnd(28)} ${"".padStart(11)} ${fmt(reconcile)}`,
      `${"state change, nothing new".padEnd(28)} ${"".padStart(11)} ${fmt(stateOnly)}`,
    ].join("\n"));
    vi.unstubAllGlobals();
  }, 600_000);
});
