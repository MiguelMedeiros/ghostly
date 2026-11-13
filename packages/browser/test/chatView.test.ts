import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { createIdentity } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import type { StoredLink } from "../src/shared/types";
// covers: chat.paired.send

const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
let node: GhostlyNode | undefined;
afterEach(async () => { await node?.shutdown(); node = undefined; vi.restoreAllMocks(); });

function chat(id: string, group?: string): StoredLink {
  return { id, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64,
    pairedPeerKey: createIdentity().pubKeyZ32, ...(group && { group }) };
}

/**
 * A host acting on one chat by its id (the CLI's socket, a bot answering an event) builds that chat's view alone: the
 * whole state is a view of every chat, 0.1-0.2 s at 10,000 of them, on the daemon's thread.
 */
it("gives one chat's view as the state has it, and none for a group's edge or an unknown id", async () => {
  await db.putSettings({ online: false, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putLink(chat("chat-a"));
  await db.putLink(chat("chat-b"));
  await db.putLink(chat("edge-c", "crew"));
  node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() },
    { transport: fixture as never, automaticWallets: false, nativeTransports: {}, deferChats: true });
  await node.start();
  const state = node.getState();
  expect(node.chatView("chat-b")).toEqual(state.links.find((l) => l.id === "chat-b"));
  expect(state.links.map((l) => l.id)).not.toContain("edge-c");
  expect(state.edges?.map((l) => l.id)).toContain("edge-c");
  expect(node.chatView("edge-c")).toBeUndefined();
  expect(node.chatView("chat-z")).toBeUndefined();
  expect(node.getSettings()).toBe(state.settings);
}, 30000);
