import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { createIdentity, createLink, createRelayPayload, DhtDelivery, parseRelayPayload, type SignedPacket } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";

it("persists a new DHT-only conversation, rejects invalid drafts before history, delivers and restores its pin without native allocation", async () => {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  const packets = new Map<string, SignedPacket>();
  const transport = { publish: async (identity: Parameters<typeof createRelayPayload>[0], records: Parameters<typeof createRelayPayload>[1]) => {
    packets.set(identity.pubKeyZ32, parseRelayPayload(identity.pubKeyZ32, createRelayPayload(identity, records)));
  }, resolve: async (key: string) => packets.get(key) ?? null, describe: () => ({ protocol: "signed packet fixture", relays: [] }) };
  const native = vi.fn();
  const attention = vi.fn();
  const make = () => new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: attention }, { transport, automaticWallets: false, nativeTransports: { "iroh/1": native, "hyperdht/1": native } });
  let node = make(); const invitation = createLink(); let linkId = "";
  const received = vi.fn();
  const receiver = new DhtDelivery({ params: invitation.invite, mode: "stream", credentials: { seedB64: createIdentity().seedB64 }, transport,
    save: async () => {}, pin: async () => {}, message: async m => { received(m); }, receipt: async () => {}, changed: () => {}, pollMs: 100 });
  try {
    await node.start();
    ({ linkId } = await node.ensureLink({ ...invitation.mine, profile: "paired-chat/1", deliveryMode: "dht" }));
    node.setActiveLink({ linkId });
    expect(node.getState().links.find(l => l.id === linkId)?.textDelivery).toBe("dht");
    expect((await node.sendMessage({ linkId, text: "🌙".repeat(65) })).error).toContain("256");
    expect((await node.sendMessage({ linkId, text: "cashuAabcdef" })).error).toContain("Payment tokens");
    expect(await db.getMessages(linkId)).toHaveLength(0);
    expect(attention).not.toHaveBeenCalled();
    expect((await node.sendMessage({ linkId, text: "durable DHT text" })).error).toBeNull();
    expect((await node.sendMessage({ linkId, text: "blocked second draft" })).error).toContain("One DHT text");
    expect(await db.getMessages(linkId)).toHaveLength(1);
    await receiver.start();
    await vi.waitFor(() => expect(received).toHaveBeenCalled(), { timeout: 8000 });
    await vi.waitFor(async () => expect((await db.getMessages(linkId))[0].delivery).toBe("delivered"), { timeout: 12000 });
    expect(attention).toHaveBeenCalledTimes(1);
    expect(attention.mock.calls[0][0].type).toBe("sent");
    const saved = (await db.getLinks()).find(l => l.id === linkId)!;
    expect(saved.pairedPeerKey).toBeTruthy();
    expect(saved.peerTrust?.verifiedKey).toBeUndefined();
    expect(saved.dhtDeliveryState?.pending).toBeUndefined();
    await node.shutdown(); node = make(); await node.start();
    const restored = node.getState().links.find(l => l.id === linkId)!;
    expect(restored.deliveryMode).toBe("dht");
    expect((await db.getLinks()).find(l => l.id === linkId)?.pairedPeerKey).toBe(saved.pairedPeerKey);
    expect((await db.getMessages(linkId))[0].delivery).toBe("delivered");
    expect(native).not.toHaveBeenCalled();
    expect(attention).toHaveBeenCalledTimes(1);
  } finally { await receiver.stop(); await node.shutdown(); if (linkId) await db.deleteLink(linkId); vi.unstubAllGlobals(); }
}, 25000);
