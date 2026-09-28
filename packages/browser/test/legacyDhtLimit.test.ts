import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { StoredLink } from "../src/shared/types";
// covers: chat.legacy.limits

/** A compatibility chat (no profile) as the engine holds it: `link` null while its link has not started yet. */
async function addLegacyChat(node: GhostlyNode, link: unknown) {
  const row: StoredLink = { id: `chat-${crypto.randomUUID().slice(0, 8)}`, createdAt: 1, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32 };
  await db.putLink(row);
  node["links"].set(row.id, { stored: row, myPubKeyZ32: "me", link: link as never, status: "online", dataLink: "idle",
    presence: { online: false, lastPacketAt: 0, services: null }, lastMessageAt: 0, peerAck: 0, lastSyncAt: 0,
    poll: { polling: false, nextAt: 0, interval: 0 }, files: { receivedBytes: 0, wireIds: new Set(), incoming: new Map() } });
  return row;
}

const nodes: GhostlyNode[] = [];
const engine = () => { const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { automaticWallets: false }); nodes.push(node); return node; };

beforeEach(async () => {
  await transact([STORES.links, STORES.messages], (s) => { s[STORES.links].clear(); s[STORES.messages].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); vi.restoreAllMocks(); });

describe("a compatibility chat's DHT limit", () => {
  it("refuses a text the DHT cannot carry even before the chat's link has started, and keeps nothing", async () => {
    const node = engine();
    const chat = await addLegacyChat(node, null);
    const long = `boo ${"x".repeat(600)}`;
    const sent = await node.sendMessage({ linkId: chat.id, text: long });
    expect(sent).toEqual({ error: expect.stringMatching(/too large for DHT \(604 bytes, max 500\)/), refused: true });
    expect(await db.getMessages(chat.id)).toEqual([]);
    // A text that fits waits for the link as before.
    expect(await node.sendMessage({ linkId: chat.id, text: "short enough" })).toEqual({ error: "You are offline" });
  });

  it("still refuses it once the link runs without a data link, and sends it over an open one", async () => {
    const node = engine();
    const sendMessage = vi.fn(async () => null);
    const link = { isDataLinkOpen: false, sendMessage, stop: vi.fn(async () => {}), depart: vi.fn(), wake: vi.fn(), setTyping: vi.fn() };
    const chat = await addLegacyChat(node, link);
    const long = `boo ${"x".repeat(600)}`;
    expect((await node.sendMessage({ linkId: chat.id, text: long })).refused).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
    link.isDataLinkOpen = true;
    expect((await node.sendMessage({ linkId: chat.id, text: long })).error).toBeNull();
    expect(sendMessage).toHaveBeenCalledOnce();
  });
});
