import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { createLink, createRelayPayload, parseRelayPayload, type SignedPacket } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";

// covers: chat.paired.pair, chat.paired.join-notice

/**
 * A chat still being added is the same chat to a second ensureLink: the app may ask again (a sync, the
 * automatic "joined" message) while the first one is still saving it. The second waits for it and gets the
 * same id, with the chat started: never a second chat, never "You are offline" for that moment.
 */

const packets = new Map<string, SignedPacket>();
const transport = {
  publish: async (identity: Parameters<typeof createRelayPayload>[0], records: Parameters<typeof createRelayPayload>[1]) => {
    packets.set(identity.pubKeyZ32, parseRelayPayload(identity.pubKeyZ32, createRelayPayload(identity, records)));
  },
  resolve: async (key: string) => packets.get(key) ?? null,
  describe: () => ({ protocol: "signed packet fixture", relays: [] }),
};
const make = () => new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false, nativeTransports: {} });

afterEach(async () => { vi.restoreAllMocks(); packets.clear(); for (const link of await db.getLinks()) await db.deleteLink(link.id); });

it("a second ensureLink while the chat is still being added waits for it: the same id, started, and a send goes", async () => {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  const node = make();
  const invitation = createLink();
  const params = { ...invitation.invite, profile: "paired-chat/1" as const };
  try {
    await node.start();
    // The first one's save is slow (a busy IndexedDB): the second call and a send land in that window.
    let saved!: () => void;
    const putLink = db.putLink.bind(db);
    vi.spyOn(db, "putLink").mockImplementationOnce(async (link) => { await new Promise<void>((resolve) => (saved = resolve)); return putLink(link); });
    const first = node.ensureLink(params);
    const second = node.ensureLink(params).then(async ({ linkId }) => ({ linkId, sent: await node.sendMessage({ linkId, text: "👋 joined" }) }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    saved();
    const [{ linkId }, again] = await Promise.all([first, second]);
    expect(again.linkId).toBe(linkId);
    expect(again.sent.error).not.toBe("You are offline");
    expect(node.getState().links.filter((l) => l.id === linkId)).toHaveLength(1);
    expect((await db.getLinks()).map((l) => l.id)).toEqual([linkId]);
  } finally { await node.shutdown(); vi.unstubAllGlobals(); }
}, 20_000);

it("a creation that fails fails the call waiting on it too, and leaves no chat behind", async () => {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  const node = make();
  const invitation = createLink();
  const params = { ...invitation.invite, profile: "paired-chat/1" as const };
  try {
    await node.start();
    let failed!: () => void;
    vi.spyOn(db, "putLink").mockImplementationOnce(async () => { await new Promise<void>((resolve) => (failed = resolve)); throw new Error("disk full"); });
    const first = node.ensureLink(params);
    const second = node.ensureLink(params);
    await new Promise((resolve) => setTimeout(resolve, 50));
    failed();
    await expect(first).rejects.toThrow("disk full");
    await expect(second).rejects.toThrow("disk full");
    expect(node.getState().links).toHaveLength(0);
    // Asked again once it failed, the chat is made afresh.
    const { linkId } = await node.ensureLink(params);
    expect((await db.getLinks()).map((l) => l.id)).toEqual([linkId]);
  } finally { await node.shutdown(); vi.unstubAllGlobals(); }
}, 20_000);
