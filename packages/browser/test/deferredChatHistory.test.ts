import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { createIdentity } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { fileStore } from "../src/shared/idb";
import type { StoredLink } from "../src/shared/types";
// covers: chat.paired.send, files.persistence

const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
let node: GhostlyNode | undefined;
afterEach(async () => { await node?.shutdown(); node = undefined; vi.restoreAllMocks(); });

function chat(i: number): StoredLink {
  return { id: `chat-${i}`, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64,
    pairedPeerKey: createIdentity().pubKeyZ32 };
}

/**
 * A one-shot about one chat (`deferChats`) leaves the other saved chats unstarted, but its start still read every chat's
 * whole history: +0.45 s and +80 MB per 50,000 messages in the profile, for a command that reads 5 rows of one chat.
 * Each chat now reads its newest row at start, and its history once the command names it.
 */
it("a run that leaves the saved chats unstarted reads their newest rows at start, and a chat's history once it is named", async () => {
  await db.putSettings({ online: false, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  for (let i = 0; i < 3; i++) {
    await db.putLink(chat(i));
    for (let m = 0; m < 3; m++) await db.putMessage({ linkId: `chat-${i}`, id: `m-${i}-${m}`, text: "hi", sender: "peer", timestamp: 1000 * (i + 1) + m, via: "datalink" });
  }
  // A file whose transfer the last run left half done: only the chat's restore says it was interrupted.
  const file = "chat-1-out-w1";
  await fileStore.put({ id: file, linkId: "chat-1", blob: new Blob(["hello"]), createdAt: 1, direction: "out", wireId: "w1",
    transfer: { state: "transferring", transferred: 2, size: 5 } });
  const read: string[] = [];
  const whole = db.getMessages.bind(db);
  vi.spyOn(db, "getMessages").mockImplementation(async (linkId, ...rest) => {
    if (linkId.startsWith("chat-")) read.push(linkId);
    return whole(linkId, ...rest);
  });
  node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() },
    { transport: fixture as never, automaticWallets: false, nativeTransports: {}, deferChats: true });
  await node.start();
  expect(read).toEqual([]);
  // The chat list's order is there all the same: each chat's newest message.
  expect(Object.fromEntries(node.getState().links.map(l => [l.id, l.lastMessageAt]))).toEqual({ "chat-0": 1002, "chat-1": 2002, "chat-2": 3002 });
  expect(node.getState().transfers[file]).toBeUndefined();

  await Promise.all([node.startDeferredChat("chat-1"), node.startDeferredChat("chat-1")]);
  expect(read).toEqual(["chat-1"]);
  expect(node.getState().transfers[file]).toMatchObject({ state: "failed", error: "Transfer interrupted. Retry when connected." });
  expect(node.getState().links.find(l => l.id === "chat-1")?.lastMessageAt).toBe(2002);
  // Started once, it is read no more.
  await node.startDeferredChat("chat-1");
  expect(read).toEqual(["chat-1"]);
}, 30000);

it("a run that starts the saved chats reads each history at start, as before", async () => {
  await db.putSettings({ online: false, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  for (let i = 0; i < 2; i++) {
    await db.putLink(chat(i));
    await db.putMessage({ linkId: `chat-${i}`, id: `m-${i}`, text: "hi", sender: "peer", timestamp: 1000 + i, via: "datalink" });
  }
  const read: string[] = [];
  const whole = db.getMessages.bind(db);
  vi.spyOn(db, "getMessages").mockImplementation(async (linkId, ...rest) => {
    if (linkId.startsWith("chat-")) read.push(linkId);
    return whole(linkId, ...rest);
  });
  node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() },
    { transport: fixture as never, automaticWallets: false, nativeTransports: {} });
  await node.start();
  expect(new Set(read)).toEqual(new Set((await db.getLinks()).map(l => l.id)));
}, 30000);
