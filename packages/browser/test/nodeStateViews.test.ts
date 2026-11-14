import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdentity } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { EngineState, StoredLink } from "../src/shared/types";

async function addChat(node: GhostlyNode, label: string) {
  const row: StoredLink = { id: `chat-${crypto.randomUUID().slice(0, 8)}`, profile: "paired-chat/1", createdAt: Date.now(), label, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64 };
  await db.putLink(row);
  node["links"].set(row.id, { stored: row, myPubKeyZ32: "me", link: null as never, status: "online", dataLink: "closed",
    presence: { online: false, lastPacketAt: 0, services: null }, lastMessageAt: 0, peerAck: 0, lastSyncAt: 0,
    poll: { polling: false, nextAt: 0, interval: 0 }, files: { receivedBytes: 0, wireIds: new Set(), incoming: new Map() } });
  return row;
}

const nodes: GhostlyNode[] = [];
function engine() {
  const events = { onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() };
  const node = new GhostlyNode(events, { automaticWallets: false });
  nodes.push(node);
  /** The next state the engine pushes. */
  const next = async (): Promise<EngineState> => {
    const before = events.onState.mock.calls.length;
    await vi.waitFor(() => expect(events.onState.mock.calls.length).toBeGreaterThan(before));
    return events.onState.mock.calls.at(-1)![0] as EngineState;
  };
  return { node, next };
}
const view = (state: EngineState, id: string) => state.links.find(link => link.id === id)!;

beforeEach(async () => {
  await transact([STORES.settings, STORES.links], (s) => { s[STORES.settings].clear(); s[STORES.links].clear(); });
});
afterEach(async () => { for (const node of nodes.splice(0)) await node.shutdown(); });

describe("the state a change of one chat pushes", () => {
  it("builds that chat's view again and keeps the same object for every other chat", async () => {
    const { node, next } = engine();
    const a = await addChat(node, "Alice"), b = await addChat(node, "Bob");
    node["emitState"]();
    const first = await next();
    node.renameLink({ linkId: a.id, label: "Alicia" });
    const second = await next();
    expect(view(second, a.id).label).toBe("Alicia");
    expect(view(second, b.id)).toBe(view(first, b.id));
    expect(view(second, a.id)).not.toBe(view(first, a.id));
  });

  it("builds every chat's view again after a change that names no chat, and a chat made again", async () => {
    const { node, next } = engine();
    const a = await addChat(node, "Alice"), b = await addChat(node, "Bob");
    node["emitState"]();
    const first = await next();
    // Changed without a word (as a link's own field may be): a change that names no chat shows it.
    node["links"].get(b.id)!.peerAck = 7;
    node["emitState"]();
    const second = await next();
    expect(view(second, b.id).peerAck).toBe(7);
    expect(view(second, a.id)).not.toBe(view(first, a.id));
    // The same chat's live link made again: its view is built from it, whatever change named another chat.
    node["links"].set(b.id, { ...node["links"].get(b.id)!, peerAck: 9 });
    node.renameLink({ linkId: a.id, label: "Alicia" });
    expect(view(await next(), b.id).peerAck).toBe(9);
  });

  it("is read fresh by getState, whatever the last push kept", async () => {
    const { node, next } = engine();
    const a = await addChat(node, "Alice");
    node["emitState"]();
    await next();
    node["links"].get(a.id)!.peerAck = 3;
    expect(view(node.getState(), a.id).peerAck).toBe(3);
  });
});
