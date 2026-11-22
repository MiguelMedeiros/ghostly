import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
// covers: settings.nickname, settings.network.relays

// A setting of the wrong kind (from `ghostly engine updateSettings` or the socket's `engine.call`) was written as it
// came: `mints` as a text left a profile whose every start and call failed on `this.settings.mints.filter`.
it("a setting of the wrong kind is refused before anything changes, and the profile goes on", async () => {
  await db.putSettings({ online: false, nick: "Ann", relays: [], iceServers: [], mints: ["https://mint.test"], mintsInitialized: true });
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false });
  try {
    await node.start();
    const before = await db.getSettings();
    const wrong: Record<string, unknown>[] = [
      { mints: "x" }, { mints: [1] }, { mintsInitialized: "yes" }, { online: "no" }, { nick: { a: 1 } }, { shareProfile: 1 },
      { publicProfiles: "off" }, { sendTyping: null }, { autoDownloads: 0 }, { serveFiles: "true" }, { relays: "https://relay.test" },
      { relays: [5] }, { irohRelays: "https://iroh.test" }, { iceServers: { urls: "turn:127.0.0.1" } }, { holdStorage: "s3" },
      { holdStorage: ["s3"] }, { nostr: "on" },
    ];
    for (const settings of wrong) {
      await expect(node.updateSettings({ settings: settings as never }), JSON.stringify(settings)).rejects.toThrow(Object.keys(settings)[0]!);
    }
    expect(await db.getSettings()).toEqual(before);
    expect(node.getState().settings.mints).toEqual(["https://mint.test"]);
    // What the apps send still goes through.
    await node.updateSettings({ settings: { nick: "Bea", sendTyping: false, holdStorage: null } });
    expect(node.getState().settings).toMatchObject({ nick: "Bea", sendTyping: false });
  } finally { await node.shutdown(); }
});
