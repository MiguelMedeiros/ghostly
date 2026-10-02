import { describe, expect, it } from "vitest";
import {
  classifyTurnRead, identityFromSeed, keptAtEqualSequence, readTurnPacket, signRelayPayload, signTurnPacket, signTurnRelease, turnPutSummary, turnSequence,
  encodeTxtPacket, TURN_LAST_SEQUENCE, TURN_PUT_WINDOW_MS, TURN_RAISE_READ_TIMEOUT_MS, TURN_SETTLE_MS, TURN_VISIBLE_MS, TOMBSTONE_SEQUENCE, TOMBSTONE_TURN, TURN_NO_ACTIVE, type Identity, type TurnFields, type TurnReader, type TurnSourceAnswer,
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
    expect(classifyTurnRead(reader(0, mine), [has("a", mine), has("b", closed)])).toMatchObject({ result: "tombstone", listed: false, good: true, seen: BigInt(TOMBSTONE_SEQUENCE) });
    expect(classifyTurnRead(reader(2, mine), [has("a", closed)])).toMatchObject({ result: "tombstone", listed: true });
    // A tombstone is never outranked, by a taker either.
    expect(classifyTurnRead(reader(2, await packet(6, 0, 2), { taking: 6 }), [has("a", closed), has("b", await packet(6, 0, 1))]).result).toBe("tombstone");
  });

  it("none: sources answered and none has a record", async () => {
    expect(classifyTurnRead(reader(0, await packet(5, 2, 0)), [has("a"), has("b")])).toMatchObject({ result: "none", good: true, seen: 0n });
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
    // Not `mine`: something this device saw verified is above its record. It must write above it.
    expect(read).toMatchObject({ result: "behind", seen: BigInt(high) });
    expect(read.invalid).toEqual([{ source: "b", sequence: BigInt(high), refusal: "seal" }]);
    expect(read.conditions).toEqual({ a: String(turnSequence(5, 2, 0)), b: String(high) });
    // Only the invalid packet is left on the sources: no record, and the next put must go above it.
    expect(classifyTurnRead(reader(0, mine), [has("a", junk(high))])).toMatchObject({ result: "none", seen: BigInt(high) });
  });

  it("a number a source names without a signed packet cannot close the address or raise the turn", async () => {
    const mine = await packet(5, 2, 0);
    // A relay's 404 header says the DHT holds an item that is no signed packet, at the tombstone's sequence.
    const closing: TurnSourceAnswer = { source: "a", answered: true, payloads: [], sequences: [String(TOMBSTONE_SEQUENCE)] };
    const read = classifyTurnRead(reader(0, mine), [closing, has("b", mine)]);
    expect(read).toMatchObject({ result: "mine", good: true, seen: BigInt(turnSequence(5, 2, 0)), invalid: [] });
    expect(read.unsigned).toEqual([{ source: "a", sequence: BigInt(TOMBSTONE_SEQUENCE) }]);
    // It is that source's condition, so a put there names it, and nothing else.
    expect(read.conditions).toEqual({ a: String(TOMBSTONE_SEQUENCE), b: String(turnSequence(5, 2, 0)) });
    // At a later turn: no writer's place moves.
    const raising: TurnSourceAnswer = { source: "a", answered: true, payloads: [], sequences: [String(turnSequence(45, 0, 0))] };
    expect(classifyTurnRead(reader(0, mine), [raising])).toMatchObject({ result: "none", seen: 0n, good: true });
    // Text that is no number is dropped.
    expect(classifyTurnRead(reader(0, mine), [{ source: "a", answered: true, payloads: [], sequences: ["-1", "1e9", "x"] }]).conditions).toEqual({ a: null });
  });

  it("a stale answer (a relay asked plainly, from its cache) shows a newer record, and never makes mine or none", async () => {
    const mine = await packet(5, 2, 0), newer = await packet(6, 0, 1);
    const stale = (source: string, ...payloads: Uint8Array[]): TurnSourceAnswer => ({ source, answered: true, payloads, stale: true });
    expect(classifyTurnRead(reader(0, mine), [stale("a", mine)])).toMatchObject({ result: "unreachable", good: false });
    expect(classifyTurnRead(reader(0, mine), [stale("a")])).toMatchObject({ result: "unreachable", good: false });
    // With a fresh source that does not hold it: not `mine`, and the fresh one is put to again.
    expect(classifyTurnRead(reader(0, mine), [stale("a", mine), has("b")])).toMatchObject({ result: "behind", good: true });
    expect(classifyTurnRead(reader(0, mine), [stale("a", mine), has("b", mine)])).toMatchObject({ result: "mine", good: true });
    // Bad news is news whoever brings it.
    expect(classifyTurnRead(reader(0, mine), [stale("a", newer), has("b", mine)])).toMatchObject({ result: "other" });
    expect(classifyTurnRead(reader(0, mine), [stale("a", newer)])).toMatchObject({ result: "other", good: false });
  });

  it("a packet that is not under the turn key counts for nothing", async () => {
    const mine = await packet(5, 2, 0);
    const forged = junk(2n ** 51n);
    forged[3] ^= 1;
    expect(classifyTurnRead(reader(0, mine), [has("a", forged, mine)])).toMatchObject({ result: "mine", seen: BigInt(turnSequence(5, 2, 0)), invalid: [] });
    expect(classifyTurnRead(reader(0, mine), [has("a", new Uint8Array(10))])).toMatchObject({ result: "none", conditions: { a: null } });
  });

  it("closed: a packet under the turn key at or above the tombstone's sequence that is no tombstone, and never a good read", async () => {
    const mine = await packet(5, 2, 0);
    expect(classifyTurnRead(reader(0, mine), [has("a", mine), has("b", junk(TOMBSTONE_SEQUENCE))])).toMatchObject({ result: "closed", good: false });
    expect(classifyTurnRead(reader(0, mine), [has("b", junk(2n ** 62n))])).toMatchObject({ result: "closed", good: false, seen: 2n ** 62n });
    expect(classifyTurnRead(reader(1, null), [has("b", junk(TOMBSTONE_SEQUENCE))]).result).toBe("closed");
    // A valid tombstone at that sequence is a tombstone; something above it closes the address all the same.
    const closed = await tombstone(1, [1, 2]);
    expect(classifyTurnRead(reader(0, mine), [has("a", closed), has("b", junk(TOMBSTONE_SEQUENCE))]).result).toBe("tombstone");
    expect(classifyTurnRead(reader(0, mine), [has("a", closed), has("b", junk(TOMBSTONE_SEQUENCE + 1))]).result).toBe("closed");
    // Anything above the last sequence an ordinary record can have closes it too: nothing could be written above it.
    expect(TURN_LAST_SEQUENCE).toBe(turnSequence(2 ** 32 - 2, 2 ** 18 - 1, 3));
    expect(TURN_LAST_SEQUENCE).toBe(2 ** 52 - 2 ** 20 - 1);
    for (const sequence of [TOMBSTONE_SEQUENCE - 1, TOMBSTONE_SEQUENCE - 5, TURN_LAST_SEQUENCE + 1]) {
      expect(classifyTurnRead(reader(0, mine), [has("a", mine), has("b", junk(sequence))]), String(sequence)).toMatchObject({ result: "closed", good: false });
    }
    // At the last ordinary sequence the address is open: an invalid packet, and the device's record under it.
    expect(classifyTurnRead(reader(0, mine), [has("a", mine), has("b", junk(TURN_LAST_SEQUENCE))]).result).toBe("behind");
    // A valid tombstone wins over junk just under it.
    expect(classifyTurnRead(reader(0, mine), [has("a", closed), has("b", junk(TOMBSTONE_SEQUENCE - 5))]).result).toBe("tombstone");
  });

  it("the mark: a record below the highest sequence this device ever saw verified is no news", async () => {
    const mine = await packet(5, 2, 0), newer = await packet(6, 0, 1);
    const mark = BigInt(turnSequence(6, 0, 1));
    // A superseded device whose own record comes back after the newer one expired: not `mine`.
    expect(classifyTurnRead(reader(0, mine, { seen: mark }), [has("a", mine)])).toMatchObject({ result: "behind", good: true });
    // A record between its own and the mark is no news either.
    expect(classifyTurnRead(reader(0, mine, { seen: mark }), [has("a", await packet(5, 9, 1))]).result).toBe("behind");
    // The record at the mark, and one above it, are.
    expect(classifyTurnRead(reader(0, mine, { seen: mark }), [has("a", newer)]).result).toBe("other");
    expect(classifyTurnRead(reader(0, mine, { seen: mark }), [has("a", await packet(7, 0, 2))]).result).toBe("other");
    // A standby that accepted the newer record and is shown the older one again.
    expect(classifyTurnRead(reader(2, mine, { seen: mark }), [has("a", mine)]).result).toBe("behind");
    expect(classifyTurnRead(reader(2, newer, { seen: mark }), [has("a", newer)])).toMatchObject({ result: "other", known: true });
    // With a mark at its own record, its own record is `mine`.
    expect(classifyTurnRead(reader(0, mine, { seen: BigInt(turnSequence(5, 2, 0)) }), [has("a", mine)]).result).toBe("mine");
  });

  it("a reader that holds no record of the set yet takes the first valid one as current, and shows no takeover for it", async () => {
    const first = await packet(5, 0, 0);
    expect(classifyTurnRead(reader(1, null), [has("a", first)])).toMatchObject({ result: "other", forced: false });
    // Once it holds one, a record with no release above it is a takeover.
    expect(classifyTurnRead(reader(1, first), [has("a", await packet(6, 0, 2))])).toMatchObject({ result: "other", forced: true });
  });

  it("the settle constants: T is at least P plus twice V", () => {
    expect([TURN_PUT_WINDOW_MS, TURN_VISIBLE_MS, TURN_SETTLE_MS]).toEqual([10_000, 10_000, 30_000]);
    expect(TURN_SETTLE_MS).toBeGreaterThanOrEqual(TURN_PUT_WINDOW_MS + 2 * TURN_VISIBLE_MS);
    // The read a raising put acts on leaves half of P to sign, store and send.
    expect(TURN_PUT_WINDOW_MS - TURN_RAISE_READ_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
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
