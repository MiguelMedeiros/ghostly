import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, createLink } from "@ghostly/core";
import { EngineServer } from "../src/engine/server";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { EngineEvent, RpcResponse } from "../src/shared/rpc";
import type { StoredMessage } from "../src/shared/types";
// covers: app.attention.sounds

/**
 * A contact's message plays a sound and shows a notification when it is new, whatever the contact's clock says. Whether
 * a message is news (engine/attention.ts) was judged by the time its sender said against this device's clock and
 * against my own messages: a contact whose clock ran two minutes behind had every reply to something I had just
 * written taken for a late catch-up, and everything it wrote in the first two minutes after my app started taken for
 * history. Nothing rang and nothing was notified, in a chat that was live.
 */
const MINUTE = 60_000;
const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
const servers: EngineServer[] = [];
let now = 0;

async function started() {
  const server = new EngineServer({ automaticWallets: false, transport: fixture });
  servers.push(server);
  await server.ready;
  const heard: string[] = [];
  server.attach({ post(event: EngineEvent | RpcResponse) { if (event.kind === "attention" && event.event.type === "message") heard.push(event.event.id); } });
  const store = (message: StoredMessage) => (server.node as unknown as { storeMessage(m: StoredMessage): Promise<void> }).storeMessage(message);
  return { store, heard };
}

const CHAT = "chat-1";
/** A contact's message, dated by the contact's clock (`skew` from mine), written `ago` before it comes. */
const theirs = (text: string, skew: number, extra: Partial<StoredMessage> = {}, ago = 0): StoredMessage =>
  ({ linkId: CHAT, id: `peer_${text}`, text, sender: "peer", timestamp: now + skew - ago, via: "datalink", ...extra });
const mine = (text: string): StoredMessage => ({ linkId: CHAT, id: `me_${text}`, text, sender: "me", timestamp: now, via: "datalink" });
const note = (text: string) => `message:${CHAT}:peer_${text}`;
const tick = (ms = 10_000) => { now += ms; };

beforeEach(async () => {
  now = Date.UTC(2026, 9, 2, 12, 0);
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await transact([STORES.links, STORES.messages, STORES.groups], (s) => { for (const n of [STORES.links, STORES.messages, STORES.groups]) s[n].clear(); });
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.node.shutdown();
  vi.restoreAllMocks();
});

describe("a contact whose clock is behind", () => {
  it.each([["two minutes", -2 * MINUTE], ["nine minutes", -9 * MINUTE]])("%s: its reply to what I just wrote is a new message", async (_, skew) => {
    const { store, heard } = await started();
    tick(15 * MINUTE);
    await store(theirs("hello", skew));
    tick();
    await store(mine("how are you?"));
    tick();
    await store(theirs("fine", skew));
    tick();
    await store(mine("good"));
    tick();
    await store(theirs("and you?", skew));
    expect(heard).toEqual([note("hello"), note("fine"), note("and you?")]);
  });

  it("what it writes right after my app started is a new message", async () => {
    const { store, heard } = await started();
    tick(5_000);
    await store(theirs("are you there?", -2 * MINUTE));
    tick(5_000);
    await store(theirs("hello?", -2 * MINUTE));
    expect(heard).toEqual([note("are you there?"), note("hello?")]);
  });

  it("a late catch-up is still quiet: what it wrote minutes before its newest message here", async () => {
    const { store, heard } = await started();
    tick(15 * MINUTE);
    await store(theirs("live one", -2 * MINUTE));
    tick();
    await store(mine("answer"));
    tick();
    await store(theirs("live two", -2 * MINUTE));
    tick();
    // Written five minutes ago, and only here now (sent again once the session was back).
    await store(theirs("held up", -2 * MINUTE, {}, 5 * MINUTE));
    expect(heard).toEqual([note("live one"), note("live two")]);
  });
});

describe("what the contact's clock was does not stay", () => {
  it("a contact whose clock was ahead and is right again: its messages are new", async () => {
    const { store, heard } = await started();
    tick(15 * MINUTE);
    await store(theirs("from a clock ahead", 3 * MINUTE));
    tick();
    await store(mine("answer"));
    tick();
    await store(theirs("clock set right", 0));
    expect(heard).toEqual([note("from a clock ahead"), note("clock set right")]);
  });

  it("a contact whose clock was behind and is right again: its messages are new, and a catch-up is quiet", async () => {
    const { store, heard } = await started();
    tick(15 * MINUTE);
    await store(theirs("from a clock behind", -3 * MINUTE));
    tick();
    await store(theirs("clock set right", 0));
    tick();
    await store(mine("answer"));
    tick();
    await store(theirs("old news", 0, {}, 3 * MINUTE));
    expect(heard).toEqual([note("from a clock behind"), note("clock set right")]);
  });
});

describe("history stays quiet", () => {
  it("what a contact whose clock is behind wrote before my app started, sent again on the session, is not news", async () => {
    // The chat as it was stored: the contact's clock is two minutes behind, and its messages came as it wrote them.
    await db.putLink({ ...createLink().mine, id: CHAT, profile: "paired-chat/1", participationSeed: createIdentity().seedB64, createdAt: 1 });
    for (const [i, text] of ["one", "two", "three"].entries())
      await db.putMessage({ linkId: CHAT, id: `peer_${text}`, text, sender: "peer", timestamp: now - (10 - i) * MINUTE, sentAt: now - (12 - i) * MINUTE, via: "datalink" });
    tick(MINUTE);
    const { store, heard } = await started();
    tick(5_000);
    // Written while my app was closed, three minutes before it started.
    await store(theirs("while you were away", -2 * MINUTE, {}, 3 * MINUTE));
    tick(5_000);
    await store(theirs("now", -2 * MINUTE));
    expect(heard).toEqual([note("now")]);
  });

  it("with nothing to tell the contact's clock by, a message picked up from its storage is judged by the time it says", async () => {
    const { store, heard } = await started();
    tick(5_000);
    await store(theirs("held for me", 0, { via: "hold" }, 10 * MINUTE));
    expect(heard).toEqual([]);
  });
});
