import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { createLink, createRelayPayload, parseRelayPayload, type SignedPacket } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
// covers: chat.dht.delivery, chat.waiting

/*
 * agents#1776: while texts wait for a contact who is away, every read of the contact's DHT mailbox (every 4-30 s, for
 * up to the 7-day resend window) flushed the outbox, which read the chat's whole history and each waiting text again,
 * though nothing had changed: a daemon with 30 such contacts used 11.7% of a core instead of 0.9%.
 */
it("a read of the contact's DHT mailbox that changes nothing reads none of the chat's history", async () => {
  await db.putSettings({ online: true, nick: "", relays: [], iceServers: [], mints: [], mintsInitialized: true });
  vi.stubGlobal("RTCPeerConnection", undefined);
  const packets = new Map<string, SignedPacket>();
  const transport = { publish: async (identity: Parameters<typeof createRelayPayload>[0], records: Parameters<typeof createRelayPayload>[1]) => {
    packets.set(identity.pubKeyZ32, parseRelayPayload(identity.pubKeyZ32, createRelayPayload(identity, records)));
  }, resolve: async (key: string) => packets.get(key) ?? null, describe: () => ({ protocol: "signed packet fixture", relays: [] }) };
  const native = vi.fn();
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false, nativeTransports: { "iroh/1": native, "hyperdht/1": native } });
  const invitation = createLink(); let linkId = "";
  try {
    await node.start();
    ({ linkId } = await node.ensureLink({ ...invitation.mine, profile: "paired-chat/1", deliveryMode: "dht" }));
    const t = Date.now();
    // The contact is away (it never reads): one text awaits its receipt, two wait behind it.
    for (let i = 0; i < 3; i++) expect((await node.sendMessage({ linkId, text: `text ${i}`, timestamp: t + i })).error).toBeNull();
    expect((await db.getMessages(linkId)).map(m => m.delivery)).toEqual(["sent", "waiting", "waiting"]);
    const delivery = (node as unknown as { links: Map<string, { link?: { dht?: { refresh(): void } } }> }).links.get(linkId)!.link!.dht!;
    await new Promise(r => setTimeout(r, 300));
    const reads = vi.spyOn(db, "getMessages");
    for (let i = 0; i < 10; i++) { delivery.refresh(); await new Promise(r => setTimeout(r, 60)); }
    const whole = reads.mock.calls.filter(([chat]) => chat === linkId).length;
    console.log(`DHT TICKS: 10 mailbox reads, ${whole} whole-chat reads`);
    expect(whole).toBeLessThanOrEqual(1);
    reads.mockRestore();
    // Nothing went missing: the texts still wait, in order.
    expect((await db.getMessages(linkId)).map(m => m.delivery)).toEqual(["sent", "waiting", "waiting"]);
  } finally { await node.shutdown(); if (linkId) await db.deleteLink(linkId); vi.unstubAllGlobals(); }
}, 30_000);
