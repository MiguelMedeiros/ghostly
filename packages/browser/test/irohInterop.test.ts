import "fake-indexeddb/auto";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { GhostLink, createIdentity, createLink, type PairingState } from "@ghostly/core";
import { db } from "../src/engine/db";
import { Outbox } from "../src/engine/outbox";
import { nativePeer } from "./helpers/nativePeer";
// covers-gated: transport.iroh, chat.paired.reconnect, chat.paired.offline-send, core.peer-keys

it.skipIf(process.env.TEST_NATIVE !== "1")("real Iroh peers preserve pins, history and retry IDs through reconnect", async () => {
  const binary = resolve("../../target/debug/examples/iroh-peer");
  const peers = await Promise.all([nativePeer(binary, 31), nativePeer(binary, 32)]);
  const invitation = createLink();
  const params = [invitation.mine, invitation.invite];
  const identities = [createIdentity(), createIdentity()];
  const states: PairingState[] = [{ status: "connecting" }, { status: "connecting" }];
  const links: GhostLink[] = [];
  const boxes: Outbox[] = [];
  const publish = vi.fn();
  for (let i = 0; i < 2; i++) {
    const id = `iroh-real-${i}`;
    await db.putLink({ ...params[i], id, profile: "paired-chat/1", participationSeed: identities[i].seedB64, createdAt: 1 });
    boxes[i] = new Outbox({ read: () => db.getMessages(id), update: (key, state, error) => db.updateDelivery(id, key, state, error) },
      message => links[i].sendMessage(message.text, message.timestamp, message.wireId), 300);
    links[i] = new GhostLink({ params: { ...params[i], profile: "paired-chat/1" }, rtcAvailable: false,
      pairing: { credentials: { seedB64: identities[i].seedB64 }, pinPeer: (key, signed) => db.pinPeer(id, key, signed) },
      native: { preferred: "iroh/1", fallback: false, peerDescriptors: { "iroh/1": peers[1-i].descriptor }, peerTransports: ["iroh/1"] },
      transport: { publish, resolve: async () => null, describe: () => ({ protocol: "unused local test discovery", relays: [] }) },
      createPeerConnection: () => { throw new Error("WebRTC must not be used"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
      events: {
        onPairingState: state => { states[i] = state; },
        onMessage: async message => { await db.addMessage({ linkId: id, id: `peer_${message.id}`, sender: "peer", timestamp: message.timestamp, text: message.text, via: "datalink" }); },
        onMessageReceipt: messageId => boxes[i].received(messageId),
      },
    });
    links[i].registerEndpoint(peers[i]);
  }
  try {
    const connected = links[0].connect(5000);
    await vi.waitFor(() => expect(states.map(s => s.status)).toEqual(["ready", "ready"]));
    expect(states[0].code).toBe(states[1].code);
    expect(states.every(s => !s.verified)).toBe(true);
    await connected;
    const wireId = "abcdefghijklmnopqrstuv";
    await db.addMessage({ linkId: "iroh-real-0", id: `me_${wireId}`, wireId, text: "real QUIC durable message", timestamp: 1, sender: "me", via: "datalink", delivery: "sending" });
    peers[0].dropReceipts = true;
    await boxes[0].transmit(`me_${wireId}`);
    await vi.waitFor(async () => expect((await db.getMessages("iroh-real-0"))[0].delivery).toBe("failed"));
    expect(await db.getMessages("iroh-real-1")).toHaveLength(1);
    links[0].disconnect();
    await vi.waitFor(() => expect(links[1].isDataLinkOpen).toBe(false));
    peers[0].dropReceipts = false;
    await links[0].connect(5000);
    await vi.waitFor(() => expect(states.every(s => s.status === "ready" && s.transport === "iroh/1")).toBe(true));
    await boxes[0].recover(); await boxes[0].transmit(`me_${wireId}`);
    await vi.waitFor(async () => expect((await db.getMessages("iroh-real-0"))[0].delivery).toBe("delivered"));
    expect(await db.getMessages("iroh-real-1")).toHaveLength(1);
    expect((await db.getLinks()).filter(l => l.id.startsWith("iroh-real-")).every(l => !!l.pairedPeerKey)).toBe(true);
    expect(publish).not.toHaveBeenCalled();
  } finally {
    await Promise.all(boxes.map(box => box.stop()));
    await Promise.all(links.map(link => link.stop(false)));
  }
}, 15000);
