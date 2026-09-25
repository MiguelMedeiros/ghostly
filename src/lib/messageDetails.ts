import type { MessageDetailsView, MessagePath, MessageSend } from "@ghostly/browser/shared/types";
import { publicKeyLabel } from "./publicKeyLabel";
import type { ChatMessage } from "./types";

/**
 * The words of a message's details view (WISP 400 § Message details): what the engine recorded about the message,
 * grouped for someone who wants to know how it travelled. Only what is known is said; nothing here is a key.
 */

export interface DetailRow {
  label: string;
  value: string;
  mono?: boolean;
  /** The row can be copied: this is what goes to the clipboard (the whole value, where the row shows it short). */
  copy?: string;
}
export type DetailSectionId = "identity" | "path" | "timing" | "wire" | "crypto" | "delivery" | "file" | "voice" | "payment" | "dht" | "hold" | "group" | "call";
export interface DetailSection { id: DetailSectionId; title: string; rows: DetailRow[] }
export interface DetailsModel {
  /** One plain-words line: how the message went. */
  summary: string;
  kind: string;
  sections: DetailSection[];
  /** Everything shown, plus the engine's view, for "Copy all as JSON". */
  json: Record<string, unknown>;
}

export const TRANSPORT_NAMES: Record<MessagePath, string> = {
  "webrtc/1": "WebRTC", "iroh/1": "Iroh", "hyperdht/1": "HyperDHT", dht: "DHT floor (Pkarr)", hold: "Held storage (hold/1)",
  "legacy-datalink": "WebRTC (compatibility chat)", "legacy-dht": "DHT (compatibility chat)",
};
const LIVE: ReadonlySet<MessagePath> = new Set(["webrtc/1", "iroh/1", "hyperdht/1", "legacy-datalink"]);

/** "WebRTC, direct" / "Iroh through relay.example" / "DHT floor (Pkarr)". */
export function pathWords(step: Pick<MessageSend, "path" | "relayed" | "relays">): string {
  const name = TRANSPORT_NAMES[step.path] ?? step.path;
  if (!LIVE.has(step.path)) return name;
  if (step.relayed) return `${name} through ${step.relays?.length ? step.relays.join(", ") : "a relay"}`;
  return step.relayed === false ? `${name}, direct` : name;
}

export function formatBytes(n: number): string {
  const exact = `${n.toLocaleString()} bytes`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB (${exact})`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB (${exact})`;
  return exact;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} h ${Math.round((ms % 3_600_000) / 60_000)} min`;
  return `${Math.floor(ms / 86_400_000)} d ${Math.round((ms % 86_400_000) / 3_600_000)} h`;
}

/** Local time to the millisecond; the copy is the instant in ISO 8601. */
export function formatTime(ms: number): string {
  const date = new Date(ms);
  return `${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.${String(ms % 1000).padStart(3, "0")}`;
}
const timeRow = (label: string, at: number): DetailRow => ({ label, value: formatTime(at), mono: true, copy: new Date(at).toISOString() });
const keyRow = (label: string, key: string): DetailRow => ({ label, value: publicKeyLabel(key), mono: true, copy: key });
const idRow = (label: string, id: string): DetailRow => ({ label, value: id.length > 28 ? `${id.slice(0, 12)}…${id.slice(-8)}` : id, mono: true, copy: id });

const DELIVERY_WORDS: Record<NonNullable<ChatMessage["delivery"]>, string> = {
  sending: "Sending", sent: "Sent, waiting for the receipt", queued: "Not confirmed yet, sends again by itself", waiting: "Waiting to be sent",
  held: "Held for the contact", delivered: "Delivered (receipt received)", failed: "Failed",
};

/** What the channel and the session guarantee, by the way the message went. */
function cryptoRows(path: MessagePath | undefined, view: MessageDetailsView | null | undefined, group: boolean): DetailRow[] {
  const rows: DetailRow[] = [];
  const link = view?.link;
  if (group) {
    rows.push({ label: "Message cipher", value: "XChaCha20-Poly1305, the group's epoch key" });
    rows.push({ label: "Epoch secret", value: "Sealed to each member with X25519 (ECDH) + XChaCha20-Poly1305" });
    return rows;
  }
  switch (path) {
    case "webrtc/1":
    case "legacy-datalink":
      rows.push({ label: "Channel", value: "WebRTC data channel: DTLS 1.2+ with SCTP" });
      if (path === "webrtc/1") rows.push({ label: "Session binding", value: "Both DTLS certificate fingerprints, in the signed transcript" });
      break;
    case "iroh/1":
      rows.push({ label: "Channel", value: "Iroh: QUIC with TLS 1.3 (raw public keys)" });
      rows.push({ label: "Session binding", value: "The Iroh connection's context, in the signed transcript" });
      break;
    case "hyperdht/1":
      rows.push({ label: "Channel", value: "HyperDHT stream: Noise (XX) handshake, encrypted transport" });
      rows.push({ label: "Session binding", value: "The Noise handshake hash, in the signed transcript" });
      break;
    case "dht":
      rows.push({ label: "Envelope cipher", value: "XSalsa20-Poly1305 (NaCl secretbox)" });
      rows.push({ label: "Envelope key", value: "HKDF of the invite key and an X25519 shared secret of both participation keys" });
      rows.push({ label: "Envelope signature", value: "Ed25519, by the sender's participation key" });
      break;
    case "hold":
      rows.push({ label: "Bundle cipher", value: "XSalsa20-Poly1305 (NaCl secretbox), GHLD bundle (hold/1)" });
      rows.push({ label: "Bundle key", value: "HKDF of the link's hold secret and an X25519 shared secret of both participation keys" });
      break;
    case "legacy-dht":
      rows.push({ label: "Record cipher", value: "XSalsa20-Poly1305 (NaCl secretbox) with the chat's shared key" });
      break;
  }
  if (path && LIVE.has(path) && path !== "legacy-datalink") rows.push({ label: "Session authentication", value: "Ed25519 (paired-chat/1): each side signs the transcript with its participation key" });
  if (link?.profile) {
    if (link.peerKey) rows.push({ label: "Contact key pinned", value: `${publicKeyLabel(link.peerKey)} · ${link.verified ? "verified by comparing codes" : "trusted on first use, not compared"}`, mono: false, copy: link.peerKey });
    else rows.push({ label: "Contact key", value: "Not pinned yet" });
  }
  return rows;
}

function voiceCodec(mime: string): string {
  const m = mime.toLowerCase();
  const codec = /opus/.test(m) ? "Opus" : /aac|mp4a/.test(m) ? "AAC" : /vorbis/.test(m) ? "Vorbis" : /wav|pcm/.test(m) ? "PCM" : "";
  const container = /webm/.test(m) ? "WebM" : /mp4|m4a/.test(m) ? "MP4" : /ogg/.test(m) ? "Ogg" : /wav/.test(m) ? "WAV" : mime;
  return codec ? `${codec} in ${container}` : container;
}

const kindOf = (message: ChatMessage, picture: boolean): string =>
  message.callEvent ? "Call event" : message.systemEvent ? "System notice" : message.paymentId ? "Payment" : message.file?.voice ? "Voice message" : message.file ? "File" : picture ? "Picture" : "Text";

/** The plain-words line at the top. */
function summarize(message: ChatMessage, view: MessageDetailsView | null | undefined, kind: string): string {
  const d = view?.details, mine = message.sender === "me";
  if (message.sender === "system" && !view) return "A note kept on this device only. Nothing was sent for it.";
  const thing = kind === "Payment" ? (view?.payment?.kind === "request" ? "Payment request" : "Payment") : kind === "Text" ? "Message" : kind;
  if (!mine) {
    const r = d?.received;
    if (!r) return `${thing} received.`;
    if (r.path === "hold") return `${thing} picked up from your contact's storage, sealed for you, ${formatDuration(Math.max(0, r.at - message.timestamp))} after it was written.`;
    if (r.path === "dht" || r.path === "legacy-dht") return `${thing} received from the DHT, sealed end to end, ${formatDuration(Math.max(0, r.at - message.timestamp))} after it was written (two clocks).`;
    return `${thing} received live over ${pathWords(r)}, encrypted end to end.`;
  }
  const last = d?.sends?.[d.sends.length - 1], sends = d?.attempts ?? d?.sends?.length ?? 0;
  const over = last ? pathWords(last) : undefined;
  switch (message.delivery) {
    case "waiting": return `${thing} not sent yet: it goes by itself when the chat can carry it.`;
    case "failed": return `${thing} could not be sent${over ? ` over ${over}` : ""}.`;
    case "held": return `${thing} held in your storage, sealed for your contact, waiting to be picked up.`;
    case "queued": return `${thing} sent ${sends} time${sends === 1 ? "" : "s"}${over ? ` over ${over}` : ""} without a receipt. It goes again by itself.`;
  }
  if (!last) return message.delivery === "delivered" ? `${thing} delivered.` : `${thing} sent.`;
  const receipt = d?.receiptAt && d.sentAt ? formatDuration(Math.max(0, d.receiptAt - d.sentAt)) : undefined;
  if (last.path === "hold") return `${thing} held in your storage, sealed for your contact${receipt ? `, picked up ${receipt} later` : ""}.`;
  if (last.path === "dht" || last.path === "legacy-dht") return `${thing} sent on the DHT, sealed end to end${receipt ? `, confirmed after ${receipt}` : message.delivery === "delivered" ? ", confirmed" : ", waiting for the receipt"}.`;
  const again = sends > 1 ? ` on the ${ordinal(sends)} try` : "";
  return `${thing} sent live over ${over}, encrypted end to end${receipt ? `, receipt in ${receipt}${again}` : message.delivery === "delivered" ? ", delivered" : message.delivery === "sent" ? ", waiting for the receipt" : ""}.`;
}
const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;

/** Builds the view's model from the message as the chat has it and what the engine answered (null: nothing stored for it). */
export function buildDetails(message: ChatMessage, view: MessageDetailsView | null | undefined, options: { picture?: boolean } = {}): DetailsModel {
  const kind = kindOf(message, !!options.picture);
  const d = view?.details, link = view?.link, group = !!view?.group, mine = message.sender === "me";
  const sections: DetailSection[] = [];
  const add = (id: DetailSectionId, title: string, rows: (DetailRow | false | undefined)[]) => {
    const kept = rows.filter((r): r is DetailRow => !!r);
    if (kept.length) sections.push({ id, title, rows: kept });
  };

  const senderKey = group ? view?.group?.member ?? (mine ? undefined : undefined) : mine ? link?.myKey : link?.peerKey;
  add("identity", "Identity", [
    idRow("Message id", message.id),
    { label: "Kind", value: kind },
    { label: "Direction", value: message.sender === "system" ? "System" : mine ? "Sent by you" : "Received" },
    senderKey ? keyRow("Sender key", senderKey) : undefined,
    view?.message.wireId ? idRow("Wire id", view.message.wireId) : undefined,
    link ? idRow("Chat id", link.id) : view?.group ? idRow("Group id", view.group.id) : undefined,
    link?.profile ? { label: "Chat profile", value: `${link.profile}${link.deliveryMode === "dht" ? " · DHT only" : ""}` } : link ? { label: "Chat profile", value: "compatibility chat (Ghostly 0.4)" } : undefined,
    view ? { label: "Text size", value: formatBytes(view.message.textBytes) } : undefined,
  ]);

  const last = d?.sends?.[d.sends.length - 1];
  const step = mine ? last : d?.received;
  add("path", "Path", [
    step ? { label: mine ? "Sent over" : "Received over", value: pathWords(step) } : undefined,
    step?.relays?.length ? { label: "Relay", value: step.relays.join(", "), mono: true, copy: step.relays.join(", ") } : undefined,
    step?.rttMs !== undefined ? { label: "Round trip then", value: formatDuration(step.rttMs) } : undefined,
    d?.sends && d.sends.length > 1 ? { label: "Sends", value: d.sends.map((s, i) => `${d.attempts && d.attempts > d.sends!.length && i > 0 ? "…" : ""}${formatTime(s.at)} ${pathWords(s)} (${s.result ?? "sending"}${s.error ? `: ${s.error}` : ""})`).join("\n"), mono: true } : undefined,
    link?.transportNow ? { label: "Connection now", value: `${pathWords({ path: link.transportNow, relayed: link.relayedNow })}${link.rttNowMs !== undefined ? `, round trip ${formatDuration(link.rttNowMs)}` : ""}` } : undefined,
  ]);

  const receipt = d?.receiptAt !== undefined && d.sentAt !== undefined ? d.receiptAt - d.sentAt : undefined;
  add("timing", "Timing", [
    timeRow("Composed", message.timestamp),
    d?.sentAt !== undefined ? timeRow("Sent", d.sentAt) : undefined,
    d?.heldAt !== undefined ? timeRow("Held", d.heldAt) : undefined,
    d?.received ? timeRow("Received", d.received.at) : undefined,
    d?.received ? { label: "After composing", value: `${formatDuration(Math.max(0, d.received.at - message.timestamp))} (by the two devices' clocks)` } : undefined,
    d?.receiptAt !== undefined ? timeRow(mine && last?.path === "hold" ? "Picked up" : "Receipt", d.receiptAt) : undefined,
    receipt !== undefined ? { label: mine && last?.path === "hold" ? "Picked up after" : "Receipt after", value: formatDuration(Math.max(0, receipt)) } : undefined,
    d?.completedAt !== undefined ? timeRow("Transfer completed", d.completedAt) : undefined,
    d?.attempts ? { label: "Attempts", value: `${d.attempts} send${d.attempts === 1 ? "" : "s"}` } : undefined,
    view?.message.resendUntil ? timeRow("Sends again until", view.message.resendUntil) : undefined,
  ]);

  add("wire", "Wire", [
    d?.wire ? { label: "Frame", value: d.wire.frame, mono: true } : undefined,
    d?.wire ? { label: "Protocol", value: d.wire.protocol, mono: true } : undefined,
    d?.wire?.plaintextBytes !== undefined ? { label: "Plaintext", value: formatBytes(d.wire.plaintextBytes) } : undefined,
    d?.wire?.wireBytes !== undefined ? { label: "On the wire", value: formatBytes(d.wire.wireBytes) } : undefined,
    d?.wire?.chunks !== undefined ? { label: "Chunks", value: `${d.wire.chunks.toLocaleString()} × ${d.wire.chunkBytes ? formatBytes(d.wire.chunkBytes) : "?"}` } : undefined,
  ]);

  const path = step?.path ?? (view?.message.via === "hold" ? "hold" : view?.message.via === "pkarr" ? (link?.profile ? "dht" : "legacy-dht") : undefined);
  add("crypto", "Crypto", cryptoRows(path, view, group));

  add("delivery", "Delivery", [
    message.delivery ? { label: "State", value: DELIVERY_WORDS[message.delivery] } : mine && view ? { label: "State", value: "Sent" } : undefined,
    message.deliveryError && message.delivery !== "waiting" ? { label: "Note", value: message.deliveryError } : undefined,
    message.delivery === "waiting" && message.deliveryError ? { label: "Why it waits", value: message.deliveryError } : undefined,
    mine && view?.message.wireId ? idRow("Receipt id", view.message.wireId) : undefined,
    d?.hold?.seq !== undefined ? { label: "Held item", value: `#${d.hold.seq} in the mailbox${d.hold.bytes ? `, ${formatBytes(d.hold.bytes)} sealed` : ""}` } : undefined,
    d?.hold?.expires ? timeRow("Held until", d.hold.expires) : undefined,
  ]);

  if (view?.file) {
    const f = view.file;
    add("file", "File", [
      { label: "Name", value: f.name },
      { label: "Type", value: f.mime || "unknown", mono: true },
      { label: "Size", value: formatBytes(f.size) },
      f.digest ? { label: "SHA-256", value: `${f.digest.slice(0, 16)}…`, mono: true, copy: f.digest } : undefined,
      f.protocol ? { label: "Protocol", value: f.protocol, mono: true } : undefined,
      f.state ? { label: "Transfer", value: f.stage ? `${f.state} (${f.stage})` : f.state } : undefined,
      f.confirmed !== undefined ? { label: "Confirmed", value: `${formatBytes(f.confirmed)} durably stored` } : f.transferred !== undefined && f.state !== "done" ? { label: "Transferred", value: formatBytes(f.transferred) } : undefined,
      f.since ? timeRow("Offered", f.since) : undefined,
      f.consented !== undefined ? { label: "Accepted by", value: f.consented ? "the person" : "the app (within its limits)" } : undefined,
      f.storage ? { label: "Stored as", value: f.storage === "opfs" ? "a file in the origin's private file system" : f.storage === "native" ? "a file kept by the desktop app" : f.storage === "idb" ? "pieces in IndexedDB" : f.storage } : undefined,
    ]);
    if (f.voice) add("voice", "Voice", [
      { label: "Codec", value: voiceCodec(f.mime) },
      { label: "Length", value: formatDuration(f.voice.duration) },
      f.voice.duration > 0 ? { label: "Bitrate", value: `${Math.round(f.size * 8 / (f.voice.duration / 1000) / 1000)} kbit/s` } : undefined,
      { label: "Waveform", value: `${f.voice.peaks} peaks` },
    ]);
  }

  if (view?.payment) {
    const p = view.payment;
    add("payment", "Payment", [
      idRow("Payment id", p.id),
      { label: "Kind", value: `${p.kind === "request" ? "Request" : "Payment"}, ${p.direction === "out" ? "outgoing" : "incoming"}` },
      { label: "Amount", value: `${p.amount.toLocaleString()} ${p.unit}` },
      p.method ? { label: "Rail", value: [p.method, p.network, p.provider].filter(Boolean).join(" · ") } : undefined,
      { label: "State", value: p.state },
      p.mint ? { label: "Mint", value: p.mint, mono: true, copy: p.mint } : undefined,
      p.txid ? idRow("Transaction", p.txid) : undefined,
      p.invoiceDigest ? { label: "Invoice SHA-256", value: `${p.invoiceDigest.slice(0, 16)}…`, mono: true, copy: p.invoiceDigest } : undefined,
      p.ask ? idRow("Answers ask", p.ask) : undefined,
      p.group ? idRow("Group", p.group) : undefined,
      timeRow("Created", p.createdAt),
      p.error ? { label: "Error", value: p.error } : undefined,
    ]);
  }

  const dht = d?.dht;
  const meta = !dht && message.meta && (message.meta.encryptedPayloadLength > 0 || message.meta.packetTimestamp) ? message.meta : undefined;
  if (dht || meta) add("dht", "DHT record", [
    dht?.recordKey ? keyRow("Record key", dht.recordKey) : meta ? keyRow("Record key", meta.dhtKey) : undefined,
    dht?.seq !== undefined ? { label: "Sequence", value: String(dht.seq), mono: true } : undefined,
    dht?.issued !== undefined ? timeRow("Packet issued", dht.issued) : meta?.packetTimestamp ? timeRow("Packet issued", meta.packetTimestamp) : undefined,
    dht?.expires !== undefined ? timeRow("Expires", dht.expires) : undefined,
    dht?.packetBytes !== undefined ? { label: "Signed packet", value: formatBytes(dht.packetBytes) } : meta?.encryptedPayloadLength ? { label: "Sealed payload", value: formatBytes(meta.encryptedPayloadLength) } : undefined,
    dht?.nonce ? { label: "Nonce", value: dht.nonce, mono: true, copy: dht.nonce } : undefined,
    dht?.records?.length ? { label: "Records", value: dht.records.join(", "), mono: true } : meta?.dnsRecords.length ? { label: "Records", value: meta.dnsRecords.join(", "), mono: true } : undefined,
  ]);

  if (view?.group) add("group", "Group", [
    idRow("Group id", view.group.id),
    view.group.profile ? { label: "Profile", value: `group-${view.group.profile}/1`, mono: true } : undefined,
    view.group.member ? keyRow("Member key", view.group.member) : undefined,
  ]);

  if (message.callEvent) add("call", "Call", [
    { label: "Event", value: message.callEvent.type.replace("call_", "") },
    { label: "Video", value: message.callEvent.hasVideo ? "yes" : "no" },
    message.callEvent.duration ? { label: "Length", value: formatDuration(message.callEvent.duration) } : undefined,
  ]);

  const summary = summarize(message, view, kind);
  const json: Record<string, unknown> = {
    id: message.id, kind, summary,
    ...Object.fromEntries(sections.map(s => [s.id, Object.fromEntries(s.rows.map(r => [r.label, r.copy ?? r.value]))])),
    ...(view && { engine: view }),
  };
  return { summary, kind, sections, json };
}
