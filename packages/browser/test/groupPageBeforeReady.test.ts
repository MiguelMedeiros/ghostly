import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { createIdentity } from "@ghostly/core";
import { EngineServer } from "../src/engine/server";
import { db } from "../src/engine/db";
import type { EngineEvent, RpcResponse } from "../src/shared/rpc";
import type { StoredLink, StoredMessage } from "../src/shared/types";
// covers: groups.send

/**
 * A group shown at start (the app reopened on it) asks for its newest page and its history while the engine still
 * starts. Both are reads of the store that need nothing the rest of the start sets up: they are answered once the
 * groups are loaded, not after every chat's whole history is read and every link started. Before, the group stayed an
 * empty page until the whole start ended (1.2 s at 1x CPU, 2.9 s at 4x, with 50 chats and 20 groups).
 */
const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
let server: EngineServer | undefined;
afterEach(async () => { await server?.ready.catch(() => {}); await server?.node.shutdown(); server = undefined; vi.restoreAllMocks(); });

function chat(i: number): StoredLink {
  return { id: `chat-${i}`, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64,
    pairedPeerKey: createIdentity().pubKeyZ32 };
}

it("answers a group's newest page and history before the chats' histories are read at start", async () => {
  await db.putSettings({ online: false, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  const CHATS = 10, READ_MS = 30;
  for (let i = 0; i < CHATS; i++) {
    await db.putLink(chat(i));
    await db.putMessage({ linkId: `chat-${i}`, id: `m-${i}`, text: "hi", sender: "peer", timestamp: 1000 + i, via: "datalink" });
  }
  for (let i = 0; i < 5; i++) await db.putMessage({ linkId: "group:g1", id: `g-${i}`, text: `line ${i}`, sender: "peer", timestamp: 2000 + i, via: "group" });
  // A chat's whole history takes a while to read (1,000 rows); the start reads each one.
  const read = db.getMessages.bind(db);
  let chatReads = 0;
  vi.spyOn(db, "getMessages").mockImplementation(async (linkId, ...rest) => {
    if (linkId.startsWith("chat-")) { await new Promise((resolve) => setTimeout(resolve, READ_MS)); chatReads++; }
    return read(linkId, ...rest);
  });
  server = new EngineServer({ transport: fixture as never, automaticWallets: false, nativeTransports: {} });
  const answers = new Map<number, { reads: number; result: unknown; error?: string }>();
  const client = { post: (event: EngineEvent | RpcResponse) => {
    if (event.kind === "response") answers.set(event.id, { reads: chatReads, result: event.result, error: event.error });
  } };
  server.attach(client);
  const asked = [
    server.handle(client, { kind: "request", id: 1, method: "messagePage", params: { linkId: "group:g1" } }),
    server.handle(client, { kind: "request", id: 2, method: "groupMessages", params: { groupId: "g1" } }),
  ];
  await Promise.all(asked);
  await server.ready;
  expect(chatReads).toBeGreaterThanOrEqual(CHATS);
  const page = answers.get(1)!, history = answers.get(2)!;
  expect((page.result as { messages: StoredMessage[] }).messages.map((m) => m.id)).toEqual(["g-0", "g-1", "g-2", "g-3", "g-4"]);
  expect((history.result as StoredMessage[]).map((m) => m.id)).toEqual(["g-0", "g-1", "g-2", "g-3", "g-4"]);
  expect(page.reads).toBeLessThan(CHATS);
  expect(history.reads).toBeLessThan(CHATS);
});
