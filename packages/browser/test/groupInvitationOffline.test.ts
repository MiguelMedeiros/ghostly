import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
// covers: groups.invite

/**
 * A contact's group invitation answered while this app is set offline, on a real engine over IndexedDB. Accept said
 * the inviter was not connected: going offline drops every chat's link, so the check on the inviter's chat failed for
 * a reason of this app's own. It says this app is offline, as a group's link does; Decline needs no network and goes.
 */

const nodes: GhostlyNode[] = [];
const engine = () => {
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false, singleDevice: true });
  nodes.push(node);
  return node;
};

beforeEach(async () => {
  const stores = [STORES.settings, STORES.links, STORES.groups];
  await transact(stores, s => { for (const name of stores) s[name].clear(); });
  await db.putSettings({ online: false, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  await db.putGroup({ id: "invited", createdAt: 1, invitation: { name: "Invited", admin: "a", linkId: "chat", e: 0, n: 2, pieces: [] } });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown().catch(() => {}); });

it("offline, Accept says this app is offline, not that the inviter is away, and keeps the invitation", async () => {
  const node = engine();
  await node.start();
  await expect(node.acceptGroupInvitation({ groupId: "invited" })).rejects.toThrow(/^Go online to join a group$/);
  expect((await db.getGroups()).find(g => g.id === "invited")?.invitation?.seedB64).toBeUndefined();
  expect(node.getState().groups.find(g => g.id === "invited")?.invitation).toMatchObject({ accepted: false });
});

it("offline, Decline still goes: it needs no network (the answer is owed to the inviter's chat)", async () => {
  const node = engine();
  await node.start();
  await node.declineGroupInvitation({ groupId: "invited" });
  expect(node.getState().groups.some(g => g.id === "invited")).toBe(false);
});
