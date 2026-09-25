import { sha256 } from "@noble/hashes/sha2.js";
import { FILE_LIMITS, utf8Encode, type PairedTransport } from "@ghostly/core";
import type { StoredFile } from "../shared/idb";
import { MESSAGE_DETAILS_MAX_BYTES, MESSAGE_DETAILS_MAX_SENDS, type MessageDetails, type MessageDetailsView, type MessagePath, type MessageSend, type PaymentView, type StoredLink, type StoredMessage } from "../shared/types";

/**
 * What the engine remembers about a message's travels (WISP 400 § Message details), and how the details view is put
 * together from it. Facts only, as they were when the message went or came: which transport carried it, whether that
 * session crossed a relay, the frame and its size, the times. Nothing here is a key, a seed, a token or a signal; the
 * view is what a screenshot may show.
 */

/** files/2 sends a file in chunks of this many bytes (`@ghostly/core` pairedFiles.ts). */
export const FILES2_CHUNK_BYTES = 16 * 1024;

/** The live session as it is right now, for a send or a receipt over it. */
export interface PathSnapshot {
  path: MessagePath;
  relayed?: boolean;
  relays?: string[];
  rttMs?: number;
}

/** What a live link says about its session; the part of `LiveLink` the details need. */
export interface LiveForDetails {
  stored: Pick<StoredLink, "profile">;
  pairing?: { transport?: PairedTransport; status?: string };
  link: { isDataLinkOpen: boolean; relayedPath?: { relays: string[] }; rttMs?: number } | null;
}

/** The path a message takes now, given how the engine routes it (`via`) and the session up at the moment. */
export function pathSnapshot(live: LiveForDetails | undefined, via: StoredMessage["via"]): PathSnapshot {
  const paired = !!live?.stored.profile;
  if (via === "hold") return { path: "hold" };
  if (via === "pkarr") return { path: paired ? "dht" : "legacy-dht" };
  if (!paired) return { path: "legacy-datalink" };
  const link = live?.link, transport = live?.pairing?.transport;
  if (!link?.isDataLinkOpen || !transport) return { path: transport ?? "webrtc/1" };
  const relayed = link.relayedPath;
  return { path: transport, ...(relayed ? { relayed: true, relays: relayed.relays } : { relayed: false }), ...(link.rttMs !== undefined && { rttMs: link.rttMs }) };
}

/** One more send on a record: the first send stays, the middle ones go once there are too many. */
export function withSend(details: MessageDetails | undefined, send: MessageSend): MessageDetails {
  const sends = [...(details?.sends ?? []), send];
  const attempts = (details?.attempts ?? details?.sends?.length ?? 0) + 1;
  const kept = sends.length > MESSAGE_DETAILS_MAX_SENDS ? [sends[0], ...sends.slice(sends.length - MESSAGE_DETAILS_MAX_SENDS + 1)] : sends;
  return trim({ ...details, sends: kept, attempts });
}

/** A record that fits its budget as JSON: the oldest sends after the first go, then the relays, then the sends. */
export function trim(details: MessageDetails): MessageDetails {
  const size = (d: MessageDetails) => utf8Encode(JSON.stringify(d)).length;
  let out = details;
  while (size(out) > MESSAGE_DETAILS_MAX_BYTES && (out.sends?.length ?? 0) > 2) out = { ...out, sends: [out.sends![0], ...out.sends!.slice(2)] };
  if (size(out) > MESSAGE_DETAILS_MAX_BYTES && out.sends) out = { ...out, sends: out.sends.map(s => ({ ...s, relays: undefined })) };
  if (size(out) > MESSAGE_DETAILS_MAX_BYTES && out.sends) out = { ...out, sends: [out.sends[out.sends.length - 1]] };
  return out;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
/** SHA-256 of a text, hex. */
export const digestHex = (text: string) => hex(sha256(utf8Encode(text)));

/** What kind of message a row is, for the view's words. */
export function messageKind(message: StoredMessage): MessageDetailsView["message"]["kind"] {
  if (message.event) return "event";
  if (message.groupPay) return "note";
  if (message.paymentId) return "payment";
  if (message.file?.voice) return "voice";
  if (message.file) return "file";
  return "text";
}

/** The details view of one message, from the row and what the engine holds around it. Keys are public ones only. */
export function composeDetails(message: StoredMessage, around: {
  link?: { stored: StoredLink; myKey: string; verified: boolean; transportNow?: PairedTransport; relayedNow?: boolean; rttNowMs?: number };
  file?: StoredFile;
  payment?: PaymentView;
  group?: { id: string; profile?: string };
}): MessageDetailsView {
  const { link, file, payment, group } = around;
  const view: MessageDetailsView = {
    message: {
      id: message.id, wireId: message.wireId, linkId: message.linkId, sender: message.sender, timestamp: message.timestamp, via: message.via,
      delivery: message.delivery, deliveryError: message.deliveryError, resendUntil: message.resendUntil, member: message.member, nick: message.nick,
      kind: messageKind(message), textBytes: utf8Encode(message.text).length,
    },
    ...(message.details && { details: message.details }),
  };
  if (link) view.link = {
    id: link.stored.id, profile: link.stored.profile, deliveryMode: link.stored.deliveryMode, myKey: link.myKey,
    ...(link.stored.pairedPeerKey && { peerKey: link.stored.pairedPeerKey }), verified: link.verified,
    ...(link.transportNow && { transportNow: link.transportNow, relayedNow: !!link.relayedNow }), ...(link.rttNowMs !== undefined && { rttNowMs: link.rttNowMs }),
  };
  if (message.file) {
    const record = file?.wire3, transfer = file?.transfer;
    view.file = {
      id: message.file.id, name: message.file.name, size: message.file.size, mime: message.file.mime,
      ...(file?.digest && { digest: file.digest }),
      protocol: message.via === "hold" ? "hold/1" : record ? "files/3" : message.details?.wire?.protocol === "files/3" ? "files/3" : "files/2",
      ...(record ? { state: record.state, confirmed: record.confirmed, since: record.since, ...(record.consented !== undefined && { consented: record.consented }) } : transfer && { state: transfer.state, transferred: transfer.transferred }),
      ...(file?.bytes ? { storage: file.bytes } : file?.blob ? { storage: "blob" } : {}),
      ...(message.file.voice && { voice: { duration: message.file.voice.duration, peaks: message.file.voice.peaks.length } }),
    };
  }
  if (payment) view.payment = {
    id: payment.id, kind: payment.kind, direction: payment.direction, amount: payment.amount, unit: payment.unit, state: payment.state,
    ...(payment.target && { method: payment.target.method, network: payment.target.network, provider: payment.target.provider, asset: payment.target.asset }),
    ...(payment.mint && { mint: payment.mint }), ...(payment.txid && { txid: payment.txid }), ...(payment.ask && { ask: payment.ask }),
    createdAt: payment.createdAt, ...(payment.error && { error: payment.error }), ...(payment.memo && { memo: payment.memo }), ...(payment.group && { group: payment.group }),
    ...(payment.invoice && { invoiceDigest: digestHex(payment.invoice) }),
    ...(payment.lightningPending && { lightningPending: true }), ...(payment.paidHere && { paidHere: true }),
  };
  if (group) view.group = { id: group.id, ...(message.member && { member: message.member }), ...(group.profile && { profile: group.profile }) };
  return view;
}

/** The frame a file goes in, and how many pieces, by the protocol carrying it. */
export function fileWire(protocol: "files/2" | "files/3", size: number): NonNullable<MessageDetails["wire"]> {
  const chunkBytes = protocol === "files/3" ? FILE_LIMITS.chunkBytes : FILES2_CHUNK_BYTES;
  return { frame: protocol === "files/3" ? "pf-offer + pf-data" : "pf-start + pf-chunk", protocol, plaintextBytes: size, chunks: Math.ceil(size / chunkBytes), chunkBytes };
}
