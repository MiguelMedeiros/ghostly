import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { createIdentity } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import type { EngineState, StoredLink } from "../src/shared/types";
// covers: chat.paired.send

const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
let node: GhostlyNode | undefined;
afterEach(async () => { await node?.shutdown(); node = undefined; vi.restoreAllMocks(); });

function chat(i: number): StoredLink {
  return { id: `chat-${i}`, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64,
    pairedPeerKey: createIdentity().pubKeyZ32 };
}

/**
 * The chat list waits for the groups (`groupsLoaded`) and draws everything at once. The groups were loaded only after
 * every chat's whole history was read: with 50 chats of 1000 messages the list stayed blank 1.3 s at every start
 * (2.8 s at 4x CPU). The groups need none of those histories: they load first, and the pages hear it.
 */
it("a start loads the groups and says so before it reads any chat's history", async () => {
  await db.putSettings({ online: false, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  for (let i = 0; i < 3; i++) {
    await db.putLink(chat(i));
    await db.putMessage({ linkId: `chat-${i}`, id: `m-${i}`, text: "hi", sender: "peer", timestamp: 1000 + i, via: "datalink" });
  }
  const states: EngineState[] = [];
  node = new GhostlyNode({ onState: s => states.push(s), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport: fixture as never, automaticWallets: false, nativeTransports: {} });
  const seen: { linkId: string; groupsLoaded: boolean; heard: boolean }[] = [];
  const read = db.getMessages.bind(db);
  vi.spyOn(db, "getMessages").mockImplementation(async (linkId, ...rest) => {
    if (linkId.startsWith("chat-")) {
      seen.push({ linkId, groupsLoaded: !!node!.getState().groupsLoaded, heard: states.some(s => s.groupsLoaded) });
      // A whole history takes a while to read: the pages hear the groups meanwhile.
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    return read(linkId, ...rest);
  });
  await node.start();
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every(s => s.groupsLoaded)).toBe(true);
  // The state that says so went out while the chats' histories were still being read.
  expect(seen.some(s => s.heard)).toBe(true);
  // Every chat is there once its history is read.
  expect(node.getState().links.map(l => l.id).sort()).toEqual(["chat-0", "chat-1", "chat-2"]);
}, 30000);
