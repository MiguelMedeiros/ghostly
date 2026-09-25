import { encrypt, tryDecrypt } from "./crypto";
import { MAX_DNS_PACKET_BYTES, measureRecords, type GhostRecord, type SignedPacket } from "./pkarr";
import { decodeServices, encodeServices, type ServiceAd } from "./services";
import { sanitizeNick } from "./text";

/**
 * TXT labels a peer publishes under its own key. Every value except `_ts` and
 * `_ack` is secretbox-encrypted with the link key.
 *
 * `_msgs`, `_ts`, `_ack`, `_nick` and `_call` are the original Ghost protocol.
 * `_svc` and `_rtc` are additive: clients that predate them ignore unknown
 * labels, so old and new peers keep chatting and calling each other.
 */
export const LABEL = {
  msgs: "_msgs",
  ts: "_ts",
  ack: "_ack",
  nick: "_nick",
  call: "_call",
  /** Service advertisement, see `services.ts`. */
  svc: "_svc",
  /** Signaling for the WebRTC data link, see `signal.ts`. */
  rtc: "_rtc",
} as const;

export const RECORD_TTL = 300;
/** Same ceiling the Rust implementation applies to the encrypted message batch. */
export const MAX_MSGS_PAYLOAD_B64 = 800;
const MAX_SINGLE_MESSAGE_CHARS = 400;

export interface CompactMessage {
  t: number;
  m: string;
}

export interface OutgoingLinkState {
  messages: CompactMessage[];
  ackTimestamp: number;
  nick?: string;
  callSignal?: string | null;
  rtcSignal?: string | null;
  /** `undefined` publishes no `_svc` at all, which is what a legacy peer looks like. */
  services?: ServiceAd[];
}

export interface BuiltLinkRecords {
  records: GhostRecord[];
  /** How many of the newest messages made it into the packet. */
  keptMessages: number;
  /** False when the advertisement had to be left out to fit the packet. */
  servicesIncluded: boolean;
}

function record(label: string, value: string): GhostRecord {
  return { label, value, ttl: RECORD_TTL };
}

/**
 * The packet an inviter puts under the contact's key before they join, so that their first packet lands
 * as a newer one under a key the network already knows (seconds faster than a first packet under a
 * fresh key). It carries no message record, which every link session's own packet does, even empty:
 * that is how a reader tells it from a contact who is here (or was, and left without a word).
 */
export function emptyLinkRecords(): GhostRecord[] {
  return [record(LABEL.ts, "0")];
}

/** A packet nobody's link session published (see `emptyLinkRecords`): read as no packet at all. */
export function isEmptyLinkPacket(batch: ResolvedLink): boolean {
  return !batch.rawRecordNames.includes(LABEL.msgs);
}

/**
 * Builds the records for one publish. A Pkarr packet is at most 1000 bytes, so
 * space is handed out by priority: signaling first (it is what gets peers onto
 * WebRTC, where there is no such limit), then the service advertisement, then
 * as many of the newest messages as still fit.
 */
export function buildLinkRecords(
  pubKeyZ32: string,
  state: OutgoingLinkState,
  encKey: Uint8Array,
): BuiltLinkRecords {
  const sorted = [...state.messages].sort((a, b) => a.t - b.t);
  const latestTs = sorted.length > 0 ? sorted[sorted.length - 1].t : 0;

  const fixed: GhostRecord[] = [record(LABEL.ts, String(latestTs))];
  if (state.ackTimestamp > 0) fixed.push(record(LABEL.ack, String(state.ackTimestamp)));
  if (state.nick) fixed.push(record(LABEL.nick, encrypt(state.nick, encKey)));
  if (state.callSignal) fixed.push(record(LABEL.call, encrypt(state.callSignal, encKey)));
  if (state.rtcSignal) fixed.push(record(LABEL.rtc, encrypt(state.rtcSignal, encKey)));

  const svc = state.services ? record(LABEL.svc, encrypt(encodeServices(state.services), encKey)) : null;

  const attempt = (withServices: boolean): BuiltLinkRecords | null => {
    const base = withServices && svc ? [...fixed, svc] : fixed;
    const batch = [...sorted];
    for (;;) {
      let payload = encrypt(JSON.stringify(batch), encKey);
      if (batch.length === 1 && payload.length > MAX_MSGS_PAYLOAD_B64) {
        const truncated = { t: batch[0].t, m: [...batch[0].m].slice(0, MAX_SINGLE_MESSAGE_CHARS).join("") };
        payload = encrypt(JSON.stringify([truncated]), encKey);
      }
      const records = [record(LABEL.msgs, payload), ...base];
      if (
        payload.length <= MAX_MSGS_PAYLOAD_B64 &&
        measureRecords(pubKeyZ32, records) <= MAX_DNS_PACKET_BYTES
      ) {
        return { records, keptMessages: batch.length, servicesIncluded: withServices && svc !== null };
      }
      if (batch.length === 0) return null;
      batch.shift();
    }
  };

  const built = attempt(true) ?? attempt(false);
  if (!built) throw new Error("Link records do not fit in a Pkarr packet");
  return built;
}

export interface ResolvedMessage {
  text: string;
  timestamp: number;
  nick?: string;
}

export interface ResolvedLink {
  messages: ResolvedMessage[];
  latestTimestamp: number;
  peerAck: number;
  nick?: string;
  callSignal: string | null;
  rtcSignal: string | null;
  /** `null` when the peer published no advertisement (legacy client or offline). */
  services: ServiceAd[] | null;
  rawRecordNames: string[];
  encryptedPayloadLength: number;
  /** Milliseconds since the UNIX epoch. */
  packetTimestamp: number;
}

export function parseLinkRecords(packet: SignedPacket, encKey: Uint8Array): ResolvedLink {
  const resolved: ResolvedLink = {
    messages: [],
    latestTimestamp: 0,
    peerAck: 0,
    callSignal: null,
    rtcSignal: null,
    services: null,
    rawRecordNames: [],
    encryptedPayloadLength: 0,
    packetTimestamp: Number(packet.timestampMicros / 1000n),
  };

  let msgsPayload = "";
  for (const { label, value } of packet.records) {
    resolved.rawRecordNames.push(label);
    switch (label) {
      case LABEL.msgs:
        resolved.encryptedPayloadLength = value.length;
        msgsPayload = value;
        break;
      case LABEL.ts:
        resolved.latestTimestamp = Number.parseInt(value, 10) || 0;
        break;
      case LABEL.ack:
        resolved.peerAck = Number.parseInt(value, 10) || 0;
        break;
      case LABEL.nick:
        // A nickname is shown beside every message and is copied onto each of
        // them, so it is cut and stripped before anything keeps it.
        resolved.nick = sanitizeNick(tryDecrypt(value, encKey));
        break;
      case LABEL.call:
        resolved.callSignal = tryDecrypt(value, encKey);
        break;
      case LABEL.rtc:
        resolved.rtcSignal = tryDecrypt(value, encKey);
        break;
      case LABEL.svc: {
        const json = tryDecrypt(value, encKey);
        if (json !== null) resolved.services = decodeServices(json);
        break;
      }
      default:
        break;
    }
  }

  if (msgsPayload) {
    const json = tryDecrypt(msgsPayload, encKey);
    if (json !== null) {
      try {
        const batch: unknown = JSON.parse(json);
        if (Array.isArray(batch)) {
          for (const entry of batch as Partial<CompactMessage>[]) {
            if (typeof entry?.t !== "number" || typeof entry?.m !== "string") continue;
            resolved.messages.push({ text: entry.m, timestamp: entry.t, nick: resolved.nick });
          }
        }
      } catch {
        // not a message batch
      }
      if (resolved.latestTimestamp === 0 && resolved.messages.length > 0) {
        resolved.latestTimestamp = Math.max(...resolved.messages.map((m) => m.timestamp));
      }
    }
  }

  return resolved;
}
