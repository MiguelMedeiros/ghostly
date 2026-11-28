import { fromBase64, utf8Decode } from "./bytes";
import { parseRelayPayload, RELAY_PAYLOAD_MAX_BYTES, type SignedPacket } from "./pkarr";

/** Maximum number of keys coalesced into one `POST <relay>/batch` request. */
export const BATCH_MAX_KEYS = 64;
/** How long a relay's batch capability (`supported` or `unsupported`) is cached before re-checking. */
export const BATCH_CAPABILITY_TTL_MS = 60 * 60_000;
/** Default coalescing window in ms: 0 flushes on the next microtask with zero timer delay. */
export const BATCH_WINDOW_MS = 0;
/** Per-key response byte budget: a 1,072-byte payload encodes to 1,432 base64 bytes plus key and JSON framing. */
export const BATCH_PER_KEY_MAX_BYTES = 2_048;
/** Fixed envelope byte budget for a batch JSON response. */
export const BATCH_RESPONSE_OVERHEAD_BYTES = 4_096;
/** HTTP statuses showing a relay does not implement `POST /batch` and should fall back to `GET /<key>`. */
export const BATCH_UNSUPPORTED_STATUSES = [404, 405, 501] as const;

const MAX_PACKET_BASE64_LENGTH = Math.ceil(RELAY_PAYLOAD_MAX_BYTES / 3) * 4;
const STANDARD_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type BatchCapabilityState = "supported" | "unsupported" | "unknown";

export type BatchKeyResult =
  | { kind: "packet"; packet: SignedPacket }
  | { kind: "missing" }
  | { kind: "invalid" };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

/** Maximum response size accepted for a batch of `keyCount` keys (`readRelayBody`). */
export function batchResponseMaxBytes(keyCount: number): number {
  return BATCH_RESPONSE_OVERHEAD_BYTES + Math.max(1, keyCount) * BATCH_PER_KEY_MAX_BYTES;
}

/** Whether `status` on `POST <relay>/batch` means the relay only supports single `GET /<key>`. */
export function isBatchUnsupportedStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

/**
 * Encodes a batch GET request body for `POST <relay>/batch`:
 * `{"keys":["<z32>",...]}`.
 */
export function encodeBatchRequest(keys: readonly string[]): string {
  return JSON.stringify({ keys });
}

/**
 * Parses and verifies a `POST <relay>/batch` JSON response body:
 * `{"packets":{"<z32>":"<base64>"|null,...}}`.
 *
 * Throws on malformed JSON or an invalid outer envelope (so the caller treats the relay response as failed).
 * Inside a valid envelope, each requested key is verified independently with `parseRelayPayload`:
 * a missing or `null` entry yields `missing`, a forged/corrupt entry yields `invalid` without poisoning valid siblings,
 * and extra unrequested keys are ignored.
 */
export function parseBatchResponse(keys: readonly string[], body: Uint8Array): Map<string, BatchKeyResult> {
  const parsed: unknown = JSON.parse(utf8Decode(body));
  if (!isPlainObject(parsed) || !hasOwn(parsed, "packets") || !isPlainObject(parsed.packets)) {
    throw new Error("Malformed batch response");
  }
  const packets = parsed.packets;
  const results = new Map<string, BatchKeyResult>();
  for (const key of keys) {
    if (!hasOwn(packets, key) || packets[key] === null) {
      results.set(key, { kind: "missing" });
      continue;
    }
    const raw = packets[key];
    if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PACKET_BASE64_LENGTH || raw.length % 4 === 1 || !STANDARD_BASE64.test(raw)) {
      results.set(key, { kind: "invalid" });
      continue;
    }
    try {
      const bytes = fromBase64(raw);
      results.set(key, { kind: "packet", packet: parseRelayPayload(key, bytes) });
    } catch {
      results.set(key, { kind: "invalid" });
    }
  }
  return results;
}

interface CapabilityEntry {
  supported: boolean;
  recordedAt: number;
  expiresAt: number;
}

/**
 * Per-relay batch capability cache with TTL.
 * Handles backward clock jumps safely by expiring entries recorded after `now`.
 */
export class BatchCapabilityCache {
  private readonly entries = new Map<string, CapabilityEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs = BATCH_CAPABILITY_TTL_MS) {
    this.ttlMs = Math.max(0, ttlMs);
  }

  get(relay: string, now = Date.now()): BatchCapabilityState {
    const entry = this.entries.get(relay);
    if (!entry) return "unknown";
    if (now >= entry.expiresAt || now < entry.recordedAt) {
      this.entries.delete(relay);
      return "unknown";
    }
    return entry.supported ? "supported" : "unsupported";
  }

  mark(relay: string, supported: boolean, now = Date.now()): void {
    if (this.ttlMs === 0) return;
    this.entries.set(relay, { supported, recordedAt: now, expiresAt: now + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }

  prune(keep: ReadonlySet<string>): void {
    for (const relay of this.entries.keys()) {
      if (!keep.has(relay)) this.entries.delete(relay);
    }
  }
}
