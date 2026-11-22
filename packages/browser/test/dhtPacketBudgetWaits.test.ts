import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createIdentity, DHT_PACKET_BUDGET } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { db } from "../src/engine/db";
import { STORES, transact } from "../src/shared/idb";
import type { StoredLink } from "../src/shared/types";

// covers: chat.dht.delivery

/**
 * A text within the DHT's 256 bytes that its packet cannot carry once sealed (about 249-256 bytes), while the chat is on
 * the DHT only because the contact is away: it was refused ("Too long for the DHT"), its words given back, while a text
 * a few bytes longer, past the 256, was kept and went by itself once live. As an edit that long does there, it waits
 * for the live session. In a chat on the DHT by choice, where no live session comes, it is still refused.
 */
function stubLink(peerMode?: "dht") {
  return {
    setChatActive: vi.fn(), isDataLinkOpen: false, textDelivery: "dht", canSendText: true, availableTransports: ["webrtc/1"],
    dhtDelivery: { peerMode }, validateText: vi.fn(() => DHT_PACKET_BUDGET), sendMessage: vi.fn(async () => DHT_PACKET_BUDGET),
    allowsPayment: vi.fn(() => true), paymentEnabled: vi.fn(() => true), setHoldSupport: vi.fn(), refreshServices: vi.fn(async () => {}),
    setNick: vi.fn(), setAvatar: vi.fn(), stop: vi.fn(async () => {}), depart: vi.fn(async () => {}), wake: vi.fn(), setTyping: vi.fn(),
    dhtWentNowhere: vi.fn(() => false),
  };
}

async function addChat(node: GhostlyNode, link: ReturnType<typeof stubLink>, stored: Partial<StoredLink> = {}) {
  const row: StoredLink = { id: `chat-${crypto.randomUUID().slice(0, 8)}`, profile: "paired-chat/1", createdAt: 1, seedB64: createIdentity().seedB64,
    encKeyB64: createIdentity().seedB64, peerPubKeyZ32: createIdentity().pubKeyZ32, participationSeed: createIdentity().seedB64, ...stored };
  await db.putLink(row);
  node["links"].set(row.id, { stored: row, myPubKeyZ32: "me", link: link as never, status: "online", dataLink: "closed",
    presence: { online: false, lastPacketAt: 0, services: null }, lastMessageAt: 0, peerAck: 0, lastSyncAt: 0,
    poll: { polling: false, nextAt: 0, interval: 0 }, files: { receivedBytes: 0, wireIds: new Set(), incoming: new Map() } } as never);
  return row;
}

const nodes: GhostlyNode[] = [];
function engine() {
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() } as never, { automaticWallets: false });
  nodes.push(node);
  return node;
}

beforeEach(async () => {
  await transact([STORES.links, STORES.messages], (s) => { s[STORES.links].clear(); s[STORES.messages].clear(); });
});
afterEach(async () => {
  for (const node of nodes.splice(0)) await node.stop?.().catch(() => {});
});

const text = "x".repeat(252);

it("with the contact away, a text the DHT packet cannot carry waits for the live session, as one past 256 bytes does", async () => {
  const node = engine();
  const chat = await addChat(node, stubLink());
  const sent = await node.sendMessage({ linkId: chat.id, text });
  expect(sent).toMatchObject({ error: null });
  const row = await db.getMessage(chat.id, sent.messageId!);
  expect(row).toMatchObject({ text, delivery: "waiting" });
  expect(row?.deliveryError).toMatch(/when you are live/);

  const longer = await node.sendMessage({ linkId: chat.id, text: "x".repeat(300) });
  expect(longer).toMatchObject({ error: null });
});

it("in a chat on the DHT by choice (this side's or the contact's), it is still refused: no live session comes", async () => {
  const node = engine();
  for (const [link, stored] of [[stubLink(), { deliveryMode: "dht" as const }], [stubLink("dht"), {}]] as const) {
    const chat = await addChat(node, link, stored);
    expect(await node.sendMessage({ linkId: chat.id, text })).toMatchObject({ error: DHT_PACKET_BUDGET, refused: true });
    expect(await db.getMessages(chat.id)).toEqual([]);
  }
});
