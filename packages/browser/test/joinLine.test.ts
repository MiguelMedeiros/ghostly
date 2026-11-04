import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, createLink } from "@ghostly/core";
import { EngineServer } from "../src/engine/server";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { EngineEvent, RpcResponse } from "../src/shared/rpc";
import type { StoredMessage } from "../src/shared/types";
// covers: chat.paired.join-notice

/**
 * A 1:1 chat's "👋 <name> joined" line is drawn as the app's own line (`StoredMessage.joinLine`) only for the contact's
 * first row of the chat; any later row of theirs in the same words is an ordinary message (agents#2727). The engine
 * decides it once, as the row is stored, so the decision never moves as history loads, rows go or the app restarts.
 */
const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
const servers: EngineServer[] = [];
const CHAT = "chat-1";
let now = 0;

async function started() {
  const server = new EngineServer({ automaticWallets: false, transport: fixture });
  servers.push(server);
  await server.ready;
  const heard: string[] = [];
  server.attach({ post(event: EngineEvent | RpcResponse) { if (event.kind === "attention" && event.event.type === "message") heard.push(event.event.id); } });
  const node = server.node as unknown as { storeMessage(m: StoredMessage): Promise<void>; deleteMessage(p: { linkId: string; messageId: string }): void };
  return { server, node, store: (m: StoredMessage) => node.storeMessage(m), heard };
}

const theirs = (id: string, text: string, extra: Partial<StoredMessage> = {}): StoredMessage =>
  ({ linkId: CHAT, id: `peer_${id}`, text, sender: "peer", timestamp: (now += 1_000), via: "datalink", ...extra });
const mine = (id: string, text: string): StoredMessage => ({ linkId: CHAT, id: `me_${id}`, text, sender: "me", timestamp: (now += 1_000), via: "datalink", delivery: "delivered" });
const joinLine = async (id: string) => (await db.getMessage(CHAT, id))?.joinLine;
const chat = () => db.putLink({ ...createLink().mine, id: CHAT, profile: "paired-chat/1", participationSeed: createIdentity().seedB64, createdAt: 1 });

beforeEach(async () => {
  now = Date.UTC(2026, 10, 3, 12, 0);
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await transact([STORES.links, STORES.messages, STORES.groups], (s) => { for (const n of [STORES.links, STORES.messages, STORES.groups]) s[n].clear(); });
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.node.shutdown();
  vi.restoreAllMocks();
});

describe("a 1:1 chat's joined line", () => {
  it("is the contact's first row only: a later row in the same words is a message, and it rings like one", async () => {
    await chat();
    const { store, heard } = await started();
    await store(theirs("j", "👋 Alice joined"));
    await store(theirs("again", "👋 Alice joined"));
    await store(theirs("hi", "hi"));
    await store(theirs("later", "👋 Bob joined"));
    expect(await joinLine("peer_j")).toBe(true);
    expect(await joinLine("peer_again")).toBeUndefined();
    expect(await joinLine("peer_later")).toBeUndefined();
    expect((await db.getLinks()).find((l) => l.id === CHAT)?.peerSpoke).toBe(true);
    // The joined line stays quiet; the rows in its words after it are messages, heard as messages.
    expect(heard).toEqual([`message:${CHAT}:peer_again`, `message:${CHAT}:peer_hi`, `message:${CHAT}:peer_later`]);
  });

  it("is the contact's line that came after a message they wrote before the chat went live", async () => {
    await chat();
    const { store, heard } = await started();
    // The side that joined says it once the chat first goes live (WISP 1100): what it wrote before can come first.
    await store(theirs("hi", "hello"));
    await store(theirs("j", "👋 joined"));
    await store(theirs("again", "👋 Alice joined"));
    expect(await joinLine("peer_j")).toBe(true);
    expect(await joinLine("peer_again")).toBeUndefined();
    expect(heard).toEqual([`message:${CHAT}:peer_hi`, `message:${CHAT}:peer_again`]);
  });

  it("of two rows in those words stored at once, only the first may be it", async () => {
    await chat();
    const { store } = await started();
    await Promise.all([store(theirs("hi", "hello")), store(theirs("j", "👋 Alice joined")), store(theirs("again", "👋 Alice joined"))]);
    expect(await joinLine("peer_j")).toBe(true);
    expect(await joinLine("peer_again")).toBeUndefined();
  });

  it("is the inviter's answer after my own joined line and messages, and after a contact request's note", async () => {
    await chat();
    const { store } = await started();
    await store(theirs("contact_k1", "Hi, it's Alice from the meetup"));
    await store(mine("j", "👋 Bob joined"));
    await store(mine("hi", "anyone here?"));
    // As 1.8.1 and the CLI send it: the contact's own text, nothing else marks it.
    await store(theirs("w1", "👋 Alice joined"));
    expect(await joinLine("peer_w1")).toBe(true);
    expect(await joinLine("me_j")).toBeUndefined();
  });

  it("does not move to a later row once the first one is deleted, nor after a restart", async () => {
    await chat();
    const first = await started();
    await first.store(theirs("j", "👋 Alice joined"));
    first.node.deleteMessage({ linkId: CHAT, messageId: "peer_j" });
    await vi.waitFor(async () => expect(await db.hasMessage(CHAT, "peer_j")).toBe(false));
    await first.store(theirs("again", "👋 Alice joined"));
    expect(await joinLine("peer_again")).toBeUndefined();

    await first.server.node.shutdown();
    const second = await started();
    await second.store(theirs("third", "👋 Alice joined"));
    expect(await joinLine("peer_again")).toBeUndefined();
    expect(await joinLine("peer_third")).toBeUndefined();
  });

  it("a chat stored before it was decided: its contact's oldest row is it as the engine starts, no later row is", async () => {
    await chat();
    // As an older build stored them: no `joinLine`, no `peerSpoke`.
    await db.putMessage(mine("own", "👋 Bob joined"));
    await db.putMessage(theirs("j", "👋 Alice joined"));
    await db.putMessage(theirs("hi", "hello"));
    await db.putMessage(theirs("again", "👋 Alice joined"));
    const { store } = await started();
    expect(await joinLine("peer_j")).toBe(true);
    expect(await joinLine("peer_again")).toBeUndefined();
    expect((await db.getLinks()).find((l) => l.id === CHAT)?.peerSpoke).toBe(true);
    await store(theirs("next", "👋 Alice joined"));
    expect(await joinLine("peer_next")).toBeUndefined();
  });

  it("a history brought in while the engine runs counts: a row of the contact's in those words there was first", async () => {
    await chat();
    const { store } = await started();
    await db.putMessage(theirs("old", "👋 Alice joined"));
    await store(theirs("j", "👋 Alice joined"));
    expect(await joinLine("peer_j")).toBeUndefined();
  });

  it("a chat stored before it was decided: the contact's oldest row in those words is it, after a message of theirs", async () => {
    await chat();
    await db.putMessage(theirs("hi", "hello"));
    await db.putMessage(theirs("j", "👋 Alice joined"));
    await db.putMessage(theirs("again", "👋 Alice joined"));
    await started();
    expect(await joinLine("peer_j")).toBe(true);
    expect(await joinLine("peer_again")).toBeUndefined();
  });
});
