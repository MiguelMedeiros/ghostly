import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSession } from "../../../src/lib/types";
import type { LinkView, StoredMessage } from "../src/shared/types";
// covers: chats.created-marker, chat.paired.join-notice, chat.paired.delete-message, chat.paired.storage

/**
 * Keeping the UI's localStorage sessions and the peer's links in step. The page
 * globals are in-memory stand-ins and the peer connection is a recorder.
 */
const fake = vi.hoisted(() => ({
  engine: {
    state: null as { links: LinkView[] } | null,
    messages: new Map<string, StoredMessage[]>(),
    calls: [] as [string, unknown][],
    answers: {} as Record<string, unknown>,
    stateListeners: [] as (() => void)[],
    messageListeners: [] as ((linkId: string, messages: StoredMessage[]) => void)[],
    connect: async () => {},
    subscribe(listener: () => void) { fake.engine.stateListeners.push(listener); return () => {}; },
    onMessages(listener: (linkId: string, messages: StoredMessage[]) => void) { fake.engine.messageListeners.push(listener); return () => {}; },
    linkByPeer(peer: string) { return fake.engine.state?.links.find((l) => l.peerPubKeyZ32 === peer); },
    async call(method: string, params?: unknown) {
      fake.engine.calls.push([method, params]);
      const answer = fake.engine.answers[method];
      if (answer instanceof Error) throw answer;
      return answer;
    },
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

// Loaded once up front: each test re-evaluates these modules, and transforming them inside a hook can outlast its timeout.
await import("../src/platform/sync");
const engine = fake.engine;
const recordCall = engine.call;
let sync: typeof import("../src/platform/sync");
let storage: typeof import("../../../src/lib/storage");
let changes: number;

beforeEach(async () => {
  vi.useFakeTimers({ now: 1_000_000 });
  vi.resetModules();
  vi.stubGlobal("localStorage", new MemoryStorage());
  const page = new EventTarget();
  vi.stubGlobal("window", page);
  changes = 0;
  page.addEventListener("session-updated", () => changes++);
  Object.assign(engine, { state: null, messages: new Map(), calls: [], answers: {}, stateListeners: [], messageListeners: [], call: recordCall });
  sync = await import("../src/platform/sync");
  storage = await import("../../../src/lib/storage");
}, 60_000);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const link = (over: Partial<LinkView> = {}) => ({ id: "link-1", peerPubKeyZ32: "peer-1", myPubKeyZ32: "me-1", createdAt: 1_000_000, deliveryMode: "stream", ...over }) as LinkView;
const session = (over: Partial<ChatSession> = {}): ChatSession => ({ id: "s1", mySeedB64: "seed-1", peerPubKeyB64: "peer-1", encKeyB64: "enc-1", messages: [], createdAt: 1, deliveryMode: "stream", ...over });
const message = (over: Partial<StoredMessage>) => ({ linkId: "link-1", id: "m", text: "hi", sender: "peer", timestamp: 10, via: "datalink", ...over }) as StoredMessage;
const imported = () => localStorage.setItem("gb-sessions-imported", "1");
/** Starts syncing and lets the peer report `links`. */
async function start(links: LinkView[]) {
  sync.startSessionSync();
  engine.state = { links };
  for (const listener of engine.stateListeners) listener();
  await vi.advanceTimersByTimeAsync(0);
}

describe("the first run", () => {
  it("imports the peer's links as chats once, keeping labels and invite codes, skipping chats it already has", async () => {
    storage.saveSession(session({ id: "known", mySeedB64: "seed-k", peerPubKeyB64: "peer-k" }));
    engine.answers.exportLinks = [
      { seedB64: "seed-k", peerPubKeyZ32: "peer-k", encKeyB64: "enc", createdAt: 5 },
      { seedB64: "seed-n", peerPubKeyZ32: "peer-n", encKeyB64: "enc", createdAt: 7, label: "Alice", inviteCode: "code-1", deliveryMode: "dht" },
    ];
    await start([]);
    const sessions = storage.listSessions();
    expect(sessions).toHaveLength(2);
    const alice = sessions.find((s) => s.peerPubKeyB64 === "peer-n")!;
    expect(alice).toMatchObject({ label: "Alice", deliveryMode: "dht", createdAt: 7 });
    expect(storage.getInviteCode(alice.id)).toBe("code-1");
    expect(localStorage.getItem("gb-sessions-imported")).toBe("1");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine.calls.filter(([m]) => m === "exportLinks")).toHaveLength(1);
  });

  it("treats the old marker as already imported, so chats the user let go do not come back", async () => {
    localStorage.setItem("ghostly_browser_sessions_imported", "1");
    engine.answers.exportLinks = [{ seedB64: "seed", peerPubKeyZ32: "peer", encKeyB64: "enc", createdAt: 1 }];
    await start([]);
    expect(engine.calls.filter(([m]) => m === "exportLinks")).toEqual([]);
    expect(storage.listSessions()).toEqual([]);
    expect(localStorage.getItem("gb-sessions-imported")).toBe("1");
  });

  it("does nothing until the peer has reported its state", async () => {
    sync.startSessionSync();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine.calls).toEqual([]);
  });
});

describe("keeping links and chats in step", () => {
  it("asks the peer to run a chat it does not know yet, once while the request is in flight", async () => {
    imported();
    storage.saveSession(session({ profile: "paired-chat/1" }));
    let finish!: () => void;
    engine.call = vi.fn(async (method: string, params?: unknown) => {
      engine.calls.push([method, params]);
      if (method === "ensureLink") await new Promise<void>((resolve) => (finish = resolve));
    }) as typeof engine.call;
    await start([]);
    window.dispatchEvent(new Event("session-updated"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine.calls).toEqual([["ensureLink", { profile: "paired-chat/1", deliveryMode: "stream", seedB64: "seed-1", peerPubKeyZ32: "peer-1", encKeyB64: "enc-1" }]]);
    finish();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine.calls.filter(([m]) => m === "ensureLink")).toHaveLength(2);
  });

  it("asks again later when the peer refused to run a chat", async () => {
    imported();
    storage.saveSession(session());
    engine.answers.ensureLink = new Error("busy");
    await start([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine.calls.filter(([m]) => m === "ensureLink")).toHaveLength(2);
  });

  it("drops a link the user deleted, but not one made in the last moments", async () => {
    imported();
    await start([link({ id: "fresh", peerPubKeyZ32: "p-fresh", createdAt: 1_000_000 }), link({ id: "old", peerPubKeyZ32: "p-old", createdAt: 1 })]);
    expect(engine.calls).toEqual([["removeLink", { linkId: "old" }]]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(engine.calls).toContainEqual(["removeLink", { linkId: "fresh" }]);
  });

  it("keeps a link whose chat still exists, and takes its delivery mode", async () => {
    imported();
    storage.saveSession(session({ deliveryMode: "stream" }));
    await start([link({ createdAt: 1, deliveryMode: "dht" })]);
    expect(engine.calls).toEqual([]);
    expect(storage.loadSession("s1")?.deliveryMode).toBe("dht");
  });

  it("forgets a paired chat's invite code once the contact has joined", async () => {
    imported();
    storage.saveSession(session({ profile: "paired-chat/1" }));
    storage.saveSession(session({ id: "s2", mySeedB64: "seed-2", peerPubKeyB64: "peer-2", profile: "paired-chat/1" }));
    storage.saveInviteCode("s1", "invite-1");
    storage.saveInviteCode("s2", "invite-2");
    await start([
      link({ pairing: { status: "ready", peerKey: "k" } as never }),
      link({ id: "link-2", peerPubKeyZ32: "peer-2", pairing: { status: "waiting" } as never }),
    ]);
    expect(storage.getInviteCode("s1")).toBeNull();
    expect(storage.getInviteCode("s2")).toBe("invite-2");
  });

  it("starts only once however often it is asked", async () => {
    sync.startSessionSync();
    sync.startSessionSync();
    expect(engine.stateListeners).toHaveLength(1);
    expect(engine.messageListeners).toHaveLength(1);
  });
});

describe("mirroring what the peer stores into the chat", () => {
  async function mirror(messages: StoredMessage[], sessionOver: Partial<ChatSession> = {}, linkOver: Partial<LinkView> = {}) {
    imported();
    storage.saveSession(session(sessionOver));
    await start([link({ createdAt: 1, ...linkOver })]);
    changes = 0;
    engine.messageListeners[0]("link-1", messages);
    return storage.loadSession("s1")!;
  }

  it("adds what the contact sent and the payments the peer made, not my own undelivered drafts", async () => {
    const stored = await mirror([
      message({ id: "from-peer", timestamp: 3 }),
      message({ id: "mine-draft", sender: "me", timestamp: 1 }),
      message({ id: "mine-paid", sender: "me", paymentId: "p1", timestamp: 2 }),
    ]);
    expect(stored.messages.map((m) => m.id)).toEqual(["mine-paid", "from-peer"]);
    expect(changes).toBe(1);
  });

  it("updates a message's delivery status and never re-adds one the user deleted", async () => {
    const sent = { id: "mine", sender: "me" as const, text: "hi", timestamp: 1, delivery: "sending" as const };
    const stored = await mirror(
      [message({ id: "mine", sender: "me", delivery: "failed", deliveryError: "offline" }), message({ id: "gone" })],
      { messages: [sent], deletedIds: ["gone"] },
    );
    expect(stored.messages).toHaveLength(1);
    expect(stored.messages[0]).toMatchObject({ id: "mine", delivery: "failed", deliveryError: "offline" });
  });

  it("does not rewrite the chat when nothing changed", async () => {
    await mirror([message({ id: "a" })]);
    changes = 0;
    engine.messageListeners[0]("link-1", [message({ id: "a" })]);
    expect(changes).toBe(0);
  });

  it("attributes a join announcement to whoever made it, fixing an old attribution", async () => {
    const stored = await mirror([message({ id: "j", text: "👋 Casper joined" })], {
      messages: [{ id: "j", sender: "system", text: "👋 Casper joined", timestamp: 10, systemEvent: { type: "join", pubKey: "me-1" } }],
    });
    expect(stored.messages[0].systemEvent).toEqual({ type: "join", pubKey: "peer-1" });
  });

  it("ignores messages for a link without a chat or a chat without a link", async () => {
    await mirror([]);
    engine.messageListeners[0]("unknown-link", [message({ id: "x", linkId: "unknown-link" })]);
    storage.saveSession(session({ id: "s9", mySeedB64: "seed-9", peerPubKeyB64: "peer-9" }));
    expect(storage.loadSession("s1")!.messages).toEqual([]);
    expect(changes).toBe(0);
  });

  it("catches up on messages the peer already had when the state arrives", async () => {
    imported();
    storage.saveSession(session());
    engine.messages.set("link-1", [message({ id: "early" })]);
    await start([link({ createdAt: 1 })]);
    expect(storage.loadSession("s1")!.messages.map((m) => m.id)).toEqual(["early"]);
  });

  it("marks modern chats without the legacy transport details", async () => {
    const stored = await mirror([message({ id: "p" })], { profile: "paired-chat/1" }, { profile: "paired-chat/1" });
    expect(stored.messages[0].meta).toBeUndefined();
    const legacy = sync.toChatMessage(message({ id: "q", via: "dht" as never }), "peer-1", "me-1");
    expect(legacy.meta?.dnsRecords).toEqual(["_msgs", "_ts", "_ack"]);
  });
});
