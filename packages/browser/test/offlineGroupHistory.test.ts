import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommunitySession, GroupSession } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
// covers: groups.send, groups.community.send

const fixture = { publish: async () => {}, resolve: async () => null, describe: () => ({ protocol: "fixture", relays: [] }) };
let node: GhostlyNode | undefined;
afterEach(async () => { await node?.shutdown(); node = undefined; vi.restoreAllMocks(); });
beforeEach(async () => {
  const stores = [STORES.settings, STORES.links, STORES.groups, STORES.messages];
  await transact(stores, s => { for (const name of stores) s[name].clear(); });
  await db.putSettings({ online: false, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
});

/** A private group and a community, each with messages and, newest, a membership line that orders nothing. */
async function profile(): Promise<{ mesh: string; community: string }> {
  const mesh = GroupSession.create("Mesh", 1), community = CommunitySession.create("Community", 1);
  await db.putGroup({ id: mesh.id, createdAt: 1, state: mesh });
  await db.putGroup({ id: community.id, createdAt: 1, community });
  for (const [id, at] of [[mesh.id, 1000], [community.id, 2000]] as const) {
    for (let m = 0; m < 3; m++) await db.putMessage({ linkId: `group:${id}`, id: `m-${id}-${m}`, text: "hi", sender: m ? "peer" : "me", timestamp: at + m, via: "datalink" });
    await db.putMessage({ linkId: `group:${id}`, id: `e-${id}`, text: "Someone joined", sender: "peer", timestamp: at + 50, via: "datalink", event: true });
  }
  return { mesh: mesh.id, community: community.id };
}

function engine(offline: boolean, deferGroups = false): { node: GhostlyNode; read: string[] } {
  const read: string[] = [];
  const whole = db.getMessages.bind(db);
  vi.spyOn(db, "getMessages").mockImplementation(async (linkId, ...rest) => {
    if (linkId.startsWith("group:")) read.push(linkId);
    return whole(linkId, ...rest);
  });
  node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() },
    { transport: fixture as never, automaticWallets: false, nativeTransports: {}, singleDevice: true, offline, deferGroups });
  return { node, read };
}

/**
 * A one-shot that only reads the store (`status`, `chat history`) runs offline: no group starts, takes or sends
 * anything. Its start still read every group's whole history (+0.4 s and 80 MB per 50,000 group messages) for what
 * only a running group uses: the frames it hands on, my counter, its latest reaction. It reads each newest message now.
 */
it("an offline run reads each group's newest message at start, not its history", async () => {
  const { mesh, community } = await profile();
  const { node, read } = engine(true);
  await node.start();
  expect(read).toEqual([]);
  // The list of groups keeps its order: each group's newest message, not the membership line above it.
  expect(Object.fromEntries(node.getState().groups.map(g => [g.id, g.lastMessageAt]))).toEqual({ [mesh]: 1002, [community]: 2002 });
  // A command that reads a group's history reads it then.
  expect((await node.groupMessages({ groupId: mesh })).map(m => m.id)).toEqual([`m-${mesh}-0`, `m-${mesh}-1`, `m-${mesh}-2`, `e-${mesh}`]);
}, 30000);

/**
 * A one-shot about one 1:1 chat (`chat send`, `invite create`) leaves the groups' sessions unstarted (`deferGroups`):
 * no edge comes up, so no group message, edit or sync comes and nothing is handed on. It read every history whole too.
 */
it("a run that leaves the groups unstarted reads each group's newest message at start, not its history", async () => {
  const { mesh, community } = await profile();
  const { node, read } = engine(false, true);
  await node.start();
  expect(read).toEqual([]);
  expect(Object.fromEntries(node.getState().groups.map(g => [g.id, g.lastMessageAt]))).toEqual({ [mesh]: 1002, [community]: 2002 });
}, 30000);

it("a run that may start the groups reads each history whole at start, as before", async () => {
  const { mesh, community } = await profile();
  const { node, read } = engine(false);
  await node.start();
  expect(new Set(read)).toEqual(new Set([`group:${mesh}`, `group:${community}`]));
  expect(Object.fromEntries(node.getState().groups.map(g => [g.id, g.lastMessageAt]))).toEqual({ [mesh]: 1002, [community]: 2002 });
}, 30000);
