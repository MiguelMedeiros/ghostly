import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineServer } from "../src/engine/server";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { AttentionEvent, EngineEvent, RpcResponse } from "../src/shared/rpc";
import type { StoredMessage } from "../src/shared/types";
// covers: app.attention.sounds, groups.catch-up

/**
 * A member back in a group hears its catch-up once. A community's hub (and a private group's member asked for the
 * others) hands what the member missed oldest first: each message was newer than the newest stored before it, so the
 * engine's catch-up rule (engine/attention.ts) never applied, and 120 lines written over two hours rang and notified
 * one after another through the whole catch-up, every mention of me pinging on its own.
 */
const MINUTE = 60_000;
const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
const servers: EngineServer[] = [];
let now = 0;

async function started() {
  const server = new EngineServer({ automaticWallets: false, transport: fixture });
  servers.push(server);
  await server.ready;
  const heard: AttentionEvent[] = [];
  server.attach({ post(event: EngineEvent | RpcResponse) { if (event.kind === "attention" && event.event.type === "message") heard.push(event.event); } });
  const store = (message: StoredMessage) => (server.node as unknown as { storeMessage(m: StoredMessage): Promise<void> }).storeMessage(message);
  return { store, heard };
}

const GROUP = "group:g1";
/** A member's message, dated by that member's clock (`skew` from mine), written `ago` before it comes. */
const theirs = (text: string, ago = 0, extra: Partial<StoredMessage> = {}, skew = 0): StoredMessage =>
  ({ linkId: GROUP, id: text, text, sender: "peer", member: "ana", timestamp: now + skew - ago, via: "datalink", ...extra });
const ids = (heard: AttentionEvent[]) => heard.map(e => e.id.slice(`message:${GROUP}:`.length));
const tick = (ms: number) => { now += ms; };

beforeEach(async () => {
  now = Date.UTC(2026, 9, 14, 12, 0);
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await transact([STORES.links, STORES.messages, STORES.groups], (s) => { for (const n of [STORES.links, STORES.messages, STORES.groups]) s[n].clear(); });
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.node.shutdown();
  vi.restoreAllMocks();
});

describe("a member back in a group", () => {
  it.each([["50 ms", 50], ["1 s", 1_000]])("hears a catch-up handed oldest first once, %s a message: its mentions mark the rows, not one ping each", async (_, pause) => {
    const { store, heard } = await started();
    tick(3 * 60 * MINUTE);
    await store(theirs("last heard"));
    // Away for two hours, while the group wrote 120 lines, six of them naming me; back, the hub hands them oldest first.
    tick(120 * MINUTE);
    for (let i = 0; i < 120; i++) {
      await store(theirs(`missed ${i}`, (121 - i) * MINUTE, i % 20 === 5 ? { mentioned: true } : {}));
      tick(pause);
    }
    expect(ids(heard)).toEqual(["last heard", "missed 0"]);
    expect(heard.filter(e => e.mention)).toEqual([]);
    const mentioned = (await db.getMessages(GROUP)).filter(m => m.mentioned).length;
    expect(mentioned).toBe(6);
    // What comes live after it rings as always.
    tick(30_000);
    await store(theirs("live again", 0, { mentioned: true }));
    expect(ids(heard)).toEqual(["last heard", "missed 0", "live again"]);
    expect(heard.at(-1)!.mention).toBe(true);
  });

  it("the last minute of a catch-up is news", async () => {
    const { store, heard } = await started();
    tick(3 * 60 * MINUTE);
    await store(theirs("an hour ago", 60 * MINUTE));
    tick(100);
    await store(theirs("half an hour ago", 30 * MINUTE));
    tick(100);
    await store(theirs("just now", 20_000, { mentioned: true }));
    expect(ids(heard)).toEqual(["an hour ago", "just now"]);
    expect(heard.at(-1)!.mention).toBe(true);
  });
});

describe("a member whose clock is behind, talking live", () => {
  it("rings at each message: old by its clock, but never a moment after another old one", async () => {
    const { store, heard } = await started();
    tick(15 * MINUTE);
    for (const text of ["hello", "are you there?", "ping"]) {
      await store(theirs(text, 0, {}, -2 * MINUTE));
      tick(10_000);
    }
    expect(ids(heard)).toEqual(["hello", "are you there?", "ping"]);
  });
});
