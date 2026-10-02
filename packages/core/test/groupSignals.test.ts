import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CARRIED_DEFER_MS, SIGNAL_FRESH_MS, SIGNAL_PROVEN_MS, CarriedTransport, DiscoveryBudgetError, createIdentity, createRelayPayload, groupSignalFrame, parseRelayPayload, readGroupSignal,
  type GhostRecord, type Identity, type PkarrTransport, type SignedPacket,
} from "../src";
// covers: groups.protocol.signals

/** The relays, as an edge sees them: what was published under each key, and how many requests it took. */
class Relays implements PkarrTransport {
  readonly packets = new Map<string, SignedPacket>();
  publishes: GhostRecord[][] = [];
  options: unknown[] = [];
  reads = 0;
  failPublish: unknown = null;
  failRead: unknown = null;
  /** A read that stays open until `answer` is called. */
  hold: (() => void) | null = null;
  held = false;
  async publish(identity: Identity, records: GhostRecord[], options?: unknown): Promise<void> {
    if (this.failPublish) throw this.failPublish;
    this.publishes.push(records);
    this.options.push(options);
    this.packets.set(identity.pubKeyZ32, { pubKeyZ32: identity.pubKeyZ32, timestampMicros: BigInt(Date.now()) * 1000n, records });
  }
  async resolve(key: string): Promise<SignedPacket | null> {
    this.reads++;
    if (this.held) await new Promise<void>(resolve => { this.hold = resolve; });
    if (this.failRead) throw this.failRead;
    return this.packets.get(key) ?? null;
  }
  describe() { return { protocol: "test", relays: [] }; }
}

const records = (value: string): GhostRecord[] => [{ label: "_x", value }];

function edge(carriers = 1, sure = true) {
  const me = createIdentity(), peer = createIdentity(), relays = new Relays();
  const state = { open: false, carriers, sure, carried: [] as Uint8Array[], looks: 0 };
  const transport = new CarriedTransport(relays, me.pubKeyZ32, peer.pubKeyZ32, {
    carry: payload => { state.carried.push(payload); return { taken: state.carriers, sure: state.sure }; },
    open: () => state.open,
    look: () => { state.looks++; },
  });
  return { me, peer, relays, state, transport };
}

describe("an edge's packets, carried by members beside the relays", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  it("goes to the relays at once when no member can carry it", async () => {
    const { me, relays, state, transport } = edge(0);
    await transport.publish(me, records("here"));
    expect(state.carried).toHaveLength(1);
    expect(relays.publishes).toEqual([records("here")]);
  });

  it("hands members the packet a relay would store, and gives the relays only the newest one, later", async () => {
    const { me, relays, state, transport } = edge();
    await transport.publish(me, records("here"));
    await transport.publish(me, records("offer"));
    // What a member carries is checked as a relay's answer is: signed under the edge's key.
    expect(parseRelayPayload(me.pubKeyZ32, state.carried[1]).records).toMatchObject(records("offer"));
    expect(parseRelayPayload(me.pubKeyZ32, state.carried[1]).timestampMicros).toBeGreaterThan(parseRelayPayload(me.pubKeyZ32, state.carried[0]).timestampMicros);
    expect(relays.publishes).toEqual([]);
    await vi.advanceTimersByTimeAsync(CARRIED_DEFER_MS);
    expect(relays.publishes).toEqual([records("offer")]);
  });

  it("a member that may not reach the other end carries the packet, and the relays get it at once, until something came back that way", async () => {
    const { me, peer, relays, state, transport } = edge(1, false);
    await transport.publish(me, records("answer"));
    expect(state.carried).toHaveLength(1);
    expect(relays.publishes).toEqual([records("answer")]);
    // The other end's packet came through a member: that way works, for a while.
    transport.accept(createRelayPayload(peer, records("theirs")));
    await transport.publish(me, records("next"));
    expect(relays.publishes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(CARRIED_DEFER_MS);
    expect(relays.publishes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(SIGNAL_PROVEN_MS);
    await transport.publish(me, records("much later"));
    expect(relays.publishes).toHaveLength(3);
  });

  it("an edge that opened meanwhile publishes its settled packet, and the deferred one never goes", async () => {
    const { me, relays, state, transport } = edge();
    await transport.publish(me, records("offer"));
    state.open = true;
    await transport.publish(me, records("settled"));
    await vi.advanceTimersByTimeAsync(CARRIED_DEFER_MS * 2);
    expect(relays.publishes).toEqual([records("settled")]);
    // Nobody waits for it: a background write.
    expect(relays.options).toEqual([{ background: true }]);
    expect(state.carried).toHaveLength(1);
    expect(transport.latest()).toBeNull();
  });

  it("stops deferring once a deferral ends with nothing heard through a member, until something is", async () => {
    const { me, peer, relays, transport } = edge();
    await transport.publish(me, records("here"));
    await vi.advanceTimersByTimeAsync(CARRIED_DEFER_MS);
    expect(relays.publishes).toEqual([records("here")]);
    // Nobody reached the other end: the next packet is not held back.
    await transport.publish(me, records("offer"));
    expect(relays.publishes).toEqual([records("here"), records("offer")]);
    // A carried packet of the member's came: a member reaches it after all.
    expect(transport.accept(createRelayPayload(peer, records("theirs")))).toBe(true);
    await transport.publish(me, records("answer"));
    expect(relays.publishes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(CARRIED_DEFER_MS);
    expect(relays.publishes).toEqual([records("here"), records("offer"), records("answer")]);
  });

  it("tries a deferred packet again when the relays' budget holds it back, unless a newer one came", async () => {
    const { me, peer, relays, transport } = edge();
    transport.accept(createRelayPayload(peer, records("theirs")));
    relays.failPublish = new DiscoveryBudgetError(2_000);
    await transport.publish(me, records("offer"));
    await vi.advanceTimersByTimeAsync(CARRIED_DEFER_MS);
    expect(relays.publishes).toEqual([]);
    relays.failPublish = null;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(relays.publishes).toEqual([records("offer")]);
  });

  it("answers the next read with a carried packet, without a request, and tells the edge to look", async () => {
    const { peer, relays, state, transport } = edge();
    expect(transport.accept(createRelayPayload(peer, records("offer")))).toBe(true);
    expect(state.looks).toBe(1);
    expect((await transport.resolve(peer.pubKeyZ32))?.records).toMatchObject(records("offer"));
    expect(relays.reads).toBe(0);
    // Read once: the next look asks the relays, and the newer of the two answers.
    expect((await transport.resolve(peer.pubKeyZ32))?.records).toMatchObject(records("offer"));
    expect(relays.reads).toBe(1);
    vi.advanceTimersByTime(10);
    await relays.publish(peer, records("newer on the relays"));
    expect((await transport.resolve(peer.pubKeyZ32))?.records).toEqual(records("newer on the relays"));
  });

  it("a carried packet that comes while a read is under way answers that read", async () => {
    const { peer, relays, state, transport } = edge();
    relays.held = true;
    const read = transport.resolve(peer.pubKeyZ32);
    await Promise.resolve();
    expect(transport.accept(createRelayPayload(peer, records("offer")))).toBe(true);
    expect((await read)?.records).toMatchObject(records("offer"));
    expect(state.looks).toBe(0);
    relays.hold?.();
  });

  it("asks the relays nothing while its own packet is with members only: the answer comes back the same way", async () => {
    const { me, peer, relays, transport } = edge();
    await transport.publish(me, records("here"));
    const read = transport.resolve(peer.pubKeyZ32);
    await vi.advanceTimersByTimeAsync(CARRIED_DEFER_MS / 2);
    expect(relays.reads).toBe(0);
    transport.accept(createRelayPayload(peer, records("theirs")));
    expect((await read)?.records).toMatchObject(records("theirs"));
    expect(relays.reads).toBe(0);
    // Nothing comes back: the relays are read once the packet goes to them.
    await transport.publish(me, records("offer"));
    const next = transport.resolve(peer.pubKeyZ32);
    await vi.advanceTimersByTimeAsync(CARRIED_DEFER_MS);
    await next;
    expect(relays.reads).toBe(1);
  });

  it("an edge that came up through members does not ask the relays right after: its slow look does, later", async () => {
    const { peer, relays, state, transport } = edge();
    transport.accept(createRelayPayload(peer, records("answer")));
    await transport.resolve(peer.pubKeyZ32);
    state.open = true;
    expect((await transport.resolve(peer.pubKeyZ32))?.records).toMatchObject(records("answer"));
    expect(relays.reads).toBe(0);
    await vi.advanceTimersByTimeAsync(SIGNAL_PROVEN_MS);
    await transport.resolve(peer.pubKeyZ32);
    expect(relays.reads).toBe(1);
  });

  it("takes only the member's own packets, and only newer ones", async () => {
    const { me, peer, state, transport } = edge();
    expect(transport.accept(createRelayPayload(createIdentity(), records("someone else's")))).toBe(false);
    expect(transport.accept(createRelayPayload(me, records("my own")))).toBe(false);
    expect(transport.accept(new Uint8Array(40))).toBe(false);
    const first = createRelayPayload(peer, records("first"), 1_800_000_000_000_000n), second = createRelayPayload(peer, records("second"), 1_800_000_000_000_001n);
    expect(transport.accept(second)).toBe(true);
    expect(transport.accept(first)).toBe(false);
    expect(transport.accept(second)).toBe(false);
    expect(state.looks).toBe(1);
  });

  it("takes nothing old: a packet from before the newest one read, or from another time", async () => {
    const { peer, relays, state, transport } = edge();
    const old = createRelayPayload(peer, records("an old offer"));
    vi.advanceTimersByTime(1_000);
    await relays.publish(peer, records("settled"));
    await transport.resolve(peer.pubKeyZ32);
    // A member that carried the old offer once hands it on again: the edge has read past it.
    expect(transport.accept(old)).toBe(false);
    const stale = createRelayPayload(peer, records("kept for later"), BigInt(Date.now() + 5_000) * 1000n);
    vi.advanceTimersByTime(SIGNAL_FRESH_MS + 6_000);
    expect(transport.accept(stale)).toBe(false);
    expect(transport.accept(createRelayPayload(peer, records("far ahead"), BigInt(Date.now() + SIGNAL_FRESH_MS + 1_000) * 1000n))).toBe(false);
    expect(state.looks).toBe(0);
  });

  it("answers from what a member carried when the relays do not", async () => {
    const { peer, relays, transport } = edge();
    relays.failRead = new DiscoveryBudgetError(30_000);
    await expect(transport.resolve(peer.pubKeyZ32)).rejects.toBeInstanceOf(DiscoveryBudgetError);
    transport.accept(createRelayPayload(peer, records("offer")));
    await transport.resolve(peer.pubKeyZ32);
    expect((await transport.resolve(peer.pubKeyZ32))?.records).toMatchObject(records("offer"));
  });

  it("leaves other keys to the relays, and everything once it is stopped", async () => {
    const { me, peer, relays, state, transport } = edge();
    const other = createIdentity();
    await transport.publish(other, records("a record of another kind"));
    expect(relays.publishes).toHaveLength(1);
    expect(state.carried).toHaveLength(0);
    await transport.resolve(other.pubKeyZ32);
    expect(relays.reads).toBe(1);
    await transport.publish(me, records("offer"));
    transport.stop();
    await vi.advanceTimersByTimeAsync(CARRIED_DEFER_MS);
    expect(relays.publishes).toHaveLength(1);
    await transport.publish(me, records("goodbye"));
    expect(relays.publishes).toHaveLength(2);
    expect(transport.accept(createRelayPayload(peer, records("late")))).toBe(false);
  });
});

describe("the group-signal frame", () => {
  const g = "A".repeat(22), from = createIdentity().pubKeyZ32, to = createIdentity().pubKeyZ32;
  it("round-trips, and says when it was passed on", () => {
    const payload = createRelayPayload(createIdentity(), records("x"));
    expect(readGroupSignal(groupSignalFrame(g, from, to, payload))).toEqual({ g, from, to, payload, hop: false });
    expect(readGroupSignal(groupSignalFrame(g, from, to, payload, true))?.hop).toBe(true);
  });
  it("is nothing when malformed", () => {
    const good = groupSignalFrame(g, from, to, new Uint8Array(80));
    for (const bad of [null, {}, { ...good, g: "short" }, { ...good, to: from }, { ...good, from: "nobody" }, { ...good, p: "not base64 !" }, { ...good, p: "A".repeat(4_000) }, { ...good, h: 2 }, { ...good, t: "group-msg" }])
      expect(readGroupSignal(bad)).toBeNull();
  });
});
