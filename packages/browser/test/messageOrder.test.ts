import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity, createLink, shownTime } from "@ghostly/core";
import { EngineServer } from "../src/engine/server";
import { db } from "../src/engine/db";
import { settleAhead } from "../src/engine/arrival";
import { cameAt } from "../src/engine/groups";
import { STORES, transact } from "../src/shared/idb";
import { applyMessageChanges } from "../src/shared/messageChanges";
import type { EngineEvent, RpcResponse } from "../src/shared/rpc";
import type { StoredMessage } from "../src/shared/types";
// covers: chat.order

/**
 * A history reads in the order things happened on this device (WISP 400, requirement 10): a received row takes its
 * place when it is stored, whatever its sender's clock says, and what I send next goes below it. The sender's time is
 * kept and shown, never later than the arrival. Rows that come late keep the order their transport hands them in and
 * land where they arrive. Reported with a contact's clock two minutes ahead: my replies sat above what they answered.
 */
const MINUTE = 60_000, DAY = 86_400_000;
const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
const servers: EngineServer[] = [];
let now = 0;

/** A page's copy of the histories, kept as platform/engine.ts keeps it. */
function page() {
  const messages = new Map<string, StoredMessage[]>();
  return {
    messages,
    post(event: EngineEvent | RpcResponse) {
      if (event.kind === "messages") messages.set(event.linkId, event.messages);
      else if (event.kind === "message-changes") messages.set(event.linkId, applyMessageChanges(messages.get(event.linkId) ?? [], event));
    },
  };
}

async function started() {
  const server = new EngineServer({ automaticWallets: false, transport: fixture });
  servers.push(server);
  await server.ready;
  const client = page();
  server.attach(client);
  const store = (message: StoredMessage) => (server.node as unknown as { storeMessage(m: StoredMessage): Promise<void> }).storeMessage(message);
  return { node: server.node, client, store };
}

const CHAT = "chat-1";
/** A contact's message, dated by the contact's clock (`skew` from mine). */
const theirs = (text: string, skew: number, extra: Partial<StoredMessage> = {}): StoredMessage =>
  ({ linkId: CHAT, id: `peer_${text}`, text, sender: "peer", timestamp: now + skew, via: "datalink", ...extra });
/** A message of mine, dated by my clock. */
const mine = (text: string, extra: Partial<StoredMessage> = {}): StoredMessage =>
  ({ linkId: CHAT, id: `me_${text}`, text, sender: "me", timestamp: now, via: "datalink", ...extra });
const texts = (list: readonly StoredMessage[] | undefined) => (list ?? []).map((m) => m.text);
const tick = (ms = 10_000) => { now += ms; };

beforeEach(async () => {
  now = Date.UTC(2026, 9, 1, 23, 21);
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await transact([STORES.links, STORES.messages, STORES.groups], (s) => { for (const n of [STORES.links, STORES.messages, STORES.groups]) s[n].clear(); });
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.node.shutdown();
  vi.restoreAllMocks();
});

describe("a live conversation with a contact whose clock is off", () => {
  it.each([
    ["two minutes ahead", 2 * MINUTE],
    ["two minutes behind", -2 * MINUTE],
    ["three days ahead", 3 * DAY],
    ["three days behind", -3 * DAY],
  ])("%s: every message is where it came, and my replies go below what they answer", async (_, skew) => {
    const { store, client } = await started();
    await store(mine("hi"));
    tick();
    await store(theirs("hello", skew));
    tick();
    await store(theirs("how are you?", skew));
    tick();
    await store(mine("fine, you?"));
    tick();
    await store(theirs("fine too", skew));
    const order = ["hi", "hello", "how are you?", "fine, you?", "fine too"];
    const history = await db.getMessages(CHAT);
    expect(texts(history)).toEqual(order);
    // The page's copy and a page of the history read the same order.
    expect(texts(client.messages.get(CHAT))).toEqual(order);
    expect(texts((await db.getMessagePage(CHAT, { limit: 3 })).messages)).toEqual(order.slice(-3));
    for (const row of history.filter((m) => m.sender === "peer")) {
      // What the contact's clock said is kept as it said it…
      expect(row.sentAt! - row.timestamp).toBe(skew);
      // …and shown, never later than when the message came.
      expect(shownTime(row)).toBe(skew > 0 ? row.timestamp : row.sentAt);
      expect(shownTime(row)).toBeLessThanOrEqual(now);
    }
  });

  it("a time that is no time is not kept: the message shows when it came", async () => {
    const { store } = await started();
    await store(mine("hi"));
    tick();
    for (const [i, ts] of [0, -5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER].entries()) {
      await store({ ...theirs(`odd ${i}`, 0), timestamp: ts });
      tick(1_000);
    }
    await store(mine("bye"));
    const history = await db.getMessages(CHAT);
    expect(texts(history)).toEqual(["hi", "odd 0", "odd 1", "odd 2", "odd 3", "odd 4", "bye"]);
    for (const row of history.filter((m) => m.sender === "peer")) {
      expect(row.sentAt).toBeUndefined();
      expect(row.timestamp).toBeLessThanOrEqual(now);
    }
  });

  it("a message that comes in the millisecond I sent one goes below it", async () => {
    const { store } = await started();
    await store(mine("ping"));
    await store(theirs("pong", -5 * MINUTE));
    expect(texts(await db.getMessages(CHAT))).toEqual(["ping", "pong"]);
  });
});

describe("messages that arrive late keep their order and land where they arrive", () => {
  it("a hold pickup: the batch stays together, in the contact's order, below what I wrote meanwhile", async () => {
    const { store } = await started();
    await store(theirs("before I left", 0));
    tick(DAY);
    await store(mine("written while they were away"));
    tick(MINUTE);
    // Picked up in one go (the same millisecond), written a day ago by a clock that is also behind.
    // (Ids in another order than they come in: rows of one time would sort by id.)
    const held = [3, 1, 2].map((id, i) => theirs(`held ${i + 1}`, -DAY - 2 * MINUTE + i * 1_000, { via: "hold", id: `peer_${id}` }));
    await Promise.all(held.map(store));
    tick();
    await store(mine("got them"));
    const history = await db.getMessages(CHAT);
    expect(texts(history)).toEqual(["before I left", "written while they were away", "held 1", "held 2", "held 3", "got them"]);
    // They show when they were written, a day ago.
    expect(history.filter((m) => m.via === "hold").map((m) => now - shownTime(m) > DAY - MINUTE)).toEqual([true, true, true]);
  });

  it("the DHT floor: a text read late from the mailbox goes below what was live meanwhile", async () => {
    const { store } = await started();
    await store(theirs("live", 2 * MINUTE));
    tick();
    await store(mine("answer"));
    tick(5 * MINUTE);
    await store(theirs("left on the DHT", -4 * MINUTE, { via: "pkarr" }));
    expect(texts(await db.getMessages(CHAT))).toEqual(["live", "answer", "left on the DHT"]);
  });

  it("a resend: the copy I have keeps its place and its times", async () => {
    const { store } = await started();
    const claim = now + 2 * MINUTE;
    await store(theirs("once", 2 * MINUTE));
    const [first] = await db.getMessages(CHAT);
    tick();
    await store(mine("seen"));
    tick(MINUTE);
    await store({ ...theirs("once", 0), timestamp: claim });
    const history = await db.getMessages(CHAT);
    expect(texts(history)).toEqual(["once", "seen"]);
    expect(history[0]).toEqual(first);
  });

  it.each(["mesh", "community"] as const)("a %s group's catch-up: members' messages keep the order they were handed on in, whatever each clock says", async (profile) => {
    const { node, store, client } = await started();
    const { groupId } = await node.createGroup({ name: "Plaza", profile });
    const link = `group:${groupId}`;
    const said = (member: string, text: string, skew: number): StoredMessage =>
      ({ linkId: link, id: `${member}:${text}`, text, sender: "peer", member, timestamp: now + skew, via: "datalink" });
    await store({ linkId: link, id: "me:0", text: "anyone here?", sender: "me", timestamp: now, via: "datalink" });
    tick();
    // Handed on together: Ana's clock is ahead, Bia's behind, Caio's days off.
    await Promise.all([said("ana", "a1", 3 * MINUTE), said("bia", "b1", -3 * MINUTE), said("ana", "a2", 3 * MINUTE + 1_000), said("caio", "c1", -2 * DAY), said("bia", "b2", -3 * MINUTE + 2_000)].map(store));
    tick();
    await store({ linkId: link, id: "me:1", text: "hello all", sender: "me", timestamp: now, via: "datalink" });
    const order = ["anyone here?", "a1", "b1", "a2", "c1", "b2", "hello all"];
    const said_ = (list: readonly StoredMessage[] | undefined) => texts((list ?? []).filter((m) => !m.event));
    expect(said_(await db.getMessages(link))).toEqual(order);
    expect(said_(client.messages.get(link))).toEqual(order);
  });

  it("the list of groups and unread follow when a message came, never a member's clock", () => {
    expect(cameAt(now + 3 * MINUTE, true, now)).toBe(now);
    expect(cameAt(now - 2 * DAY, true, now)).toBe(now);
    // A copy I had already moves nothing forward.
    expect(cameAt(now + 3 * MINUTE, false, now)).toBe(now);
    expect(cameAt(now - MINUTE, false, now)).toBe(now - MINUTE);
  });
});

describe("a history stored before places were kept", () => {
  it("stays as it was read, row for row, and what comes after goes below it", async () => {
    // As the app stored them until now: a contact's row under the time its clock said (here two minutes ahead).
    const old: StoredMessage[] = [
      { linkId: CHAT, id: "me_1", text: "question", sender: "me", timestamp: now - 10 * MINUTE, via: "datalink" },
      { linkId: CHAT, id: "peer_1", text: "answer", sender: "peer", timestamp: now - 9 * MINUTE + 2 * MINUTE, via: "datalink" },
      { linkId: CHAT, id: "me_2", text: "reply written after the answer", sender: "me", timestamp: now - 8 * MINUTE, via: "datalink" },
      { linkId: CHAT, id: "peer_2", text: "last", sender: "peer", timestamp: now - 7 * MINUTE + 2 * MINUTE, via: "datalink" },
    ];
    for (const row of old) await db.putMessage(row);
    const before = await db.getMessages(CHAT);
    const { store } = await started();
    // Nothing is rewritten when the app starts: the same rows, in the same order, showing the same times.
    expect(await db.getMessages(CHAT)).toEqual(before);
    expect(before.map(shownTime)).toEqual(before.map((m) => m.timestamp));
    tick();
    await store(theirs("new", 2 * MINUTE));
    tick();
    await store(mine("new reply"));
    const history = await db.getMessages(CHAT);
    expect(texts(history)).toEqual([...texts(before), "new", "new reply"]);
    expect(history.slice(0, before.length)).toEqual(before);
  });

  it("rows stored under a time that has not come yet take a place before now, once, in their order", async () => {
    // The contact's clock is two minutes ahead, and it wrote within the last two minutes: its rows are ahead of now.
    const old: StoredMessage[] = [
      { linkId: CHAT, id: "me_1", text: "question", sender: "me", timestamp: now - 3 * MINUTE, via: "datalink" },
      { linkId: CHAT, id: "peer_b", text: "answer", sender: "peer", timestamp: now - MINUTE + 2 * MINUTE, via: "datalink" },
      { linkId: CHAT, id: "me_2", text: "reply", sender: "me", timestamp: now - 30_000, via: "datalink" },
      { linkId: CHAT, id: "peer_a", text: "last", sender: "peer", timestamp: now - 20_000 + 2 * MINUTE, via: "datalink" },
    ];
    await db.putLink({ ...createLink().mine, id: CHAT, profile: "paired-chat/1", participationSeed: createIdentity().seedB64, createdAt: 1 });
    for (const row of old) await db.putMessage(row);
    const before = await db.getMessages(CHAT);
    expect(texts(before)).toEqual(["question", "reply", "answer", "last"]);
    const { store, client } = await started();
    const settled = await db.getMessages(CHAT);
    // The same order; the two rows ahead are before now, and still say what the contact's clock said.
    expect(texts(settled)).toEqual(texts(before));
    expect(settled.every((m) => m.timestamp <= now)).toBe(true);
    expect(settled.slice(2).map((m) => m.sentAt)).toEqual([before[2].timestamp, before[3].timestamp]);
    expect(settled.slice(0, 2)).toEqual(before.slice(0, 2));
    // What I write right after the update goes below them, and so does what comes.
    tick(1_000);
    await store(mine("written right after the update"));
    tick(1_000);
    await store(theirs("and this", 2 * MINUTE));
    const order = [...texts(before), "written right after the update", "and this"];
    expect(texts(await db.getMessages(CHAT))).toEqual(order);
    expect(texts(client.messages.get(CHAT)).slice(-2)).toEqual(order.slice(-2));
    // The next start changes nothing.
    expect(settleAhead(await db.getMessages(CHAT), now)).toEqual([]);
  });

  it("settling touches nothing but received rows that are ahead, and keeps every row after the ones before it", () => {
    const row = (id: string, sender: "me" | "peer", timestamp: number, extra: Partial<StoredMessage> = {}): StoredMessage => ({ linkId: CHAT, id, text: id, sender, timestamp, via: "datalink", ...extra });
    expect(settleAhead([], now)).toEqual([]);
    expect(settleAhead([row("a", "peer", now - 1), row("b", "me", now)], now)).toEqual([]);
    // Mine ahead (this device's clock went back) is left: both sides know it by its time.
    expect(settleAhead([row("mine", "me", now + MINUTE)], now)).toEqual([]);
    // A row placed here already (it has `sentAt`) is left too.
    expect(settleAhead([row("placed", "peer", now + 3, { sentAt: now + MINUTE })], now)).toEqual([]);
    // Right behind a row stored this very millisecond: still after it.
    const settled = settleAhead([row("just", "me", now), row("x", "peer", now + 1_000), row("y", "peer", now + 2_000)], now);
    expect(settled.map((m) => [m.id, m.timestamp, m.sentAt])).toEqual([["x", now + 1, now + 1_000], ["y", now + 2, now + 2_000]]);
  });
});
