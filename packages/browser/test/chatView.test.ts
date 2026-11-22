import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { createIdentity, type GroupSession } from "@ghostly/core";
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

/** The same for a group named by its id (a bot answering a group event): its view, with its members' edges, alone. */
it("gives one group's view as the state has it, with its members' edges, and none for an unknown id", async () => {
  await db.putSettings({ online: false, nick: "Admin", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putLink(chat("chat-a"));
  node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() },
    { transport: fixture as never, automaticWallets: false, nativeTransports: {} });
  await node.start();
  const inner = node as unknown as { links: Map<string, { stored: StoredLink }>; groups: { sessions: Map<string, GroupSession> } };
  const { groupId } = await node.createGroup({ name: "Ghosts", profile: "mesh" });
  const { groupId: otherId } = await node.createGroup({ name: "Others", profile: "mesh" });
  for (const [id, count] of [[groupId, 2], [otherId, 1]] as const) {
    for (let i = 0; i < count; i++) {
      const key = createIdentity().pubKeyZ32;
      await inner.groups.sessions.get(id)!.admit(key);
      await vi.waitFor(() => expect([...inner.links.values()].some(live => live.stored.group === id && live.stored.groupPeer === key)).toBe(true), { timeout: 10_000 });
    }
  }
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  const view = node.groupView(groupId);
  expect(view).toEqual(node.getState().groups.find((g) => g.id === groupId));
  expect(view?.members.filter((m) => !m.me).map((m) => !!m.edge)).toEqual([true, true]);
  expect(node.groupView(otherId)?.members.filter((m) => !m.me)).toHaveLength(1);
  expect(node.groupView("nope")).toBeUndefined();
  vi.useRealTimers();
}, 60000);
