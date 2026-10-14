import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, fileStore, transact } from "../src/shared/idb";
import { fileBytes } from "../src/shared/fileBytes";
// covers: groups.files

/**
 * The files of a group this profile no longer has (WISP 503 · Group Files), on a real engine over IndexedDB: a
 * community left on a version whose Leave kept its files left their records (`linkId` `group:<id>`) and bytes behind,
 * where no stored group names them. The start drops them, and nothing else.
 */

const nodes: GhostlyNode[] = [];
const engine = (limited = false) => {
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, limited, automaticWallets: false, singleDevice: true });
  nodes.push(node);
  return node;
};

beforeEach(async () => {
  const stores = [STORES.settings, STORES.links, STORES.groups, STORES.files, STORES.fileState];
  await transact(stores, s => { for (const name of stores) s[name].clear(); });
  await db.putSettings({ online: false, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown().catch(() => {}); });

/** A file as an earlier run kept it: small ones whole in their record, the others in file storage. */
async function keep(id: string, linkId: string, where: "blob" | "storage"): Promise<void> {
  const bytes = new Uint8Array(2_000).fill(7), metadata = { name: "old.bin", size: bytes.length, mime: "application/octet-stream", timestamp: 1 };
  const transfer = { state: "done" as const, transferred: bytes.length, size: bytes.length };
  const group = linkId.startsWith("group:") ? { group: { message: `m-${id}`, author: "someone" } } : {};
  if (where === "blob") return fileStore.put({ id, linkId, blob: new Blob([bytes]), createdAt: 1, direction: "in", digest: "d", metadata, transfer, ...group });
  const storage = await fileBytes();
  await storage.remove(id);
  await storage.append(id, 0, bytes);
  await storage.close(id);
  await fileStore.put({ id, linkId, bytes: storage.kind, createdAt: 1, direction: "in", digest: "d", metadata, transfer, ...group });
}
const stored = async (id: string) => ({ record: !!(await fileStore.get(id)), bytes: await (await fileBytes()).size(id) });

async function profile() {
  // A group left, kept as a tombstone until its admin hears it; and an invitation not answered yet.
  await db.putGroup({ id: "left", createdAt: 1, left: { at: 1, admin: "a" } });
  await db.putGroup({ id: "invited", createdAt: 1, invitation: { name: "Invited", admin: "a", linkId: "chat", e: 0, n: 2, pieces: [] } });
  await keep("group-gone-in-a", "group:gone", "blob");
  await keep("group-gone-in-b", "group:gone", "storage");
  await keep("group-left-in-a", "group:left", "storage");
  await keep("group-invited-in-a", "group:invited", "blob");
  // A 1:1 chat's file, of a chat whose id starts as a group's link id does not.
  await keep("groupchat-in-a", "groupchat", "storage");
}

it("at start, a group's file records that no stored group names go with their bytes; every other file stays", async () => {
  await profile();
  expect(await stored("group-gone-in-b")).toEqual({ record: true, bytes: 2_000 });
  await engine().start();
  expect(await stored("group-gone-in-a")).toEqual({ record: false, bytes: null });
  expect(await stored("group-gone-in-b")).toEqual({ record: false, bytes: null });
  expect(await fileStore.listForLink("group:gone")).toEqual([]);
  expect(await stored("group-left-in-a")).toEqual({ record: true, bytes: 2_000 });
  expect((await stored("group-invited-in-a")).record).toBe(true);
  expect(await stored("groupchat-in-a")).toEqual({ record: true, bytes: 2_000 });
  expect(await fileStore.groupIds()).toEqual(["invited", "left"]);
});

it("in limited mode the copy stays as it is: nothing is dropped until a proper start", async () => {
  await profile();
  await engine(true).start();
  expect(await stored("group-gone-in-a")).toEqual({ record: true, bytes: null });
  expect(await stored("group-gone-in-b")).toEqual({ record: true, bytes: 2_000 });
  expect(await fileStore.groupIds()).toEqual(["gone", "invited", "left"]);
});
