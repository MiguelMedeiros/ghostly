import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import type { MessageChanges } from "../src/shared/messageChanges";
import type { LinkView, StoredMessage } from "../src/shared/types";
// covers: chat.paired.storage, storage.indexeddb

/**
 * What one change in a long chat or group costs, with a chat of 2000 messages and a group of 2000 in the engine's store
 * (fake-indexeddb) and a few short chats around them, median of 5: a message arriving, the contact's (or member's)
 * edit and reaction arriving. "Engine": the node's own code, from the change to what it tells the pages. "Page": that
 * reaching the page's copy of the history and the chat list's sync (`platform/sync.ts`), then the state change. Only
 * when asked: `npx vitest run test/longChatChanges.bench.test.ts --mode bench` in packages/browser.
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

/** The node's parts this reaches past its public calls, as a contact's or member's frames would. */
interface Internals {
  storeMessage(message: StoredMessage): Promise<void>;
  receiveEdit(linkId: string, edit: { id: string; e: number; ts: number; m: string }): Promise<boolean>;
  reactions: { receive(chat: string, by: string, reaction: { id: string; e: string; n: number }): Promise<string> };
  groupEdits: { receive(groupId: string, sender: string, edit: { id: string; e: number; ts: number; m: string }): Promise<string> };
  links: Map<string, unknown>;
  membership(groupId: string): unknown;
  emitState(): void;
}

const RUNS = 5;
const CHATS = { long: 2000, a: 50, b: 50, c: 50 } as const;
const T0 = 1_700_000_000_000;
const text = (i: number) => `message number ${i}, about as long as a chat line gets. `.repeat(2);
/** A row's id on the wire, as a paired chat's rows carry it (16 characters). */
const wire = (i: number) => `m${String(i).padStart(15, "0")}`;
const chatMessage = (linkId: string, i: number): StoredMessage => ({
  linkId, id: `${i % 2 ? "peer" : "me"}_${wire(i)}`, text: text(i), sender: i % 2 ? "peer" : "me", timestamp: T0 + i * 1000, via: "datalink", ...(i % 2 ? {} : { delivery: "delivered" as const }),
});
const groupMessage = (i: number): StoredMessage => ({ linkId: "group:g", id: `k1:m${i}`, member: "k1", text: text(i), sender: "peer", timestamp: T0 + i * 1000, via: "datalink" });
const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const link = (id: string) => ({ id, peerPubKeyZ32: `peer-${id}`, myPubKeyZ32: "me", createdAt: 1, deliveryMode: "stream", profile: "paired-chat/1" }) as unknown as LinkView;

describe.skipIf(!process.env.GHOSTLY_BENCH && import.meta.env.MODE !== "bench")("a change in a long chat or group", () => {
  it("costs the engine and the page", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("window", new EventTarget());
    vi.resetModules();
    localStorage.setItem("gb-sessions-imported", "1");
    const { db } = await import("../src/engine/db");
    const { GhostlyNode } = await import("../src/engine/node");
    const { applyMessageChanges } = await import("../src/shared/messageChanges");
    const sync = await import("../src/platform/sync");
    const storage = await import("../../../apps/ui/src/lib/storage");
    for (const [linkId, count] of Object.entries(CHATS)) for (let i = 0; i < count; i++) await db.putMessage(chatMessage(linkId, i));
    for (let i = 0; i < 2000; i++) await db.putMessage(groupMessage(i));
    for (const chat of Object.keys(CHATS)) {
      storage.saveSession({ id: chat, mySeedB64: `seed-${chat}`, peerPubKeyB64: `peer-${chat}`, encKeyB64: "enc", messages: [], createdAt: 1, deliveryMode: "stream", profile: "paired-chat/1" });
      fake.engine.messages.set(chat, await db.getMessages(chat));
    }
    fake.engine.messages.set("group:g", await db.getMessages("group:g"));
    fake.engine.state = { links: Object.keys(CHATS).map(link), groups: [] };
    sync.startSessionSync();
    for (const listener of fake.engine.stateListeners) listener();

    // What the node tells the pages, taken as the page's engine client takes it (platform/engine.ts).
    let told: { linkId: string; whole?: StoredMessage[]; changes?: MessageChanges } | null = null;
    const node = new GhostlyNode({
      onState: () => {}, onCallSignal: () => {},
      onMessages: (linkId, whole) => { told = { linkId, whole }; },
      onMessageChanges: (linkId, changes) => { told = { linkId, changes }; },
    }, { automaticWallets: false });
    const n = node as unknown as Internals;
    n.membership = () => ({ me: "me", members: new Set(["k1"]) });
    // Its own state goes nowhere here: the page's state change is timed with the page.
    n.emitState = () => {};
    const page = () => {
      const start = performance.now();
      const { linkId, whole, changes } = told!;
      const list = whole ?? applyMessageChanges(fake.engine.messages.get(linkId)!, changes!);
      fake.engine.messages.set(linkId, list);
      for (const listener of fake.engine.messageListeners) listener(linkId, list);
      fake.engine.state = { ...fake.engine.state!, links: fake.engine.state!.links.map((l) => ({ ...l })) };
      for (const listener of fake.engine.stateListeners) listener();
      told = null;
      return performance.now() - start;
    };
    const change = async (work: () => Promise<unknown>) => {
      const start = performance.now();
      await work();
      const engineMs = performance.now() - start;
      return [engineMs, page()];
    };

    const rows = ["one message arriving", "one edit arriving", "one reaction arriving"].map((what) => ({ what, ms: [[], [], [], []] as number[][] }));
    const record = (row: number, col: number, ms: number[]) => { rows[row]!.ms[col]!.push(ms[0]!); rows[row]!.ms[col + 1]!.push(ms[1]!); };
    for (let run = 0; run < RUNS; run++) {
      const i = 2001 + 2 * run, target = 2 * run + 1;
      record(0, 0, await change(() => n.storeMessage({ ...chatMessage("long", i), timestamp: Date.now() })));
      n.links.set("long", { stored: { id: "long", profile: "paired-chat/1" } });
      record(1, 0, await change(() => n.receiveEdit("long", { id: wire(target), e: 1, ts: T0 + target * 1000 + 1, m: `edited ${run}` })));
      n.links.delete("long");
      record(2, 0, await change(() => n.reactions.receive("long", "peer", { id: wire(2 * run), e: "👍", n: run + 1 })));

      record(0, 2, await change(() => n.storeMessage({ ...groupMessage(i), timestamp: Date.now() })));
      record(1, 2, await change(() => n.groupEdits.receive("g", "k1", { id: `k1:m${target}`, e: 1, ts: T0 + target * 1000 + 1, m: `edited ${run}` })));
      record(2, 2, await change(() => n.reactions.receive("group:g", "k1", { id: `k1:m${target}`, e: "👍", n: run + 1 })));
    }
    expect(fake.engine.messages.get("long")).toEqual(await db.getMessages("long"));
    expect(fake.engine.messages.get("group:g")).toEqual(await db.getMessages("group:g"));
    expect(storage.loadSession("long")!.messages.filter((m) => m.edit)).toHaveLength(RUNS);
    // The store alone rewriting one row (what an edit and a reaction must do), for scale: fake-indexeddb's own cost.
    const rewrite: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      const start = performance.now();
      await db.patchMessage("long", `peer_${wire(1)}`, (m) => ({ text: `${m.text}.` }));
      rewrite.push(performance.now() - start);
    }
    const fmt = (xs: number[]) => `${median(xs).toFixed(1).padStart(8)} ms`;
    const head = ["chat engine", "chat page", "group engine", "group page"].map((h) => h.padStart(11)).join(" ");
    console.log(`\n${"change".padEnd(28)} ${head}\n${rows.map(({ what, ms }) => `${what.padEnd(28)} ${ms.map(fmt).join(" ")}`).join("\n")}\n${"the store rewriting one row".padEnd(28)} ${fmt(rewrite)}`);
    // The store stays for what the node still finishes in the background.
    await node.shutdown();
  }, 600_000);
});
