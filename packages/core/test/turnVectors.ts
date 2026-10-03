import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  concatBytes, encodeTxtPacket, identityFromSeed, sealTurnBody, sign, signRelayPayload, signTurnRelease, signTurnBody, turnKeys, turnName, turnPacket,
  turnSignedMessage, utf8Encode, TOMBSTONE_SEQUENCE, TOMBSTONE_TURN, TURN_LABEL, TURN_MAX, TURN_NO_ACTIVE, TURN_REV_LIMIT, TURN_SIGNED_BYTES, TURN_TTL,
  type Identity, type TurnFields, type TurnKeys, type TurnRefusal, type TurnSigner,
} from "../src/index";

/*
 * The turn record's test vectors (WISP 06 § Record), built from fixed seeds: Ed25519 signatures are deterministic and
 * the nonce is given, so every byte is. `vectors/turn-record.json` is this file's output, checked in; the TypeScript
 * suite checks the file against what it builds, and the Desktop's Rust suite reads the same file
 * (`apps/desktop/src/turn_record.rs`). Write it again with `TURN_VECTORS_WRITE=1 npx vitest run test/turnRecord.test.ts`.
 */

const seed = (label: string) => sha256(utf8Encode(`ghostly turn vectors: ${label}`));
export const VECTOR_D = seed("device-set secret");
export const vectorKeys = (): TurnKeys => turnKeys(VECTOR_D);
export const DEVICE_NAMES = ["Desktop", "Phone", "Téléphone de l'été 2026", "携帯電話とノートパソコン"];
export const devices = (): (Identity & { name: string })[] => DEVICE_NAMES.map((name, i) => ({ ...identityFromSeed(seed(`device ${i}`)), name: turnName(name) }));
export const signerOf = (identity: Identity): TurnSigner => (bytes) => sign(bytes, identity.seed);
const nonceOf = (label: string) => seed(`nonce ${label}`).subarray(0, 24);
const instanceOf = (label: string) => seed(`instance ${label}`).subarray(0, 8);

export interface RecordVector {
  name: string;
  turn: number; rev: number; author: number; active: number;
  slots: ({ key: string; name: string } | null)[];
  instance: string;
  release: { from: number; to: number; h: string; signature: string } | null;
  nonce: string;
  sequence: string;
  body: string;
  value: string;
  payload: string;
}
export interface InvalidVector { name: string; refusal: TurnRefusal | "foreign"; payload: string }
export interface TurnVectors {
  about: string;
  d: string; turnSeed: string; address: string; addressZ32: string; sealKey: string;
  devices: { seed: string; key: string; name: string }[];
  sequences: { turn: number; rev: number; author: number; sequence: string }[];
  records: RecordVector[];
  invalid: InvalidVector[];
}

interface Plan { name: string; turn: number; rev: number; author: number; active: number; held: number[]; release?: { from: number; to: number } }

const PLANS: Plan[] = [
  { name: "the first record of a device set: one device, no release", turn: 7, rev: 0, author: 0, active: 0, held: [0] },
  { name: "a second device added at a higher rev", turn: 7, rev: 3, author: 0, active: 0, held: [0, 1] },
  { name: "a handoff: the taker's record with the release of the device that was active", turn: 8, rev: 0, author: 1, active: 1, held: [0, 1, 2], release: { from: 0, to: 1 } },
  { name: "four devices, rev ran out: the next turn with a release from the active device to itself", turn: 9, rev: 0, author: 2, active: 2, held: [0, 1, 2, 3], release: { from: 2, to: 2 } },
  { name: "a forced takeover, and slot 0 empty after a removal", turn: 12, rev: 1, author: 3, active: 3, held: [1, 3] },
  { name: "the highest ordinary record", turn: TURN_MAX, rev: TURN_REV_LIMIT - 1, author: 3, active: 3, held: [3] },
  { name: "a tombstone: slot 0 removed, signed by the remover from its own slot", turn: TOMBSTONE_TURN, rev: 0, author: 1, active: TURN_NO_ACTIVE, held: [1, 2] },
];

async function fieldsOf(plan: Plan, keys: TurnKeys): Promise<TurnFields> {
  const all = devices();
  const slots = all.map((device, i) => (plan.held.includes(i) ? { key: device.publicKey, name: device.name } : null));
  const release = plan.release && await signTurnRelease(keys.address, plan.turn, plan.release.from, plan.release.to, all[plan.release.to].publicKey, seed(`state digest ${plan.name}`), signerOf(all[plan.release.from]));
  return { turn: plan.turn, rev: plan.rev, author: plan.author, active: plan.active, slots, instance: instanceOf(plan.name), ...(release ? { release } : {}) };
}

/** A body whose bytes were changed after encoding, signed again by `signer`: what a careless or hostile writer could make. */
function resigned(keys: TurnKeys, body: Uint8Array, signer: Identity, change: (bytes: Uint8Array) => void): Uint8Array {
  const unsigned = body.slice(0, TURN_SIGNED_BYTES);
  change(unsigned);
  return concatBytes(unsigned, sign(turnSignedMessage(keys.address, unsigned), signer.seed));
}

/** A packet for a body the reader would refuse: sealed and signed under the turn key at `sequence`, as a holder of `D` can. */
function rawPacket(keys: TurnKeys, body: Uint8Array, sequence: bigint, nonce: Uint8Array, label = TURN_LABEL): Uint8Array {
  const sealed = body.length === 374 ? sealTurnBody(body, keys.sealKey, nonce) : "AAAA";
  return signRelayPayload(keys.identity, encodeTxtPacket([{ name: `${label}.${keys.identity.pubKeyZ32}`, value: sealed, ttl: TURN_TTL }]), sequence);
}

export async function buildTurnVectors(): Promise<TurnVectors> {
  const keys = vectorKeys();
  const all = devices();
  const records: RecordVector[] = [];
  for (const plan of PLANS) {
    const fields = await fieldsOf(plan, keys);
    const body = await signTurnBody(keys.address, fields, signerOf(all[plan.author]));
    const nonce = nonceOf(plan.name);
    const payload = turnPacket(keys, body, nonce);
    records.push({
      name: plan.name, turn: plan.turn, rev: plan.rev, author: plan.author, active: plan.active,
      slots: fields.slots.map((slot) => slot && { key: bytesToHex(slot.key), name: slot.name }),
      instance: bytesToHex(fields.instance),
      release: fields.release ? { from: fields.release.from, to: fields.release.to, h: bytesToHex(fields.release.h), signature: bytesToHex(fields.release.signature) } : null,
      nonce: bytesToHex(nonce),
      sequence: (plan.turn === TOMBSTONE_TURN ? BigInt(TOMBSTONE_SEQUENCE) : BigInt(plan.turn) * 2n ** 20n + BigInt(plan.rev * 4 + plan.author)).toString(),
      body: bytesToHex(body), value: sealTurnBody(body, keys.sealKey, nonce), payload: bytesToHex(payload),
    });
  }

  // Every refusal of the reader, each as a packet a holder of `D` could put.
  const two = hexToBytes(records[1].body), handoff = hexToBytes(records[2].body), tomb = hexToBytes(records[6].body);
  const twoSequence = BigInt(records[1].sequence), handoffSequence = BigInt(records[2].sequence);
  const invalid: InvalidVector[] = [];
  const add = (name: string, refusal: InvalidVector["refusal"], payload: Uint8Array) => invalid.push({ name, refusal, payload: bytesToHex(payload) });
  const changed = (name: string, refusal: TurnRefusal, base: Uint8Array, signer: number, sequence: bigint, change: (bytes: Uint8Array) => void) =>
    add(name, refusal, rawPacket(keys, resigned(keys, base, all[signer], change), sequence, nonceOf(name)));

  changed("an unknown version", "version", two, 0, twoSequence, (b) => { b[0] = 2; });
  changed("a rev of 2^18", "rev", two, 0, twoSequence, (b) => { b[5] = 4; });
  changed("an author past the last slot", "author", two, 0, twoSequence, (b) => { b[8] = 4; });
  changed("an author whose slot is empty", "author", two, 0, twoSequence, (b) => { b[8] = 2; });
  changed("an active device past the last slot", "active", two, 0, twoSequence, (b) => { b[9] = 9; });
  changed("an active device whose slot is empty", "active", two, 0, twoSequence, (b) => { b[9] = 3; });
  changed("a device count that is not the number of slots held", "count", two, 0, twoSequence, (b) => { b[10] = 3; });
  changed("a device count over four", "count", two, 0, twoSequence, (b) => { b[10] = 5; });
  changed("a name in a slot with no key", "slots", two, 0, twoSequence, (b) => { b[11 + 2 * 48 + 32] = 0x41; });
  changed("one key in two slots", "slots", two, 0, twoSequence, (b) => { b.set(b.subarray(11, 11 + 32), 11 + 48); });
  changed("a name with bytes after its padding began", "name", two, 0, twoSequence, (b) => { b[11 + 32 + 15] = 0x41; });
  changed("a name that is not UTF-8", "name", two, 0, twoSequence, (b) => { b[11 + 32] = 0xff; });
  changed("an ordinary record that names no active device", "tombstone", two, 0, twoSequence, (b) => { b[9] = TURN_NO_ACTIVE; });
  changed("a tombstone that names an active device", "tombstone", tomb, 1, BigInt(TOMBSTONE_SEQUENCE), (b) => { b[9] = 1; });
  changed("a tombstone with a release", "tombstone", tomb, 1, BigInt(TOMBSTONE_SEQUENCE), (b) => { b[211] = 1; b[212] = 1; b[213] = 1; });
  changed("written by a device other than the one it names active", "author-not-active", two, 0, twoSequence, (b) => { b[9] = 1; });
  changed("a slot added by another device under the active device's turn", "author-not-active", two, 1, twoSequence + 4n + 1n, (b) => { b[7] = 4; b[8] = 1; });
  changed("signed by a key that is not in the author's slot", "signature", two, 1, twoSequence, () => {});
  changed("release bytes without the release flag", "release-layout", two, 0, twoSequence, (b) => { b[214] = 1; });
  changed("a release flag that is neither 0 nor 1", "release-layout", handoff, 1, handoffSequence, (b) => { b[211] = 2; });
  changed("a release from a slot that is empty", "release-layout", handoff, 1, handoffSequence, (b) => { b[212] = 3; });
  changed("a release to another device than the active one", "release", handoff, 1, handoffSequence, (b) => { b[213] = 2; });
  changed("a release whose signature does not verify", "release", handoff, 1, handoffSequence, (b) => { b[246] ^= 1; });
  changed("a release signed for another turn", "release", handoff, 1, handoffSequence + 2n ** 20n, (b) => { b[4] += 1; });
  add("a body of the wrong length", "seal", rawPacket(keys, two.subarray(0, 373), twoSequence, nonceOf("short")));
  add("a packet at a sequence that is not the formula's", "sequence", rawPacket(keys, two, twoSequence + 4n, nonceOf("sequence")));
  add("an ordinary record put at the tombstone's sequence", "sequence", rawPacket(keys, two, BigInt(TOMBSTONE_SEQUENCE), nonceOf("high")));
  add("sealed under another key", "seal", rawPacket({ ...keys, sealKey: seed("another seal key") }, two, twoSequence, nonceOf("seal")));
  add("under another label", "label", rawPacket(keys, two, twoSequence, nonceOf("label"), "_t"));
  const forged = rawPacket(keys, two, twoSequence, nonceOf("forged"));
  forged[70] ^= 1;
  add("a packet whose BEP44 signature does not verify", "foreign", forged);

  // The DNS packet around the value: one TXT answer and nothing else.
  const sealedTwo = sealTurnBody(two, keys.sealKey, nonceOf("dns"));
  const txt = { name: `${TURN_LABEL}.${keys.identity.pubKeyZ32}`, value: sealedTwo, ttl: TURN_TTL };
  const dns = encodeTxtPacket([txt]);
  const signed = (packet: Uint8Array, sequence = twoSequence) => signRelayPayload(keys.identity, packet, sequence);
  add("a second record beside the TXT one (a name server)", "label", signed(encodeTxtPacket([txt, { type: "NS", name: keys.identity.pubKeyZ32, host: "ns.example", ttl: 300 }])));
  add("a second TXT record under another name", "label", signed(encodeTxtPacket([txt, { name: `_t.${keys.identity.pubKeyZ32}`, value: "x", ttl: 300 }])));
  add("a byte after the TXT record", "label", signed(concatBytes(dns, Uint8Array.of(0))));
  const withAdditional = concatBytes(dns, Uint8Array.of(0, 0, 16, 0, 1, 0, 0, 0, 0, 0, 1, 0));
  withAdditional[11] = 1;
  add("a record in the additional section", "label", signed(withAdditional));
  add("a tombstone below the tombstone's sequence", "sequence", rawPacket(keys, tomb, BigInt(TOMBSTONE_SEQUENCE) - 1n, nonceOf("low tombstone")));
  changed("a release from slot 4", "release-layout", handoff, 1, handoffSequence, (b) => { b[212] = 4; });
  changed("a release to slot 5", "release-layout", handoff, 1, handoffSequence, (b) => { b[213] = 5; });
  // Over the 1000 bytes a DHT node takes for a value: no node stores it, so it is no packet at all.
  const oversize = encodeTxtPacket([txt, { name: `_t.${keys.identity.pubKeyZ32}`, value: "x".repeat(400), ttl: 300 }]);
  const bencoded = concatBytes(utf8Encode(`3:seqi${twoSequence}e1:v${oversize.length}:`), oversize);
  const seq = new Uint8Array(8);
  new DataView(seq.buffer).setBigUint64(0, twoSequence);
  add("a DNS packet over 1000 bytes", "foreign", concatBytes(sign(bencoded, keys.identity.seed), seq, oversize));

  return {
    about: "Test vectors of the turn record (WISP 06, The turn, Record). Built by packages/core/test/turnVectors.ts; read by the TypeScript and the Rust suites. Bytes are hex; `value` is the TXT value (base64url); `payload` is the relay payload (signature, sequence, DNS packet).",
    d: bytesToHex(VECTOR_D), turnSeed: bytesToHex(keys.identity.seed), address: bytesToHex(keys.address), addressZ32: keys.identity.pubKeyZ32, sealKey: bytesToHex(keys.sealKey),
    devices: all.map((device) => ({ seed: bytesToHex(device.seed), key: bytesToHex(device.publicKey), name: device.name })),
    sequences: [[0, 0, 0], [0, 0, 3], [0, 1, 0], [1, 0, 0], [7, 3, 0], [2 ** 29, 5, 2], [TURN_MAX, TURN_REV_LIMIT - 1, 3]].map(([turn, rev, author]) =>
      ({ turn, rev, author, sequence: (BigInt(turn) * 2n ** 20n + BigInt(rev * 4 + author)).toString() })),
    records, invalid,
  };
}
