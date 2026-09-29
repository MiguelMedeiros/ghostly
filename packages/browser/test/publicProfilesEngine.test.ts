import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
// covers: proofs.public-profile.setting, proofs.public-activity

describe("public profiles in the engine", () => {
  it("Load public profiles is on unless turned off, and nothing is asked for an identity without a verified proof", async () => {
    await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No network expected"));
    const sockets = vi.fn();
    vi.stubGlobal("WebSocket", class { constructor(url: string) { sockets(url); throw new Error("No relay expected"); } });
    const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false });
    try {
      await node.updateSettings({ settings: { online: false } });
      await node.start();
      expect(node.getState().settings.publicProfiles).toBeUndefined();
      await node.updateSettings({ settings: { online: true } });
      await node.loadPublicProfile({ provider: "nostr", subject: "a".repeat(64) });
      await node.loadPublicProfile({ provider: "pubky", subject: "y".repeat(52), force: true });
      // Posts and follows: the same gate. No verified proof, no answer, nobody asked.
      expect(await node.loadPublicPosts({ provider: "pubky", subject: "y".repeat(52) })).toBeNull();
      expect(await node.loadPublicGraph({ provider: "nostr", subject: "a".repeat(64) })).toBeNull();
      await expect(node.loadPublicPostImage({ provider: "pubky", subject: "y".repeat(52), postId: "X", index: 0 })).rejects.toThrow();
      expect(fetcher.mock.calls.filter(([url]) => /nexus\.pubky\.app|bsky/.test(String(url)))).toEqual([]);
      expect(sockets.mock.calls.filter(([url]) => /damus|nos\.lol/.test(String(url)))).toEqual([]);
      await node.updateSettings({ settings: { publicProfiles: false } });
      expect(node.getState().settings.publicProfiles).toBe(false);
      expect((await db.getSettings())?.publicProfiles).toBe(false);
      await node.updateSettings({ settings: { publicProfiles: true } });
      expect(node.getState().settings.publicProfiles).toBeUndefined();
    } finally { await node.updateSettings({ settings: { online: false } }).catch(() => {}); await node.shutdown(); fetcher.mockRestore(); vi.unstubAllGlobals(); }
  });
});
