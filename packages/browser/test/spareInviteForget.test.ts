import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { DhtDelivery, createIdentity, createRelayPayload, decodeInviteCode, identityFromSeedB64, parseRelayPayload, type SignedPacket } from "@ghostly/core";
import { GhostlyNode, SPARE_INVITE_MIN_AGE_MS } from "../src/engine/node";
import { db } from "../src/engine/db";
// covers: chat.paired.pair-timing

/**
 * A spare invite replaced unused (15 min old, nobody took it) is forgotten by the transport (`PkarrTransport.forget`):
 * kept, an idle daemon's relay bookkeeping grew by its two keys every 15 minutes. One taken is a chat's: its keys are
 * never forgotten, and the contact who joins by it gets its texts.
 */
it("forgets the spares replaced unused, never the one a chat took, and that chat delivers to the contact who joined", async () => {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  const packets = new Map<string, SignedPacket>();
  const warmed: string[] = [], forgotten: string[][] = [];
  const transport = {
    publish: async (identity: Parameters<typeof createRelayPayload>[0], records: Parameters<typeof createRelayPayload>[1]) => {
      packets.set(identity.pubKeyZ32, parseRelayPayload(identity.pubKeyZ32, createRelayPayload(identity, records)));
    },
    publishPayload: async (key: string, payload: Uint8Array) => {
      warmed.push(key);
      const packet = parseRelayPayload(key, payload);
      if (!packets.has(key) || packets.get(key)!.timestampMicros < packet.timestampMicros) packets.set(key, packet);
    },
    resolve: async (key: string) => packets.get(key) ?? null,
    describe: () => ({ protocol: "signed packet fixture", relays: [] }),
    forget: (keys: Iterable<string>) => { forgotten.push([...keys]); },
  };
  const native = vi.fn();
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onAttention: vi.fn() }, { transport, automaticWallets: false, nativeTransports: { "iroh/1": native, "hyperdht/1": native } });
  const inner = node as unknown as { prepareSpare(after?: number, aged?: boolean): void; spare: { warmedAt?: number } | null };
  let linkId = "", contact: DhtDelivery | undefined;
  try {
    await node.start();
    // The spare warmed now (its timer, past the start's quiet time) and settled (`SPARE_INVITE_MIN_AGE_MS`).
    inner.prepareSpare();
    inner.spare!.warmedAt! -= SPARE_INVITE_MIN_AGE_MS;
    expect(warmed).toHaveLength(2);
    const made = await node.createLink();
    linkId = made.linkId;
    const invite = decodeInviteCode(made.inviteCode)!;
    const link = (await db.getLinks()).find((l) => l.id === linkId)!;
    const taken = [identityFromSeedB64(link.seedB64).pubKeyZ32, identityFromSeedB64(invite.seedB64).pubKeyZ32];
    expect([...taken].sort(), "the chat is the warmed spare's").toEqual([...warmed].sort());
    expect(forgotten).toEqual([]);
    // The next two spares grow old unused (their timers, at 15 min): each is replaced, and its two keys forgotten.
    const spareKeys = () => warmed.slice(-2);
    inner.prepareSpare();
    const second = spareKeys();
    inner.prepareSpare(0, true);
    const third = spareKeys();
    inner.prepareSpare(0, true);
    expect(forgotten.map((keys) => [...keys].sort())).toEqual([[...second].sort(), [...third].sort()]);
    expect(forgotten.flat().filter((key) => taken.includes(key)), "the taken spare's keys").toEqual([]);

    // The contact joins by the code, on DHT only by its own choice; this side is on Automatic. Its texts get there.
    const received = vi.fn();
    const { deliveryMode: _mode, ...params } = invite;
    contact = new DhtDelivery({ params, mode: "dht", credentials: { seedB64: createIdentity().seedB64 }, transport,
      save: async () => {}, pin: async () => {}, message: async (m) => { received(m); }, receipt: async () => {}, changed: () => {}, pollMs: 100 });
    node.setActiveLink({ linkId });
    await contact.start();
    await vi.waitFor(() => expect(node.getState().links.find((l) => l.id === linkId)?.textDelivery).toBe("dht"), { timeout: 20_000 });
    expect((await node.sendMessage({ linkId, text: "hello" })).error).toBeNull();
    await vi.waitFor(() => expect(received.mock.calls.map(([m]) => m.text)).toContain("hello"), { timeout: 30_000 });
    await vi.waitFor(async () => expect((await db.getMessages(linkId)).find((m) => m.sender === "me")?.delivery).toBe("delivered"), { timeout: 12_000 });
  } finally { await contact?.stop(); await node.shutdown(); if (linkId) await db.deleteLink(linkId); vi.unstubAllGlobals(); }
}, 70_000);
