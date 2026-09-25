import { concatBytes, utf8Encode } from "./bytes";
import { decodeTxtPacket, encodeTxtPacket, type TxtRecord } from "./dns";
import { publicKeyFromZ32, sign, verify, type Identity } from "./identity";

/** Mainline DHT (BEP44) caps the value of a mutable item at 1000 bytes. */
export const MAX_DNS_PACKET_BYTES = 1000;
const SIGNATURE_LENGTH = 64;
const TIMESTAMP_LENGTH = 8;

/** A label relative to the publisher's key, e.g. `_msgs`. */
export interface GhostRecord {
  label: string;
  value: string;
  ttl?: number;
}

export interface SignedPacket {
  pubKeyZ32: string;
  /** Microseconds since the UNIX epoch; doubles as the BEP44 sequence number. */
  timestampMicros: bigint;
  records: GhostRecord[];
}

export class PacketTooLargeError extends Error {
  constructor(public readonly size: number) {
    super(`DNS packet is too large, expected max ${MAX_DNS_PACKET_BYTES} bytes but got: ${size}`);
  }
}

const DEFAULT_TTL = 300;

function signable(timestampMicros: bigint, dnsPacket: Uint8Array): Uint8Array {
  return concatBytes(utf8Encode(`3:seqi${timestampMicros}e1:v${dnsPacket.length}:`), dnsPacket);
}

function toTxtRecords(pubKeyZ32: string, records: GhostRecord[]): TxtRecord[] {
  return records.map((r) => ({
    name: `${r.label}.${pubKeyZ32}`,
    value: r.value,
    ttl: r.ttl ?? DEFAULT_TTL,
  }));
}

/** Size of the encoded DNS packet these records would produce. */
export function measureRecords(pubKeyZ32: string, records: GhostRecord[]): number {
  return encodeTxtPacket(toTxtRecords(pubKeyZ32, records)).length;
}

/**
 * Builds the payload Pkarr relays accept on `PUT /<z32 public key>`:
 * `<64 bytes signature><8 bytes big-endian timestamp (µs)><encoded DNS packet>`
 */
export function createRelayPayload(
  identity: Identity,
  records: GhostRecord[],
  timestampMicros: bigint = BigInt(Date.now()) * 1000n,
): Uint8Array {
  return signRelayPayload(identity, encodeTxtPacket(toTxtRecords(identity.pubKeyZ32, records)), timestampMicros);
}

/**
 * Signs a DNS packet exactly as given (its own names and flags) into a relay payload. `seq` is the
 * BEP44 sequence number: Ghostly's records use microseconds, a did:dht document seconds.
 */
export function signRelayPayload(identity: Identity, dnsPacket: Uint8Array, seq: bigint): Uint8Array {
  if (dnsPacket.length > MAX_DNS_PACKET_BYTES) throw new PacketTooLargeError(dnsPacket.length);

  const signature = sign(signable(seq, dnsPacket), identity.seed);
  const timestamp = new Uint8Array(TIMESTAMP_LENGTH);
  new DataView(timestamp.buffer).setBigUint64(0, seq);
  return concatBytes(signature, timestamp, dnsPacket);
}

/** Checks a relay payload's size and signature. Returns its sequence number and DNS packet, not decoded. */
export function openRelayPayload(pubKeyZ32: string, payload: Uint8Array): { seq: bigint; dnsPacket: Uint8Array } {
  if (payload.length < SIGNATURE_LENGTH + TIMESTAMP_LENGTH + 12) {
    throw new Error("Relay payload too short");
  }
  if (payload.length > SIGNATURE_LENGTH + TIMESTAMP_LENGTH + MAX_DNS_PACKET_BYTES) {
    throw new PacketTooLargeError(payload.length);
  }
  const publicKey = publicKeyFromZ32(pubKeyZ32);
  const signature = payload.subarray(0, SIGNATURE_LENGTH);
  const seq = new DataView(
    payload.buffer,
    payload.byteOffset + SIGNATURE_LENGTH,
    TIMESTAMP_LENGTH,
  ).getBigUint64(0);
  const dnsPacket = payload.subarray(SIGNATURE_LENGTH + TIMESTAMP_LENGTH);

  if (!verify(signature, signable(seq, dnsPacket), publicKey)) {
    throw new Error("Invalid signature");
  }
  return { seq, dnsPacket };
}

/** Verifies and decodes a relay payload. Throws if the signature does not match. */
export function parseRelayPayload(pubKeyZ32: string, payload: Uint8Array): SignedPacket {
  const { seq: timestampMicros, dnsPacket } = openRelayPayload(pubKeyZ32, payload);
  const suffix = `.${pubKeyZ32}`;
  const records = decodeTxtPacket(dnsPacket).map((r) => ({
    label: r.name.endsWith(suffix) ? r.name.slice(0, -suffix.length) : r.name,
    value: r.value,
    ttl: r.ttl,
  }));
  return { pubKeyZ32, timestampMicros, records };
}
