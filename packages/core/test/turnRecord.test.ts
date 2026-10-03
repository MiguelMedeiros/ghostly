import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import {
  createRelayPayload, firstDeviceSetSecret, fromBase64Url, signRelayPayload, identityFromSeed, measureRecords, nextTurnPosition, openTurnValue, readTurnBody, readTurnPacket, sealTurnBody, signTurnBody,
  signTurnPacket, turnKeys, turnName, turnPacket, turnPayloadSequence, turnSequence, utf8Encode, MAX_DNS_PACKET_BYTES, TOMBSTONE_SEQUENCE, TOMBSTONE_TURN,
  TURN_BODY_BYTES, TURN_LABEL, TURN_MAX, TURN_NO_ACTIVE, TURN_REV_LIMIT, TURN_SEALED_BYTES, TurnRecordError, type TurnFields,
} from "../src/index";
import { buildTurnVectors, devices, signerOf, vectorKeys, VECTOR_D, type TurnVectors } from "./turnVectors";
// covers: devices.turn.record

const FILE = fileURLToPath(new URL("./vectors/turn-record.json", import.meta.url));

describe("the turn record's test vectors", () => {
  it("the checked-in file is what this code builds, byte for byte", async () => {
    const built = `${JSON.stringify(await buildTurnVectors(), null, 2)}\n`;
    if (process.env.TURN_VECTORS_WRITE) writeFileSync(FILE, built);
    expect(existsSync(FILE), "write it with TURN_VECTORS_WRITE=1").toBe(true);
    expect(readFileSync(FILE, "utf8")).toBe(built);
  });

  const vectors = (): TurnVectors => JSON.parse(readFileSync(FILE, "utf8")) as TurnVectors;

  it("the keys come from the device-set secret", () => {
    const v = vectors(), keys = turnKeys(hexToBytes(v.d));
    const salt = utf8Encode("ghostly-devices/1");
    expect(bytesToHex(keys.identity.seed)).toBe(bytesToHex(hkdf(sha256, VECTOR_D, salt, utf8Encode("turn"), 32)));
    expect(bytesToHex(keys.identity.seed)).toBe(v.turnSeed);
    expect(bytesToHex(keys.address)).toBe(v.address);
    expect(keys.identity.pubKeyZ32).toBe(v.addressZ32);
    expect(bytesToHex(keys.sealKey)).toBe(v.sealKey);
    expect(bytesToHex(keys.sealKey)).toBe(bytesToHex(hkdf(sha256, VECTOR_D, salt, utf8Encode("turn-seal"), 32)));
    // The first secret of a profile is derived from its DID seed, and is not the seed.
    const did = sha256(utf8Encode("a DID seed"));
    expect(bytesToHex(firstDeviceSetSecret(did))).toBe(bytesToHex(hkdf(sha256, did, salt, utf8Encode("device-set"), 32)));
    expect(() => turnKeys(new Uint8Array(31))).toThrow();
  });

  it("every record reads back as what was written, at the formula's sequence", () => {
    const v = vectors(), keys = turnKeys(hexToBytes(v.d));
    for (const vector of v.records) {
      const payload = hexToBytes(vector.payload), body = hexToBytes(vector.body);
      expect(body.length, vector.name).toBe(TURN_BODY_BYTES);
      expect(bytesToHex(openTurnValue(vector.value, keys.sealKey)!), vector.name).toBe(vector.body);
      expect(sealTurnBody(body, keys.sealKey, hexToBytes(vector.nonce)), vector.name).toBe(vector.value);
      expect(bytesToHex(turnPacket(keys, body, hexToBytes(vector.nonce))), vector.name).toBe(vector.payload);
      const read = readTurnPacket(keys, payload);
      if (read.kind !== "valid") throw new Error(`${vector.name}: ${read.kind}`);
      const record = read.record;
      expect(read.sequence.toString(), vector.name).toBe(vector.sequence);
      expect(turnPayloadSequence(payload)!.toString()).toBe(vector.sequence);
      expect({ turn: record.turn, rev: record.rev, author: record.author, active: record.active }).toEqual({ turn: vector.turn, rev: vector.rev, author: vector.author, active: vector.active });
      expect(record.slots.map((slot) => slot && { key: bytesToHex(slot.key), name: slot.name })).toEqual(vector.slots);
      expect(bytesToHex(record.instance)).toBe(vector.instance);
      expect(record.release ? { from: record.release.from, to: record.release.to, h: bytesToHex(record.release.h), signature: bytesToHex(record.release.signature) } : null).toEqual(vector.release);
      expect(record.tombstone).toBe(vector.turn === TOMBSTONE_TURN);
      if (!record.tombstone) expect(record.sequence).toBe(turnSequence(vector.turn, vector.rev, vector.author));
    }
    const tombstone = v.records.at(-1)!;
    expect(tombstone.sequence).toBe(String(2 ** 52 - 1));
    expect(tombstone.active).toBe(TURN_NO_ACTIVE);
  });

  it("the reader refuses every invalid packet, each for its own rule", () => {
    const v = vectors(), keys = turnKeys(hexToBytes(v.d));
    const refusals = new Set<string>();
    for (const vector of v.invalid) {
      const read = readTurnPacket(keys, hexToBytes(vector.payload));
      expect(read.kind === "invalid" ? read.refusal : read.kind, vector.name).toBe(vector.refusal);
      refusals.add(vector.refusal);
      // A packet a node would store counts as seen, whatever it holds; one that is no packet does not.
      if (read.kind === "invalid") expect(read.sequence).toBe(turnPayloadSequence(hexToBytes(vector.payload)));
    }
    for (const refusal of ["foreign", "label", "seal", "version", "rev", "author", "active", "count", "slots", "name", "release-layout", "tombstone", "author-not-active", "signature", "release", "sequence"]) {
      expect(refusals.has(refusal), refusal).toBe(true);
    }
  });

  it("the sequence formula and its bounds", () => {
    for (const { turn, rev, author, sequence } of vectors().sequences) expect(String(turnSequence(turn, rev, author))).toBe(sequence);
    // The slot is in the low bits: two devices never sign an equal sequence, whatever they race on.
    expect(new Set([0, 1, 2, 3].map((author) => turnSequence(5, 9, author))).size).toBe(4);
    expect(turnSequence(5, 0, 0)).toBeGreaterThan(turnSequence(4, TURN_REV_LIMIT - 1, 3));
    // The highest ordinary record stays under the one sequence of every tombstone, which is exact in JavaScript.
    expect(turnSequence(TURN_MAX, TURN_REV_LIMIT - 1, 3)).toBeLessThan(TOMBSTONE_SEQUENCE);
    expect(Number.isSafeInteger(TOMBSTONE_SEQUENCE)).toBe(true);
    // A first turn is random under 2^29: under today's clock in microseconds.
    expect(turnSequence(2 ** 29 - 1, TURN_REV_LIMIT - 1, 3)).toBeLessThan(Date.now() * 1000);
    expect(() => turnSequence(TOMBSTONE_TURN, 0, 0)).toThrow();
    expect(() => turnSequence(1, TURN_REV_LIMIT, 0)).toThrow();
    expect(() => turnSequence(1, 0, 4)).toThrow();
    expect(() => turnSequence(1.5, 0, 0)).toThrow();
  });
});

describe("the turn record", () => {
  const keys = vectorKeys(), all = devices();
  const fields = (extra: Partial<TurnFields> = {}): TurnFields => ({
    turn: 40, rev: 0, author: 0, active: 0, slots: [{ key: all[0].publicKey, name: all[0].name }, null, null, null], instance: new Uint8Array(8).fill(7), ...extra,
  });

  it("has one size whatever it holds, and fits a Pkarr packet", async () => {
    const sizes = new Set<number>();
    for (let held = 1; held <= 4; held++) {
      const slots = all.map((device, i) => (i < held ? { key: device.publicKey, name: device.name } : null));
      const payload = await signTurnPacket(keys, fields({ slots }), signerOf(all[0]));
      sizes.add(payload.length);
    }
    expect([...sizes]).toEqual([64 + 8 + measureRecords(keys.identity.pubKeyZ32, [{ label: TURN_LABEL, value: "A".repeat(552) }])]);
    expect(TURN_SEALED_BYTES).toBe(414);
    expect([...sizes][0] - 72).toBeLessThan(MAX_DNS_PACKET_BYTES);
  });

  it("is sealed: a fresh nonce makes other bytes, which is why a packet is stored and put unchanged", async () => {
    const body = await signTurnBody(keys.address, fields(), signerOf(all[0]));
    const a = turnPacket(keys, body), b = turnPacket(keys, body);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
    expect(readTurnPacket(keys, a).kind).toBe("valid");
    expect(readTurnPacket(keys, b).kind).toBe("valid");
    // Another device set cannot read it, nor tell what it is beyond its label and size.
    expect(readTurnPacket(turnKeys(new Uint8Array(32).fill(1)), a).kind).toBe("foreign");
  });

  it("an unknown signer is accepted: a holder of D that names itself active (a forced takeover)", async () => {
    const stranger = identityFromSeed(new Uint8Array(32).fill(9));
    const payload = await signTurnPacket(keys, fields({ turn: 41, author: 1, active: 1, slots: [{ key: all[0].publicKey, name: "Desktop" }, { key: stranger.publicKey, name: "Restored" }, null, null] }), signerOf(stranger));
    const read = readTurnPacket(keys, payload);
    expect(read.kind).toBe("valid");
    if (read.kind === "valid") expect(read.record.release).toBeUndefined();
  });

  it("refuses to write what no reader would accept", async () => {
    const sign = signerOf(all[0]);
    await expect(signTurnBody(keys.address, fields({ author: 1 }), sign)).rejects.toThrow("author");
    await expect(signTurnBody(keys.address, fields({ active: TURN_NO_ACTIVE }), sign)).rejects.toThrow("active");
    await expect(signTurnBody(keys.address, fields({ turn: TOMBSTONE_TURN }), sign)).rejects.toThrow("tombstone");
    await expect(signTurnBody(keys.address, fields({ rev: TURN_REV_LIMIT }), sign)).rejects.toThrow("rev");
    await expect(signTurnBody(keys.address, fields({ instance: new Uint8Array(7) }), sign)).rejects.toThrow("instance");
    await expect(signTurnBody(keys.address, fields({ slots: [{ key: all[0].publicKey, name: "a name of more than sixteen bytes" }, null, null, null] }), sign)).rejects.toThrow("16 bytes");
    // Written by a device other than the one it names active: encodable, and refused by `turnPacket`'s own read.
    const two = [{ key: all[0].publicKey, name: "A" }, { key: all[1].publicKey, name: "B" }, null, null];
    await expect(signTurnPacket(keys, fields({ slots: two, active: 1 }), sign)).rejects.toThrow(TurnRecordError);
    expect(() => readTurnBody(new Uint8Array(373), keys.address)).toThrow(TurnRecordError);
  });

  it("cuts a name at a character boundary, at 16 bytes", () => {
    expect(turnName("Desktop")).toBe("Desktop");
    expect(turnName("Téléphone de l'été 2026")).toBe("Téléphone de l");
    expect(utf8Encode(turnName("携帯電話とノートパソコン")).length).toBe(15);
    expect(turnName("a\0b")).toBe("ab");
    // A character is a whole one: a family of four (25 bytes) does not fit, and is not cut into two people.
    expect(turnName("👩‍👩‍👧‍👧 family")).toBe("");
    expect(turnName("Ana 👩‍👩‍👧‍👧")).toBe("Ana ");
  });

  it("is read whatever way its writer cut the TXT value into DNS strings: the Desktop's Rust cuts at 254, this code at 255", async () => {
    const body = await signTurnBody(keys.address, fields(), signerOf(all[0]));
    const value = sealTurnBody(body, keys.sealKey);
    // The DNS packet by hand: header, one answer, the name, TXT, class IN, TTL, and the value in strings of `size`.
    const packetCutAt = (size: number): Uint8Array => {
      const name = [TURN_LABEL, keys.identity.pubKeyZ32].flatMap((label) => [label.length, ...utf8Encode(label)]);
      const strings: number[] = [];
      for (let at = 0; at < value.length; at += size) { const part = utf8Encode(value.slice(at, at + size)); strings.push(part.length, ...part); }
      return Uint8Array.from([0, 0, 0x80, 0, 0, 0, 0, 1, 0, 0, 0, 0, ...name, 0, 0, 16, 0, 1, 0, 0, 1, 44, strings.length >> 8, strings.length & 0xff, ...strings]);
    };
    const sequence = BigInt(turnSequence(40, 0, 0));
    for (const size of [255, 254, 100]) {
      const read = readTurnPacket(keys, signRelayPayload(keys.identity, packetCutAt(size), sequence));
      expect(read.kind, `strings of ${size}`).toBe("valid");
    }
    // The same size on the wire either way.
    expect(packetCutAt(254).length).toBe(packetCutAt(255).length);
    expect(bytesToHex(signRelayPayload(keys.identity, packetCutAt(255), sequence).subarray(72))).toBe(bytesToHex(turnPacket(keys, body, fromBase64Url(value).subarray(0, 24)).subarray(72)));
  });

  it("is not a chat packet: nothing dated by the clock reads as a turn record", () => {
    const chat = createRelayPayload(keys.identity, [{ label: "_msgs", value: "hello" }]);
    const read = readTurnPacket(keys, chat);
    expect(read.kind === "invalid" && read.refusal).toBe("label");
  });
});

describe("the next record's place", () => {
  it("is rev plus one in the same turn, and rev 0 in a new one", () => {
    expect(nextTurnPosition(10, 4, 1, 0)).toEqual({ turn: 10, rev: 5, raised: false });
    expect(nextTurnPosition(11, null, 1, turnSequence(10, 5, 1))).toEqual({ turn: 11, rev: 0, raised: false });
  });

  it("is above the highest raw sequence ever seen, valid or not, so an invalid record with a high rev blocks no put", () => {
    const seen = turnSequence(10, 900, 3);
    for (const author of [0, 1, 2, 3]) {
      const next = nextTurnPosition(10, 4, author, seen)!;
      expect(next.turn).toBe(10);
      expect(turnSequence(next.turn, next.rev, author)).toBeGreaterThan(seen);
      // And the lowest such place in its slot.
      expect(turnSequence(next.turn, next.rev, author) - seen).toBeLessThanOrEqual(4);
    }
    expect(nextTurnPosition(10, 4, 3, turnSequence(10, 900, 3))).toEqual({ turn: 10, rev: 901, raised: false });
    expect(nextTurnPosition(10, 4, 0, turnSequence(10, 900, 3))).toEqual({ turn: 10, rev: 901, raised: false });
    expect(nextTurnPosition(10, 4, 3, turnSequence(10, 900, 0))).toEqual({ turn: 10, rev: 900, raised: false });
  });

  it("is the next turn when rev runs out or something was seen above this turn", () => {
    expect(nextTurnPosition(10, TURN_REV_LIMIT - 1, 2, 0)).toEqual({ turn: 11, rev: 0, raised: true });
    expect(nextTurnPosition(10, 4, 2, turnSequence(10, TURN_REV_LIMIT - 1, 3))).toEqual({ turn: 11, rev: 0, raised: true });
    expect(nextTurnPosition(10, 4, 2, turnSequence(14, 2, 1))).toEqual({ turn: 14, rev: 2, raised: true });
  });

  it("is nowhere once the address holds the tombstone's sequence or the last turn is spent", () => {
    expect(nextTurnPosition(10, 4, 2, TOMBSTONE_SEQUENCE)).toBeNull();
    expect(nextTurnPosition(10, 4, 2, 2n ** 60n)).toBeNull();
    expect(nextTurnPosition(TURN_MAX, TURN_REV_LIMIT - 1, 2, 0)).toBeNull();
    expect(nextTurnPosition(TURN_MAX, TURN_REV_LIMIT - 2, 2, 0)).toEqual({ turn: TURN_MAX, rev: TURN_REV_LIMIT - 1, raised: false });
  });
});
