import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { createIdentity, createLink } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { PROFILE_SETTINGS_KEYS, STORES, store, wrap } from "../src/shared/idb";
// covers: app.clear-data

/**
 * The peer's part of "Clear all data" (WISP 04): a running node stops and empties its database but for the wallets,
 * and what it still held in memory (its settings, its DID, its chats) is not written back afterwards.
 */
it("a running peer stops, then keeps only the wallets in its database", async () => {
  const invitation = createLink();
  await db.putSettings({ online: true, nick: "Alice", relays: [], iceServers: [], mints: ["https://mint.test"], mintsInitialized: true });
  await db.putLink({ ...invitation.mine, id: "l1", profile: "paired-chat/1", participationSeed: createIdentity().seedB64, createdAt: 1 });
  const transport = { publish: vi.fn(async () => {}), resolve: vi.fn(async () => null), describe: () => ({ protocol: "in-process", relays: [] }) };
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false });
  await node.start();
  expect(node.getState().did, "the DID was made").toBeDefined();
  expect(node.getState().links).toHaveLength(1);
  expect(await wrap((await store(STORES.settings, "readonly")).get("profileDid"))).toBeDefined();

  await node.clearProfileData();
  // Whatever the stopped peer still had queued has had its chance to write.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const settings = await store(STORES.settings, "readonly");
  const keys = await wrap(settings.getAllKeys());
  expect(keys.filter((key) => (PROFILE_SETTINGS_KEYS as readonly IDBValidKey[]).includes(key))).toEqual([]);
  // What is left is a wallet's (here the Lightning cards each network keeps).
  expect(keys.filter((key) => key !== "settings" && !String(key).startsWith("lightningCards-"))).toEqual([]);
  expect(await wrap(settings.get("settings"))).toEqual({ mints: ["https://mint.test"], mintsInitialized: true });
  expect(await wrap((await store(STORES.links, "readonly")).count())).toBe(0);
});
