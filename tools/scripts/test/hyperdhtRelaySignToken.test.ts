import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import DHT from "hyperdht";
import RelayedDHT from "@hyperswarm/dht-relay";
import WebSocketStream from "@hyperswarm/dht-relay/ws";
import { startRelay } from "../../../infra/services/hyperdht-relay/relay.mjs";

// covers: transport.hyperdht-relay

type KeyPair = { publicKey: Uint8Array; secretKey: Uint8Array };
type Server = { listen(keyPair: KeyPair): Promise<void> };
type Sign = (target: Uint8Array, token: Uint8Array | null, id: Uint8Array | null, ann: object, keyPair: KeyPair) => Promise<Uint8Array>;
type Announcer = { target: Uint8Array; _signAnnounce: Sign };

/**
 * hyperdht's announcer asks for a signature for every node that answered its query, one whose answer had no token too
 * (seen with a few thousand listens through one relay). dht-relay 0.4.3 cannot encode that request, and the relay drops
 * a client whose message cannot be sent: the browser lost every listen and dial for one node's answer, where a native
 * node only fails that node's announce.
 */
it("refuses to ask a browser to sign an announcement without a token, and keeps the browser", async () => {
  const reasons: string[] = [];
  const relay = await startRelay({ testnet: 3, log: (...words: string[]) => { reasons.push(words.join(" ")); } });
  try {
    const socket = new WebSocket(relay.url);
    await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
    const node = new RelayedDHT(new WebSocketStream(true, socket), { custodial: false }) as { createServer(): Server };
    const keyPair = DHT.keyPair();
    await node.createServer().listen(keyPair);
    const server = [...relay.dht.listening].find(s => s._keyPair && Buffer.compare(s._keyPair.publicKey, keyPair.publicKey) === 0);
    const announcer = server._announcer as Announcer;
    const ann = () => ({ peer: { publicKey: keyPair.publicKey, relayAddresses: [] }, refresh: null, signature: null });

    await expect(announcer._signAnnounce(announcer.target, null, randomBytes(32), ann(), keyPair)).rejects.toThrow();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(relay.stats()).toMatchObject({ clients: 1, dropped: 0 });
    expect(reasons.filter(reason => reason.startsWith("dropped"))).toEqual([]);
    // A node's answer with its token is still signed by the browser.
    expect((await announcer._signAnnounce(announcer.target, randomBytes(32), randomBytes(32), ann(), keyPair)).byteLength).toBe(64);
    socket.close();
  } finally {
    await relay.close();
  }
}, 60_000);
