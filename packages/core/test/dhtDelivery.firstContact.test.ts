import { afterEach, expect, it, vi } from "vitest";
import { createIdentity, identityFromSeedB64 } from "../src/identity";
import { createLink } from "../src/invite";
import { DhtDelivery, emptyDhtDeliveryState, type DhtDeliveryState } from "../src/dhtDelivery";
import { createRelayPayload, parseRelayPayload, type SignedPacket } from "../src/pkarr";
import type { PkarrRequestOptions } from "../src/transport";
import type { PairingCredentials } from "../src/pairedSession";
// covers: chat.dht.delivery

/**
 * The inviter's first-contact envelope, on a model of the local Mainline testnet (e2e/desktop/dht-direct.spec.ts): a put
 * is written at once and lands 1.15 s later, a read takes 1.5 s, a background one 2.1 s. The joiner dials only once it
 * read that envelope (it pins the inviter), so every second the envelope waits is a second the pairing waits.
 */
function testnet() {
  const link = createLink();
  const packets = new Map<string, SignedPacket>();
  const puts: string[] = [], reads: string[] = [];
  const publish = vi.fn(async (identity: Parameters<typeof createRelayPayload>[0], records: Parameters<typeof createRelayPayload>[1]) => {
    const packet = parseRelayPayload(identity.pubKeyZ32, createRelayPayload(identity, records));
    puts.push(identity.pubKeyZ32);
    setTimeout(() => packets.set(identity.pubKeyZ32, packet), 1_150);
  });
  const resolve = vi.fn(async (key: string, options?: PkarrRequestOptions) => {
    reads.push(key);
    await new Promise(done => setTimeout(done, options?.background ? 2_100 : 1_500));
    return packets.get(key) ?? null;
  });
  const transport = { publish, resolve, describe: () => ({ protocol: "testnet model", relays: [] }) };
  const make = (role: "inviter" | "joiner", credentials: PairingCredentials, state: DhtDeliveryState = emptyDhtDeliveryState()) => {
    const saved = { state };
    const delivery = new DhtDelivery({ params: role === "inviter" ? link.mine : link.invite, mode: "stream", state, credentials, transport,
      save: async next => { saved.state = structuredClone(next); }, pin: async key => { credentials.peerKey = key; },
      message: async () => {}, receipt: async () => {}, changed: () => {} });
    return { delivery, credentials, saved };
  };
  return { packets, puts, reads, publish, resolve, make };
}
afterEach(() => vi.useRealTimers());

it("an inviter's first envelope goes out as its delivery starts, not after its first read; the joiner reads it on its first read, with no put more", async () => {
  vi.useFakeTimers();
  const net = testnet();
  const inviterSeed = createIdentity().seedB64;
  const inviter = net.make("inviter", { seedB64: inviterSeed });
  await inviter.delivery.start(); await vi.advanceTimersByTimeAsync(100);
  expect(net.resolve, "its first read of the joiner's mailbox is under way").toHaveBeenCalledTimes(1);
  expect(net.publish, "the first-contact envelope is out before that read ends").toHaveBeenCalledTimes(1);
  // The joiner opens the invite a second later: it reads the inviter's mailbox at the signaling pace.
  await vi.advanceTimersByTimeAsync(900);
  const joiner = net.make("joiner", { seedB64: createIdentity().seedB64, expectedPeerKey: identityFromSeedB64(inviterSeed).pubKeyZ32 });
  joiner.delivery.expect(); await joiner.delivery.start();
  // The inviter sees the joiner's packet a moment later.
  await vi.advanceTimersByTimeAsync(200); inviter.delivery.expect();
  await vi.advanceTimersByTimeAsync(1_400);
  expect(joiner.credentials.peerKey, "pinned on its first read, 1.5 s after the join").toBe(identityFromSeedB64(inviterSeed).pubKeyZ32);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(inviter.credentials.peerKey, "and the inviter pins the joiner").toBe(identityFromSeedB64(joiner.credentials.seedB64).pubKeyZ32);
  // One envelope each, as before: the first put moved, none was added.
  expect(net.puts).toHaveLength(2);
  // A stop waits for the read in flight.
  const stopped = Promise.all([inviter.delivery.stop(), joiner.delivery.stop()]);
  await vi.advanceTimersByTimeAsync(3_000); await stopped;
});

it("a joiner whose capability record changes right after its first envelope names it once the spacing allows, and not at all once live", async () => {
  vi.useFakeTimers();
  const net = testnet();
  let rev = 1;
  const make = () => new DhtDelivery({ params: createLink().invite, mode: "stream", state: emptyDhtDeliveryState(), credentials: { seedB64: createIdentity().seedB64, peerKey: createIdentity().pubKeyZ32 },
    transport: { publish: net.publish, resolve: net.resolve, describe: () => ({ protocol: "testnet model", relays: [] }) },
    save: async () => {}, pin: async () => {}, message: async () => {}, receipt: async () => {}, changed: () => {}, capsRev: () => rev });
  // Its first envelope names revision 1; a transport comes up a moment later (revision 2), and the pair goes live.
  const live = make();
  await live.start(); await vi.advanceTimersByTimeAsync(2_200);
  expect(net.publish).toHaveBeenCalledTimes(1);
  rev = 2; await live.announce();
  await vi.advanceTimersByTimeAsync(100); live.setLive(true);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(net.publish, "the live session carries it: no envelope more").toHaveBeenCalledTimes(1);
  const stopped = live.stop(); await vi.advanceTimersByTimeAsync(3_000); await stopped;
  // Still on the DHT: the envelope naming it goes once the spacing allows, and names the newest of two quick changes.
  rev = 1;
  const onDht = make();
  await onDht.start(); await vi.advanceTimersByTimeAsync(2_200);
  expect(net.publish).toHaveBeenCalledTimes(2);
  rev = 2; await onDht.announce(); rev = 3; await onDht.announce();
  await vi.advanceTimersByTimeAsync(4_000);
  expect(net.publish).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(net.publish, "one envelope for both").toHaveBeenCalledTimes(3);
  const stopped2 = onDht.stop(); await vi.advanceTimersByTimeAsync(3_000); await stopped2;
});

it("a read that can change the envelope still comes first: a joiner seals its first one to the inviter, an inviter started again puts the receipt in its next one", async () => {
  vi.useFakeTimers();
  const net = testnet();
  const inviterSeed = createIdentity().seedB64, inviterKey = identityFromSeedB64(inviterSeed).pubKeyZ32;
  // The inviter's envelope is on the DHT: the joiner's first read finds it, and its first envelope is sealed to the inviter.
  const inviter = net.make("inviter", { seedB64: inviterSeed });
  await inviter.delivery.start(); await vi.advanceTimersByTimeAsync(3_000); await inviter.delivery.stop();
  const joiner = net.make("joiner", { seedB64: createIdentity().seedB64, expectedPeerKey: inviterKey });
  joiner.delivery.expect(); await joiner.delivery.start(); await vi.advanceTimersByTimeAsync(1_000);
  expect(net.puts, "no envelope of the joiner's before its read").toHaveLength(1);
  await vi.advanceTimersByTimeAsync(600);
  expect(joiner.credentials.peerKey).toBe(inviterKey);
  expect(net.puts).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1_200);
  const sealed = net.packets.get(net.puts[1])!;
  expect(sealed.records.map(r => r.label), "sealed to the inviter (its hint names the sender)").toContain("_dmk");
  // The joiner sends a text before the inviter came back; the inviter, started again with what it saved (its envelope
  // went out already, nobody pinned), reads first: the receipt rides on the one envelope it puts.
  expect(await joiner.delivery.send("hello", Date.now(), "abcdefghijklmnopqrstuv")).toBeNull();
  await joiner.delivery.stop(); await vi.advanceTimersByTimeAsync(1_200);
  const again = net.make("inviter", { seedB64: inviterSeed }, inviter.saved.state);
  const before = net.puts.length;
  again.delivery.expect(); await again.delivery.start(); await vi.advanceTimersByTimeAsync(1_600);
  expect(net.puts.length - before, "one envelope").toBe(1);
  expect(again.saved.state.receipt?.id, "carrying the receipt").toBe("abcdefghijklmnopqrstuv");
  expect(again.saved.state.receipt?.attempts).toBe(1);
  await again.delivery.stop();
});
