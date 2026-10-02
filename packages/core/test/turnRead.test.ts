import { describe, expect, it } from "vitest";
import {
  classifyTurnRead, identityFromSeed, keptAtEqualSequence, readTurnPacket, signRelayPayload, signTurnPacket, signTurnRelease, turnPutSummary, turnSequence,
  encodeTxtPacket, TOMBSTONE_SEQUENCE, TOMBSTONE_TURN, TURN_NO_ACTIVE, type Identity, type TurnFields, type TurnReader, type TurnSourceAnswer,
} from "../src/index";
import { devices, signerOf, vectorKeys } from "./turnVectors";
// covers: devices.turn.read

const keys = vectorKeys();
const all = devices();
const slotsOf = (held: number[], extra: Record<number, Identity> = {}) => all.map((device, i) => (extra[i] ? { key: extra[i].publicKey, name: "Copy" } : held.includes(i) ? { key: device.publicKey, name: device.name } : null));
const instance = (n: number) => Uint8Array.of(0, 0, 0, 0, 0, 0, 0, n);

/** A record by the device in slot `author`, active itself, of a set of `held` devices. */
async function packet(turn: number, rev: number, author: number, options: { held?: number[]; instance?: number; release?: { from: number; h?: number }; signer?: Identity } = {}): Promise<Uint8Array> {
  const signer = options.signer ?? all[author];
  const slots = slotsOf(options.held ?? [0, 1, 2], options.signer ? { [author]: options.signer } : {});
  const release = options.release && await signTurnRelease(keys.address, turn, options.release.from, author, signer.publicKey, new Uint8Array(32).fill(options.release.h ?? 1), signerOf(all[options.release.from]));
  const fields: TurnFields = { turn, rev, author, active: author, slots, instance: instance(options.instance ?? 1), ...(release ? { release } : {}) };
  return signTurnPacket(keys, fields, signerOf(signer));
}
const tombstone = (author: number, held: number[]) => signTurnPacket(keys, { turn: TOMBSTONE_TURN, rev: 0, author, active: TURN_NO_ACTIVE, slots: slotsOf(held), instance: instance(1) }, signerOf(all[author]));
/** A packet under the turn key that is no record: what a holder of `D` can put at any sequence. */
const junk = (sequence: number | bigint) => signRelayPayload(keys.identity, encodeTxtPacket([{ name: `_s.${keys.identity.pubKeyZ32}`, value: "junk", ttl: 300 }]), BigInt(sequence));

const has = (source: string, ...payloads: Uint8Array[]): TurnSourceAnswer => ({ source, answered: true, payloads });
const silent = (source: string): TurnSourceAnswer => ({ source, answered: false, payloads: [], detail: "timeout" });
const reader = (device: number, stored: Uint8Array | null, extra: Partial<TurnReader> = {}): TurnReader => ({ keys, ownKey: all[device].publicKey, stored, ...extra });

describe("the result of a turn read", () => {
  it("unreachable: no source answered. One answer, even an empty one, makes the read good", async () => {
    const mine = await packet(5, 0, 0);
    const none = classifyTurnRead(reader(0, mine), [silent("a"), silent("b")]);
    expect(none).toMatchObject({ result: "unreachable", good: false, seen: 0n, conditions: {} });
    expect(classifyTurnRead(reader(0, mine), [])).toMatchObject({ result: "unreachable", good: false });
    expect(classifyTurnRead(reader(0, mine), [silent("a"), has("b")])).toMatchObject({ result: "none", good: true, conditions: { b: null } });
  });

  it("mine: a source returned, as the highest record, byte for byte the stored packet", async () => {
    const mine = await packet(5, 2, 0);
    const read = classifyTurnRead(reader(0, mine), [has("a", mine), has("b"), silent("dht")]);
    expect(read).toMatchObject({ result: "mine", good: true, seen: BigInt(turnSequence(5, 2, 0)) });
    expect(read.conditions).toEqual({ a: String(turnSequence(5, 2, 0)), b: null });
    // The stored packet is never an answer: with no source holding it, it is not `mine`.
    expect(classifyTurnRead(reader(0, mine), [has("a"), has("b")]).result).toBe("none");
    // The same record sealed again is another packet.
    const again = await packet(5, 2, 0);
    expect(classifyTurnRead(reader(0, mine), [has("a", again)]).result).not.toBe("mine");
  });

  it("mine after a restart, whatever instance it carries: it is the stored packet", async () => {
    const mine = await packet(5, 2, 0, { instance: 200 });
    expect(classifyTurnRead(reader(0, mine), [has("a", mine)]).result).toBe("mine");
  });

  it("behind: the highest the sources hold is this device's own earlier record, or an older turn", async () => {
    const earlier = await packet(5, 1, 0), mine = await packet(5, 2, 0), older = await packet(4, 7, 1);
    const read = classifyTurnRead(reader(0, mine), [has("a", earlier), has("b", older)]);
    expect(read.result).toBe("behind");
    expect(read.record?.rev).toBe(1);
    // Each source's own condition: a lagging one is compared with what it holds, not with another.
    expect(read.conditions).toEqual({ a: String(turnSequence(5, 1, 0)), b: String(turnSequence(4, 7, 1)) });
    expect(classifyTurnRead(reader(0, mine), [has("b", older)]).result).toBe("behind");
  });

  it("behind: of two valid records at one turn the higher sequence wins, so the device in the higher slot is not replaced", async () => {
    const mine = await packet(6, 0, 2), theirs = await packet(6, 0, 1);
    expect(classifyTurnRead(reader(2, mine), [has("a", theirs)]).result).toBe("behind");
    // And the one whose record lost reads `other`.
    expect(classifyTurnRead(reader(1, theirs), [has("a", mine)]).result).toBe("other");
    expect(classifyTurnRead(reader(1, theirs), [has("a", mine), has("b", theirs)]).result).toBe("other");
  });

  it("other: a higher turn, with its release or without one", async () => {
    const mine = await packet(5, 2, 0);
    const taken = await packet(6, 0, 1, { release: { from: 0 } });
    expect(classifyTurnRead(reader(0, mine), [has("a", mine), has("b", taken)])).toMatchObject({ result: "other", forced: false });
    const forced = await packet(6, 0, 1);
    const read = classifyTurnRead(reader(0, mine), [has("a", forced)]);
    expect(read).toMatchObject({ result: "other", forced: true });
    expect(read.record?.author).toBe(1);
    expect(read.payload).toBe(forced);
    // A release from a device this reader did not know as active is shown as a takeover without a release.
    const odd = await packet(6, 0, 1, { release: { from: 2 } });
    expect(classifyTurnRead(reader(0, mine), [has("a", odd)])).toMatchObject({ result: "other", forced: true });
  });

  it("other: an unknown signer that names itself active is accepted, and supersedes", async () => {
    const mine = await packet(5, 2, 0);
    const stranger = identityFromSeed(new Uint8Array(32).fill(3));
    const restored = await packet(6, 0, 3, { held: [0, 1, 2], signer: stranger });
    expect(classifyTurnRead(reader(0, mine), [has("a", restored)])).toMatchObject({ result: "other", forced: true });
  });

  it("other, for a standby: the active device's record, known or newer", async () => {
    const active = await packet(5, 2, 0);
    expect(classifyTurnRead(reader(1, active), [has("a", active)])).toMatchObject({ result: "other", known: true, forced: true });
    const newer = await packet(5, 3, 0);
    const read = classifyTurnRead(reader(1, active), [has("a", newer)]);
    expect(read.result).toBe("other");
    expect(read.known).toBeUndefined();
    // A standby with nothing stored yet reads whatever is there as another device's.
    expect(classifyTurnRead(reader(1, null), [has("a", active)]).result).toBe("other");
    // What it knows is newer than what the sources hold.
    expect(classifyTurnRead(reader(1, newer), [has("a", active)]).result).toBe("behind");
  });

  it("clone above: a record from this device's own slot, above its stored one, that it never stored", async () => {
    const mine = await packet(5, 2, 0), copy = await packet(5, 3, 0, { instance: 9 });
    expect(classifyTurnRead(reader(0, mine), [has("a", mine), has("b", copy)])).toMatchObject({ result: "clone", clone: "above" });
    // With another key in the slot: a second restored copy took the same free slot.
    const second = await packet(6, 0, 0, { signer: identityFromSeed(new Uint8Array(32).fill(4)) });
    expect(classifyTurnRead(reader(0, mine), [has("a", second)])).toMatchObject({ result: "clone", clone: "above" });
    // A standby that never wrote finds a record from its own slot.
    const active = await packet(5, 2, 0);
    expect(classifyTurnRead(reader(1, active), [has("a", await packet(6, 0, 1))])).toMatchObject({ result: "clone", clone: "above" });
  });

  it("clone at an equal sequence: the lower instance goes on, for both copies alike", async () => {
    const low = await packet(5, 3, 0, { instance: 1 }), high = await packet(5, 3, 0, { instance: 2 });
    const answers = [has("a", low), has("b", high)];
    expect(classifyTurnRead(reader(0, low), answers)).toMatchObject({ result: "clone", clone: "equal", lower: true });
    expect(classifyTurnRead(reader(0, high), answers)).toMatchObject({ result: "clone", clone: "equal", lower: false });
    // Also when the sources hold only the other copy's record.
    expect(classifyTurnRead(reader(0, low), [has("a", high)])).toMatchObject({ result: "clone", clone: "equal", lower: true });
    expect(classifyTurnRead(reader(0, high), [has("a", low)])).toMatchObject({ result: "clone", clone: "equal", lower: false });
    // Never the larger encoded bytes, which the pkarr crate prefers and which is random for a sealed record.
    const a = readTurnPacket(keys, low), b = readTurnPacket(keys, high);
    if (a.kind !== "valid" || b.kind !== "valid") throw new Error("not valid");
    expect(keptAtEqualSequence({ record: a.record, payload: low }, { record: b.record, payload: high })).toBeLessThan(0);
    // One instance in both (the same record sealed twice): still one answer for every reader.
    const twin = await packet(5, 3, 0, { instance: 1 });
    const one = classifyTurnRead(reader(0, low), [has("a", twin)]), two = classifyTurnRead(reader(0, twin), [has("a", low)]);
    expect(one.result).toBe("clone");
    expect(one.lower).toBe(!two.lower);
  });

  it("an equal sequence in another device's slot is that device's to settle: a standby reads the lower instance as active", async () => {
    const low = await packet(5, 3, 0, { instance: 1 }), high = await packet(5, 3, 0, { instance: 2 });
    const read = classifyTurnRead(reader(1, high), [has("a", low), has("b", high)]);
    expect(read.result).toBe("other");
    expect(read.payload).toBe(low);
  });

  it("tombstone: the address is closed, and the reader is still listed or not", async () => {
    const mine = await packet(5, 2, 0);
    const closed = await tombstone(1, [1, 2]);
    expect(classifyTurnRead(reader(0, mine), [has("a", mine), has("b", closed)])).toMatchObject({ result: "tombstone", listed: false, closed: true, seen: BigInt(TOMBSTONE_SEQUENCE) });
    expect(classifyTurnRead(reader(2, mine), [has("a", closed)])).toMatchObject({ result: "tombstone", listed: true });
    // A tombstone is never outranked, by a taker either.
    expect(classifyTurnRead(reader(2, await packet(6, 0, 2), { taking: 6 }), [has("a", closed), has("b", await packet(6, 0, 1))]).result).toBe("tombstone");
  });

  it("none: sources answered and none has a record", async () => {
    expect(classifyTurnRead(reader(0, await packet(5, 2, 0)), [has("a"), has("b")])).toMatchObject({ result: "none", good: true, seen: 0n, closed: false });
    expect(classifyTurnRead(reader(0, null), [has("a")]).result).toBe("none");
  });

  it("a taking device yields to any other valid record at its turn, whatever the sequences, in either slot order", async () => {
    // The taker in the higher slot: its sequence would win, and it yields all the same.
    const high = await packet(6, 0, 2, { release: { from: 0 } }), forcedLow = await packet(6, 0, 1);
    expect(classifyTurnRead(reader(2, high, { taking: 6 }), [has("a", high), has("b", forcedLow)])).toMatchObject({ result: "other", forced: true });
    // The taker in the lower slot.
    const low = await packet(6, 0, 1, { release: { from: 0 } }), forcedHigh = await packet(6, 0, 2);
    expect(classifyTurnRead(reader(1, low, { taking: 6 }), [has("a", low), has("b", forcedHigh)]).result).toBe("other");
    // The device that forced the turn is not taking: it keeps to "the higher sequence wins".
    expect(classifyTurnRead(reader(1, forcedLow), [has("a", high)]).result).toBe("other");
    expect(classifyTurnRead(reader(2, forcedHigh), [has("a", low)]).result).toBe("behind");
    // Alone at its turn, a taker reads its own record.
    expect(classifyTurnRead(reader(2, high, { taking: 6 }), [has("a", high), has("b", await packet(5, 9, 0))]).result).toBe("mine");
    expect(classifyTurnRead(reader(2, high, { taking: 6 }), [has("b", await packet(5, 9, 0))]).result).toBe("behind");
  });

  it("an invalid packet is no record, and its sequence still counts as seen", async () => {
    const mine = await packet(5, 2, 0);
    const high = turnSequence(5, 4000, 3);
    const read = classifyTurnRead(reader(0, mine), [has("a", mine), has("b", junk(high))]);
    expect(read).toMatchObject({ result: "mine", seen: BigInt(high) });
    expect(read.invalid).toEqual([{ source: "b", sequence: BigInt(high), refusal: "seal" }]);
    expect(read.conditions).toEqual({ a: String(turnSequence(5, 2, 0)), b: String(high) });
    // Only the invalid packet is left on the sources: no record, and the next put must go above it.
    expect(classifyTurnRead(reader(0, mine), [has("a", junk(high))])).toMatchObject({ result: "none", seen: BigInt(high) });
  });

  it("a packet that is not under the turn key counts for nothing", async () => {
    const mine = await packet(5, 2, 0);
    const forged = junk(2n ** 51n);
    forged[3] ^= 1;
    expect(classifyTurnRead(reader(0, mine), [has("a", forged, mine)])).toMatchObject({ result: "mine", seen: BigInt(turnSequence(5, 2, 0)), invalid: [] });
    expect(classifyTurnRead(reader(0, mine), [has("a", new Uint8Array(10))])).toMatchObject({ result: "none", conditions: { a: null } });
  });

  it("an invalid packet at the tombstone's sequence closes the address without being a tombstone", async () => {
    const mine = await packet(5, 2, 0);
    expect(classifyTurnRead(reader(0, mine), [has("a", mine), has("b", junk(TOMBSTONE_SEQUENCE))])).toMatchObject({ result: "mine", closed: true });
    expect(classifyTurnRead(reader(0, mine), [has("b", junk(2n ** 62n))])).toMatchObject({ result: "none", closed: true, seen: 2n ** 62n });
  });

  it("the DHT's several items are one source's answer: the highest among them counts", async () => {
    const mine = await packet(5, 2, 0), earlier = await packet(5, 1, 0);
    const read = classifyTurnRead(reader(0, mine), [has("dht", earlier, mine, earlier)]);
    expect(read).toMatchObject({ result: "mine", conditions: { dht: String(turnSequence(5, 2, 0)) } });
  });

  it("a stored packet that is no valid record is a bug, not a result", async () => {
    const there = await packet(5, 2, 0);
    expect(() => classifyTurnRead(reader(0, junk(5)), [has("a", there)])).toThrow("stored");
  });

  it("a put's answers are counted, none hidden", () => {
    expect(turnPutSummary([{ source: "a", outcome: "stored" }, { source: "b", outcome: "refused" }, { source: "dht", outcome: "failed" }, { source: "c", outcome: "stored" }])).toEqual({ stored: 2, refused: 1, failed: 1 });
  });
});
