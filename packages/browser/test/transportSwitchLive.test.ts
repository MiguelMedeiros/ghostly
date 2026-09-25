import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { GhostLink, createIdentity, createLink, identityFromSeedB64, type PairingState, type PairedTransport } from "@ghostly/core";
import { db } from "../src/engine/db";
import { Outbox } from "../src/engine/outbox";
import { FakeNativeNet } from "./helpers/fakeNative";
// covers: transport.switch, transport.chat-switch, chat.paired.receipts, files.paired.send

/**
 * A live transport switch in the middle of a conversation, on two real links over stand-ins for Iroh and HyperDHT
 * (FakeNativeNet: real handshakes and bindings, frames lost when a channel closes under them). Both sides keep
 * sending while the session moves; nothing may be lost, shown twice or reordered, a file in flight must arrive
 * whole, and a switch whose transport cannot connect must leave the chat where it was.
 */

interface Side {
  id: string; link: GhostLink; box: Outbox; state: PairingState;
  sent: string[]; received: string[]; files: Uint8Array[]; fileDone: string[]; fileFailed: string[];
  choices: PairedTransport[]; switched: [PairedTransport | undefined, PairedTransport][]; failed: [PairedTransport, string | undefined][]; rtts: number[];
}
const sides: Side[] = [];

afterEach(async () => {
  for (const side of sides.splice(0)) { await side.box.stop(); await side.link.stop(false); await db.deleteLink(side.id); }
});

async function pair(net: FakeNativeNet, tag: string): Promise<[Side, Side]> {
  const invitation = createLink();
  const params = [invitation.mine, invitation.invite];
  const seeds = [createIdentity().seedB64, createIdentity().seedB64];
  const names = [`${tag}-a`, `${tag}-b`];
  const endpoints = names.map(name => ({ iroh: net.endpoint("iroh/1", name), hyper: net.endpoint("hyperdht/1", name) }));
  const made: Side[] = [];
  for (let i = 0; i < 2; i++) {
    const id = `${tag}-${i}`, peer = endpoints[1 - i];
    await db.putLink({ ...params[i], id, profile: "paired-chat/1", participationSeed: seeds[i], createdAt: 1 });
    const side = { id, state: { status: "connecting" }, sent: [], received: [], files: [], fileDone: [], fileFailed: [], choices: [], switched: [], failed: [], rtts: [] } as unknown as Side;
    side.box = new Outbox({ read: () => db.getMessages(id), update: (key, state, error) => db.updateDelivery(id, key, state, error) },
      message => side.link.sendMessage(message.text, message.timestamp, message.wireId));
    side.link = new GhostLink({
      params: { ...params[i], profile: "paired-chat/1" }, rtcAvailable: false,
      pairing: { credentials: { seedB64: seeds[i], peerKey: identityFromSeedB64(seeds[1 - i]).pubKeyZ32 }, pinPeer: async () => {} },
      native: { preferred: "iroh/1", fallback: true, peerTransports: ["iroh/1", "hyperdht/1"], peerFallback: true,
        peerDescriptors: { "iroh/1": peer.iroh.descriptor, "hyperdht/1": peer.hyper.descriptor } },
      transport: { publish: vi.fn(), resolve: async () => null, describe: () => ({ protocol: "in-process", relays: [] }) },
      createPeerConnection: () => { throw new Error("No WebRTC here"); }, localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
      events: {
        onPairingState: state => { side.state = state; },
        onPeerTransportChoice: transport => { side.choices.push(transport); },
        onTransportSwitchFailed: (target, reason) => { side.failed.push([target, reason]); },
        onRtt: ms => { side.rtts.push(ms); },
        // What the engine does on a switch: what awaits a receipt goes again at once over the new channel.
        onTransportSwitched: (from, to) => { side.switched.push([from, to]); void side.box.flush({ reopened: true }); },
        onMessage: async message => {
          side.received.push(message.id!);
          await db.addMessage({ linkId: id, id: `peer_${message.id}`, sender: "peer", timestamp: message.timestamp, text: message.text, via: "datalink" });
        },
        onMessageReceipt: wireId => side.box.received(wireId),
        onFileIncoming: () => ({ write: chunk => { side.files.push(chunk.slice()); }, close: async () => {}, abort() {} }),
        onFileComplete: (fileId, direction) => { if (direction === "in") side.fileDone.push(fileId); },
        onFileFailed: fileId => { side.fileFailed.push(fileId); },
      },
    });
    side.link.registerEndpoint(endpoints[i].iroh);
    side.link.registerEndpoint(endpoints[i].hyper);
    made.push(side); sides.push(side);
  }
  await made[0].link.connect(5_000);
  await vi.waitFor(() => expect(made.map(s => [s.state.status, s.state.transport])).toEqual([["ready", "iroh/1"], ["ready", "iroh/1"]]));
  // A ping goes at the open: the round trip is known at once, not a liveness period later.
  await vi.waitFor(() => expect(made.every(s => s.rtts.length === 1 && s.link.rttMs === s.rtts[0])).toBe(true));
  return made as [Side, Side];
}

let clock = 1_000;
async function say(side: Side, text: string): Promise<void> {
  const wireId = crypto.randomUUID().replace(/-/g, "").slice(0, 22);
  const timestamp = ++clock;
  await db.addMessage({ linkId: side.id, id: `me_${wireId}`, wireId, text, timestamp, sender: "me", via: "datalink", delivery: "sending" });
  side.sent.push(wireId);
  await side.box.transmit(`me_${wireId}`);
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

it("moves a busy chat to another transport with nothing lost, doubled or out of order, and a file in flight arrives whole", async () => {
  const net = new FakeNativeNet();
  const [a, b] = await pair(net, "live-switch");
  const bytes = new Uint8Array(40 * 16 * 1024 + 123).map((_, i) => i % 251);
  let chunks = 0;
  const file = a.link.sendFile({ id: "file-across-switch-1", name: "across.bin", mime: "application/octet-stream", size: bytes.length, timestamp: 5 },
    (async function* () { for (let at = 0; at < bytes.length; at += 16 * 1024) { chunks++; yield bytes.slice(at, at + 16 * 1024); } })());
  // Both talk the whole time; B chooses HyperDHT a third of the way in.
  for (let n = 0; n < 30; n++) {
    await Promise.all([say(a, `a${n}`), say(b, `b${n}`)]);
    if (n === 10) { await vi.waitFor(() => expect(chunks).toBeGreaterThan(2)); void b.link.setTransportPreference("hyperdht/1", true); }
    await pause(1);
  }
  await file;
  await vi.waitFor(() => expect([a, b].map(s => [s.state.status, s.state.transport, s.state.transitionTarget])).toEqual([["ready", "hyperdht/1", undefined], ["ready", "hyperdht/1", undefined]]));
  expect(a.switched).toEqual([["iroh/1", "hyperdht/1"]]);
  expect(b.switched).toEqual([["iroh/1", "hyperdht/1"]]);
  // A reads B's choice from the policy B already sends; B did not see a choice of A's.
  expect(a.choices).toEqual(["hyperdht/1"]);
  expect(b.choices).toEqual([]);

  for (const [from, to] of [[a, b], [b, a]]) {
    await vi.waitFor(async () => {
      const mine = await db.getMessages(from.id);
      expect(mine.filter(m => m.sender === "me").map(m => m.delivery)).toEqual(from.sent.map(() => "delivered"));
    }, { timeout: 5_000 });
    const theirs = (await db.getMessages(to.id)).filter(m => m.sender === "peer");
    // Every message once, in the order it was written.
    expect(theirs.map(m => m.id)).toEqual(from.sent.map(id => `peer_${id}`));
  }
  expect(b.fileDone).toEqual(["file-across-switch-1"]);
  expect(b.fileFailed).toEqual([]);
  expect(Buffer.concat(b.files)).toEqual(Buffer.from(bytes));
  // The old channels are closed: nothing runs over Iroh any more.
  expect(a.link.canReleaseEndpoint("iroh/1")).toBe(true);
}, 20_000);

it("stays on the current transport when the chosen one cannot connect, and the chat keeps working", async () => {
  const net = new FakeNativeNet();
  const [a, b] = await pair(net, "failed-switch");
  net.unreachable.add("hyperdht/1");
  await a.link.setTransportPreference("hyperdht/1", true);
  // Both allow fallback: the chat stays on Iroh, and both sides hear the switch did not happen.
  await vi.waitFor(() => expect([a.failed.length, b.failed.length]).toEqual([1, 1]), { timeout: 15_000 });
  const coordinator = a.link.myPubKeyZ32 < b.link.myPubKeyZ32 ? a : b, other = coordinator === a ? b : a;
  expect(coordinator.failed).toEqual([["hyperdht/1", "hyperdht/1 unreachable"]]);
  expect(other.failed).toEqual([["hyperdht/1", undefined]]);
  await vi.waitFor(() => expect([a, b].map(s => [s.state.status, s.state.transport, s.state.transitionTarget])).toEqual([["ready", "iroh/1", undefined], ["ready", "iroh/1", undefined]]));
  expect(a.switched).toEqual([]);
  expect(a.link.isDataLinkOpen && b.link.isDataLinkOpen).toBe(true);
  await say(a, "still here");
  await say(b, "me too");
  await vi.waitFor(async () => {
    for (const side of [a, b]) expect((await db.getMessages(side.id)).filter(m => m.sender === "me").map(m => m.delivery)).toEqual(["delivered"]);
  });
  // Once it can connect, choosing it again moves the chat.
  net.unreachable.delete("hyperdht/1");
  await a.link.setTransportPreference("hyperdht/1", true);
  await vi.waitFor(() => expect([a, b].map(s => s.state.transport)).toEqual(["hyperdht/1", "hyperdht/1"]), { timeout: 10_000 });
}, 30_000);

it("goes Automatic: the contact's explicit choice wins, and without one the chat stays where it is", async () => {
  const net = new FakeNativeNet();
  const [a, b] = await pair(net, "automatic");
  await a.link.setTransportPreference("hyperdht/1", true);
  await vi.waitFor(() => expect([a, b].map(s => s.state.transport)).toEqual(["hyperdht/1", "hyperdht/1"]));
  // A goes Automatic: nothing moves, since B never chose.
  await a.link.setTransportPreference("iroh/1", true, true);
  await pause(200);
  expect([a, b].map(s => s.state.transport)).toEqual(["hyperdht/1", "hyperdht/1"]);
  // B chooses Iroh: A has no choice of its own left, so B's wins.
  await b.link.setTransportPreference("iroh/1", true);
  await vi.waitFor(() => expect([a, b].map(s => s.state.transport)).toEqual(["iroh/1", "iroh/1"]));
  expect(a.choices).toEqual(["iroh/1"]);
}, 20_000);
