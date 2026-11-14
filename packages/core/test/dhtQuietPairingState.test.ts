import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GhostLink } from "../src/ghostlink";
import type { PairingState } from "../src/pairedSession";
import { RELAY_POLL_INTERVALS } from "../src/link";
import { createLink, type LinkParams } from "../src/invite";
import { createIdentity, type Identity } from "../src/identity";
import { emptyDhtDeliveryState, type DhtDeliveryState } from "../src/dhtDelivery";
import type { SignedPacket } from "../src/pkarr";
import type { PkarrTransport } from "../src/transport";

// covers: invite.delivery-mode

/**
 * A DHT-only chat left open: every mailbox read and every publication told the app the chat's pairing state again,
 * though nothing in it changed, and each such call built a whole engine state (bug hunt 1109-chat-perf: 96% of idle
 * states carried no change). A read or publication that leaves the pairing as it was now says nothing; a real change
 * (the contact's code confirmed) still goes out at once.
 */

const realSetTimeout = globalThis.setTimeout;
const yieldToLoop = () => new Promise<void>(resolve => realSetTimeout(resolve, 0));

function memoryPkarr(): PkarrTransport {
  const packets = new Map<string, SignedPacket>();
  return {
    publish: async (identity, records) => {
      packets.set(identity.pubKeyZ32, { pubKeyZ32: identity.pubKeyZ32, timestampMicros: BigInt(Date.now()) * 1000n, records });
    },
    resolve: async key => packets.get(key) ?? null,
    describe: () => ({ protocol: "memory", relays: [] }),
  };
}

interface Side { params: LinkParams; seedB64: string; peerKey: string; state: DhtDeliveryState }
function side(params: LinkParams, me: Identity, peer: Identity): Side {
  return { params: { ...params, profile: "paired-chat/1", deliveryMode: "dht" }, seedB64: me.seedB64, peerKey: peer.pubKeyZ32,
    state: { ...emptyDhtDeliveryState(), sequence: 3, peerSequence: 3, peerMode: "dht" } };
}

const links: GhostLink[] = [];
function open(s: Side, transport: PkarrTransport, states: PairingState[] = []): GhostLink {
  const link = new GhostLink({
    params: s.params,
    pairing: { credentials: { seedB64: s.seedB64, peerKey: s.peerKey, requireSignedSignals: true }, pinPeer: async () => {}, trustOnFirstUse: true, verifyPeer: async () => {} },
    dht: { state: s.state, save: async state => { s.state = state; } },
    transport,
    pollIntervals: RELAY_POLL_INTERVALS,
    autoConnect: true,
    // DHT only on both sides: no stream is ever dialled.
    createPeerConnection: () => { throw new Error("no stream on a DHT-only chat"); },
    localFetch: vi.fn(), getServices: () => [], getHostedHttpService: () => undefined,
    events: { onPairingState: state => { states.push(state); } },
  });
  links.push(link);
  link.start();
  return link;
}

async function run(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 1_000) { await vi.advanceTimersByTimeAsync(1_000); await yieldToLoop(); }
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] }); });
afterEach(async () => {
  await Promise.all(links.splice(0).map(link => link.stop(false)));
  vi.useRealTimers();
});

describe("a DHT-only chat left open", () => {
  for (const active of [true, false]) {
    it(`says its pairing state once, not at every mailbox read · chat ${active ? "on screen" : "in the background"}`, async () => {
      const transport = memoryPkarr();
      const invitation = createLink();
      const [pa, pb] = [createIdentity(), createIdentity()];
      const states: PairingState[] = [];
      let reads = 0;
      const counted: PkarrTransport = { ...transport, resolve: async (key, options) => { reads++; return transport.resolve(key, options); } };
      const a = open(side(invitation.mine, pa, pb), counted, states);
      open(side(invitation.invite, pb, pa), transport);
      a.setChatActive(active);
      await run(10 * 60_000);
      expect(reads, "A read the contact's mailbox all along").toBeGreaterThan(10);
      expect(states.length, `pairing states over ${reads} reads`).toBeLessThanOrEqual(2);
      expect(states[states.length - 1]).toMatchObject({ status: "ready", peerKey: pb.pubKeyZ32, verified: false });
    }, 60_000);
  }

  it("still says a real change at once: the contact's code confirmed", async () => {
    const transport = memoryPkarr();
    const invitation = createLink();
    const [pa, pb] = [createIdentity(), createIdentity()];
    const states: PairingState[] = [];
    const a = open(side(invitation.mine, pa, pb), transport, states);
    open(side(invitation.invite, pb, pa), transport);
    await run(2 * 60_000);
    const before = states.length;
    await a.confirmPair(states[states.length - 1]!.code!);
    expect(states.length).toBe(before + 1);
    expect(states[states.length - 1]).toMatchObject({ status: "ready", verified: true });
    await run(2 * 60_000);
    expect(states.length, "and quiet again after").toBe(before + 1);
  }, 60_000);
});
