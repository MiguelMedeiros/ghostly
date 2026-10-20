import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createIdentity, createLink, identityFromSeedB64 } from "@ghostly/core";
import { EngineServer } from "../src/engine/server";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
// covers: storage.indexeddb, chat.paired.offline-send, groups.protocol.reactions

/**
 * What a start reads of each chat's and group's history before the engine is ready. A whole history was read twice
 * per chat (the start, then the outbox's recovery) and twice per group (its load, then the chat list's latest
 * reaction): each of them is read once, and what the second read was for is still done.
 */
const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
const servers: EngineServer[] = [];

async function start() {
  const server = new EngineServer({ automaticWallets: false, transport: fixture });
  servers.push(server);
  await server.ready;
  return server.node;
}
async function stop() { for (const server of servers.splice(0)) await server.node.shutdown(); }

beforeEach(async () => {
  await db.putSettings({ online: false, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await transact([STORES.links, STORES.messages, STORES.groups], (s) => { for (const n of [STORES.links, STORES.messages, STORES.groups]) s[n].clear(); });
});
afterEach(async () => {
  await stop();
  vi.restoreAllMocks();
});

it("a start reads each chat's and each group's whole history once, and still queues what was not confirmed and shows the latest reaction", async () => {
  const chats = ["chat-a", "chat-b", "chat-c"];
  for (const id of chats) {
    await db.putLink({ ...createLink().mine, id, profile: "paired-chat/1", participationSeed: createIdentity().seedB64, createdAt: 1, pairedPeerKey: identityFromSeedB64(createIdentity().seedB64).pubKeyZ32 });
    for (let i = 0; i < 20; i++) await db.putMessage({ linkId: id, id: `peer_${i}`, text: `hello ${i}`, sender: "peer", timestamp: 1000 + i, via: "datalink" });
  }
  // Sent as the app closed, with no receipt; and a reaction of the contact's to it.
  await db.putMessage({ linkId: "chat-a", id: "me_1", wireId: "w1", text: "are you there?", sender: "me", timestamp: 2000, via: "datalink", delivery: "sent", reactions: { peer: { e: "👍", at: 2001, n: 1 } } });

  const first = await start();
  const groups: string[] = [];
  for (const profile of ["mesh", "community"] as const) {
    const { groupId } = await first.createGroup({ name: `Plaza ${profile}`, profile });
    groups.push(`group:${groupId}`);
    await db.putMessage({ linkId: `group:${groupId}`, id: "ana:1", text: "good morning", sender: "peer", member: "ana", timestamp: 3000, via: "datalink", reactions: { bia: { e: "🎉", at: 3001, n: 1 } } });
  }
  await stop();

  const whole = vi.spyOn(db, "getMessages");
  const node = await start();
  const reads = (linkId: string) => whole.mock.calls.filter(([read]) => read === linkId).length;
  expect(Object.fromEntries([...chats, ...groups].map((id) => [id, reads(id)]))).toEqual(Object.fromEntries([...chats, ...groups].map((id) => [id, 1])));
  whole.mockRestore();

  // What the second reads were for: the message sent with no receipt is queued again, and each chat and group shows
  // its latest reaction in the chat list.
  expect((await db.getMessage("chat-a", "me_1"))?.delivery).toBe("queued");
  const state = node.getState();
  expect(state.links.find((link) => link.id === "chat-a")?.lastReaction).toMatchObject({ emoji: "👍", by: "peer", message: "me_1" });
  expect(state.groups.map((group) => group.lastReaction)).toEqual([expect.objectContaining({ emoji: "🎉", by: "bia", message: "ana:1" }), expect.objectContaining({ emoji: "🎉", by: "bia", message: "ana:1" })]);
  expect(groups).toHaveLength(2);
}, 60_000);
