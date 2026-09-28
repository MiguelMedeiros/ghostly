import { describe, expect, it, vi } from "vitest";
import type { LinkView, StoredMessage } from "../src/shared/types";
// covers: chat.paired.storage

/**
 * What opening a long 1:1 chat costs the web app and Desktop on the peer's side, 2000 messages against 50, median of 5.
 * Opening a chat tells the peer (`setActiveLink`), the peer's state changes, and every state change mirrors every
 * chat's messages into its localStorage session (`platform/sync.ts`). Also the first mirror of a whole history into
 * an empty session (a restored or new device). Only when asked:
 * `npx vitest run test/longChatMirror.bench.test.ts --mode bench` in packages/browser.
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

class MemoryStorage {
  private readonly items = new Map<string, string>();
  get length() { return this.items.size; }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, String(value)); }
  removeItem(key: string) { this.items.delete(key); }
  clear() { this.items.clear(); }
}

const SIZES = { long: 2000, short: 50 } as const;
const message = (linkId: string, i: number): StoredMessage => ({
  linkId, id: `peer_${1_700_000_000_000 + i * 1000}`, text: `message number ${i}, about as long as a chat line gets. `.repeat(2),
  sender: "peer", timestamp: 1_700_000_000_000 + i * 1000, via: "datalink", delivery: "delivered",
});
const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const link = (id: string) => ({ id, peerPubKeyZ32: `peer-${id}`, myPubKeyZ32: "me", createdAt: 1, deliveryMode: "stream", profile: "paired-chat/1" }) as unknown as LinkView;

describe.skipIf(!process.env.GHOSTLY_BENCH && import.meta.env.MODE !== "bench")("opening a long 1:1 chat", () => {
  it("mirrors the peer's messages into the chat's session", async () => {
    const first: Record<string, number[]> = { long: [], short: [] }, opened: Record<string, number[]> = { long: [], short: [] };
    for (let run = 0; run < 5; run++) {
      for (const chat of Object.keys(SIZES) as (keyof typeof SIZES)[]) {
        vi.resetModules();
        vi.stubGlobal("localStorage", new MemoryStorage());
        vi.stubGlobal("window", new EventTarget());
        localStorage.setItem("gb-sessions-imported", "1");
        fake.engine.stateListeners = [];
        fake.engine.messageListeners = [];
        const sync = await import("../src/platform/sync");
        const storage = await import("../../../src/lib/storage");
        storage.saveSession({ id: chat, mySeedB64: `seed-${chat}`, peerPubKeyB64: `peer-${chat}`, encKeyB64: "enc", messages: [], createdAt: 1, deliveryMode: "stream", profile: "paired-chat/1" });
        fake.engine.messages = new Map([[chat, Array.from({ length: SIZES[chat] }, (_, i) => message(chat, i))]]);
        fake.engine.state = { links: [link(chat)] };
        sync.startSessionSync();
        // The history reaches an empty session.
        let start = performance.now();
        for (const listener of fake.engine.stateListeners) listener();
        first[chat]!.push(performance.now() - start);
        expect(storage.loadSession(chat)!.messages).toHaveLength(SIZES[chat]);
        // The chat opens: the state changes, and the session is read for the page.
        start = performance.now();
        for (const listener of fake.engine.stateListeners) listener();
        storage.loadSession(chat);
        opened[chat]!.push(performance.now() - start);
        vi.unstubAllGlobals();
      }
    }
    const row = (what: string, ms: Record<string, number[]>) => `${what.padEnd(40)} ${median(ms.long!).toFixed(1).padStart(8)} ms ${median(ms.short!).toFixed(1).padStart(8)} ms`;
    console.log(`\n${"session mirror".padEnd(40)} ${"2000".padStart(11)} ${"50".padStart(11)}\n${row("first mirror into an empty session", first)}\n${row("open the chat (state change + read)", opened)}`);
  }, 600_000);
});
