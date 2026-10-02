import { shownTime } from "@ghostly/core";
import type { MessageDetailsView, MessagePath, MessageSend } from "@ghostly/browser/shared/types";
import { englishT, type Translate, type TranslationKey } from "../locales/translate";
import { languageTag } from "./documentLanguage";
import { publicKeyLabel } from "./publicKeyLabel";
import type { Language } from "./settings";
import { formatAt } from "./time";
import type { ChatMessage } from "./types";

/**
 * The words of a message's details view (WISP 400 § Message details): what the engine recorded about the message,
 * grouped for someone who wants to know how it travelled. Only what is known is said; nothing here is a key. Written
 * in the app's language (`t`), numbers and times too; protocol and cipher names stay as they are, and a row whose
 * value is data (an engine state, a MIME type, a cipher suite) is marked `raw`, left untranslated.
 */

export interface DetailRow {
  label: string;
  value: string;
  mono?: boolean;
  /** The value is data, the same in every language (`translate="no"`, left to right). Mono values are too. */
  raw?: boolean;
  /** The row can be copied: this is what goes to the clipboard (the whole value, where the row shows it short). */
  copy?: string;
}
export type DetailSectionId = "identity" | "edits" | "path" | "timing" | "wire" | "crypto" | "delivery" | "file" | "voice" | "payment" | "dht" | "hold" | "group" | "call";
export interface DetailSection { id: DetailSectionId; title: string; rows: DetailRow[] }
export interface DetailsModel {
  /** One plain-words line: how the message went. */
  summary: string;
  kind: string;
  sections: DetailSection[];
  /** Everything shown, in English whatever the app's language, plus the engine's view, for "Copy all as JSON". */
  json: Record<string, unknown>;
}

/** A transport's name: a protocol's own name, or the words for a way that is not one. */
const TRANSPORT_NAMES: Record<MessagePath, string> = {
  "webrtc/1": "WebRTC", "iroh/1": "Iroh", "hyperdht/1": "HyperDHT", dht: "messageDetails.path.dht", hold: "messageDetails.path.hold",
  "legacy-datalink": "messageDetails.path.legacyDatalink", "legacy-dht": "messageDetails.path.legacyDht",
};
const LIVE: ReadonlySet<MessagePath> = new Set(["webrtc/1", "iroh/1", "hyperdht/1", "legacy-datalink"]);

function transportName(path: MessagePath, t: Translate): string {
  const name = TRANSPORT_NAMES[path];
  if (!name) return path;
  return name.startsWith("messageDetails.") ? t(name as TranslationKey) : name;
}

/** "WebRTC, direct" / "Iroh through relay.example" / "DHT floor (Pkarr)". */
export function pathWords(step: Pick<MessageSend, "path" | "relayed" | "relays">, t: Translate = englishT): string {
  const name = transportName(step.path, t);
  if (!LIVE.has(step.path)) return name;
  if (step.relayed) return t("messageDetails.path.through", { name, relays: step.relays?.length ? step.relays.join(", ") : t("messageDetails.path.aRelay") });
  return step.relayed === false ? t("messageDetails.path.direct", { name }) : name;
}

const languageOf = (t: Translate): Language => t.language ?? "en";

const numberFormats = new Map<string, Intl.NumberFormat>();
/** `n` in the app's language with `digits` decimals ("2.9" in English, "2,9" in Portuguese), in Latin digits as amounts are. */
function decimal(n: number, digits: number, language: Language): string {
  const key = `${language} ${digits}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(languageTag(language), { numberingSystem: "latn", minimumFractionDigits: digits, maximumFractionDigits: digits });
    numberFormats.set(key, format);
  }
  return format.format(n);
}

export function formatBytes(n: number, t: Translate = englishT): string {
  const language = languageOf(t);
  const exact = t("messageDetails.unit.bytes", { n: decimal(n, 0, language) });
  if (n >= 1024 * 1024) return t("messageDetails.unit.megabytes", { n: decimal(n / 1024 / 1024, 1, language), exact });
  if (n >= 1024) return t("messageDetails.unit.kilobytes", { n: decimal(n / 1024, 1, language), exact });
  return exact;
}

export function formatDuration(ms: number, t: Translate = englishT): string {
  const language = languageOf(t);
  const int = (n: number) => decimal(n, 0, language);
  if (ms < 1000) return t("messageDetails.unit.milliseconds", { n: int(Math.round(ms)) });
  if (ms < 60_000) return t("messageDetails.unit.seconds", { n: decimal(ms / 1000, ms < 10_000 ? 2 : 1, language) });
  if (ms < 3_600_000) return t("messageDetails.unit.minutesSeconds", { min: int(Math.floor(ms / 60_000)), s: int(Math.round((ms % 60_000) / 1000)) });
  if (ms < 86_400_000) return t("messageDetails.unit.hoursMinutes", { h: int(Math.floor(ms / 3_600_000)), min: int(Math.round((ms % 3_600_000) / 60_000)) });
  return t("messageDetails.unit.daysHours", { d: int(Math.floor(ms / 86_400_000)), h: int(Math.round((ms % 86_400_000) / 3_600_000)) });
}

/** How long a call lasted, in whole seconds and the app's language: "42 s", "1 min 5 s", "1 h 3 min". */
export function formatCallLength(ms: number, t: Translate = englishT): string {
  const int = (n: number) => decimal(n, 0, languageOf(t));
  const total = Math.floor(ms / 1000);
  if (total < 60) return t("messageDetails.unit.seconds", { n: int(total) });
  if (total < 3600) return t("messageDetails.unit.minutesSeconds", { min: int(Math.floor(total / 60)), s: int(total % 60) });
  return t("messageDetails.unit.hoursMinutes", { h: int(Math.floor(total / 3600)), min: int(Math.floor((total % 3600) / 60)) });
}

const CLOCK: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hourCycle: "h23" } as Intl.DateTimeFormatOptions;

/** The time to the millisecond, as the app's language writes a time of day (the device's without one). */
export function formatTime(ms: number, language?: Language): string {
  return formatAt(ms, CLOCK, language);
}

const DELIVERY_WORDS: Record<NonNullable<ChatMessage["delivery"]>, TranslationKey> = {
  sending: "messageDetails.delivery.sending", sent: "messageDetails.delivery.sent", queued: "messageDetails.delivery.queued",
  waiting: "messageDetails.delivery.waiting", held: "messageDetails.delivery.held", delivered: "messageDetails.delivery.delivered",
  failed: "messageDetails.delivery.failed",
};

/** A file of mine that ended without going, by how its transfer ended. */
const FILE_NOT_SENT: Record<string, TranslationKey | undefined> = {
  failed: "messageDetails.value.fileFailed", declined: "messageDetails.value.fileDeclined", cancelled: "messageDetails.value.fileCancelled",
};

const CALL_EVENTS: Record<string, TranslationKey | undefined> = {
  call_started: "messageDetails.call.call_started", call_received: "messageDetails.call.call_received", call_connected: "messageDetails.call.call_connected",
  call_ended: "messageDetails.call.call_ended", call_missed: "messageDetails.call.call_missed", call_unanswered: "messageDetails.call.call_unanswered",
  call_cancelled: "messageDetails.call.call_cancelled",
};

const STORAGE: Record<string, TranslationKey | undefined> = {
  opfs: "messageDetails.storage.opfs", native: "messageDetails.storage.native", idb: "messageDetails.storage.idb", blob: "messageDetails.storage.blob",
};

/** What the channel and the session guarantee, by the way the message went. */
function cryptoRows(path: MessagePath | undefined, view: MessageDetailsView | null | undefined, group: boolean, t: Translate): DetailRow[] {
  const rows: DetailRow[] = [];
  const link = view?.link;
  const row = (label: string, key: TranslationKey): DetailRow => ({ label: t(`messageDetails.label.${label}` as TranslationKey), value: t(key) });
  const raw = (label: string, value: string): DetailRow => ({ label: t(`messageDetails.label.${label}` as TranslationKey), value, raw: true });
  if (group) {
    rows.push(row("messageCipher", "messageDetails.crypto.groupCipher"));
    rows.push(row("epochSecret", "messageDetails.crypto.epochSecret"));
    return rows;
  }
  switch (path) {
    case "webrtc/1":
    case "legacy-datalink":
      rows.push(row("channel", "messageDetails.crypto.webrtcChannel"));
      if (path === "webrtc/1") rows.push(row("sessionBinding", "messageDetails.crypto.webrtcBinding"));
      break;
    case "iroh/1":
      rows.push(row("channel", "messageDetails.crypto.irohChannel"));
      rows.push(row("sessionBinding", "messageDetails.crypto.irohBinding"));
      break;
    case "hyperdht/1":
      rows.push(row("channel", "messageDetails.crypto.hyperChannel"));
      rows.push(row("sessionBinding", "messageDetails.crypto.hyperBinding"));
      break;
    case "dht":
      rows.push(raw("envelopeCipher", "XSalsa20-Poly1305 (NaCl secretbox)"));
      rows.push(row("envelopeKey", "messageDetails.crypto.dhtKey"));
      rows.push(row("envelopeSignature", "messageDetails.crypto.dhtSignature"));
      break;
    case "hold":
      rows.push(raw("bundleCipher", "XSalsa20-Poly1305 (NaCl secretbox), GHLD bundle (hold/1)"));
      rows.push(row("bundleKey", "messageDetails.crypto.holdKey"));
      break;
    case "legacy-dht":
      rows.push(row("recordCipher", "messageDetails.crypto.legacyCipher"));
      break;
  }
  if (path && LIVE.has(path) && path !== "legacy-datalink") rows.push(row("sessionAuth", "messageDetails.crypto.sessionAuth"));
  if (link?.profile) {
    if (link.peerKey) rows.push({ label: t("messageDetails.label.contactKeyPinned"), value: t(link.verified ? "messageDetails.crypto.pinnedVerified" : "messageDetails.crypto.pinnedTofu", { key: publicKeyLabel(link.peerKey) }), copy: link.peerKey });
    else rows.push(row("contactKey", "messageDetails.crypto.notPinned"));
  }
  return rows;
}

function voiceCodec(mime: string, t: Translate): string {
  const m = mime.toLowerCase();
  const codec = /opus/.test(m) ? "Opus" : /aac|mp4a/.test(m) ? "AAC" : /vorbis/.test(m) ? "Vorbis" : /wav|pcm/.test(m) ? "PCM" : "";
  const container = /webm/.test(m) ? "WebM" : /mp4|m4a/.test(m) ? "MP4" : /ogg/.test(m) ? "Ogg" : /wav/.test(m) ? "WAV" : mime;
  return codec ? t("messageDetails.value.codec", { codec, container }) : t("messageDetails.value.codecUnknown", { container });
}

type Kind = "call" | "system" | "payment" | "voice" | "file" | "picture" | "text";
const kindOf = (message: ChatMessage, picture: boolean): Kind =>
  message.callEvent ? "call" : message.systemEvent ? "system" : message.paymentId ? "payment" : message.file?.voice ? "voice" : message.file ? "file" : picture ? "picture" : "text";

/** The plain-words line at the top. */
function summarize(message: ChatMessage, view: MessageDetailsView | null | undefined, kind: Kind, t: Translate): string {
  const d = view?.details, mine = message.sender === "me";
  if (message.sender === "system" && !view) return t("messageDetails.summary.localNote");
  const thing = kind === "payment" ? t(view?.payment?.kind === "request" ? "messageDetails.summary.paymentRequest" : "messageDetails.kind.payment")
    : kind === "text" ? t("messageDetails.summary.message") : t(`messageDetails.kind.${kind}`);
  const say = (key: string, params: Record<string, string | number> = {}) => t(`messageDetails.summary.${key}` as TranslationKey, { thing, ...params });
  if (!mine) {
    const r = d?.received;
    if (!r) return say("received");
    const after = formatDuration(Math.max(0, r.at - (message.sentAt ?? message.timestamp)), t);
    if (r.path === "hold") return say("receivedHold", { after });
    if (r.path === "dht" || r.path === "legacy-dht") return say("receivedDht", { after });
    return say("receivedLive", { over: pathWords(r, t) });
  }
  const last = d?.sends?.[d.sends.length - 1], sends = d?.attempts ?? d?.sends?.length ?? 0;
  const over = last ? pathWords(last, t) : undefined;
  if (view?.file?.state && FILE_NOT_SENT[view.file.state]) return over ? say("fileNotSentOver", { over }) : say("fileNotSent");
  switch (message.delivery) {
    case "waiting": return say("waiting");
    case "failed": return over ? say("failedOver", { over }) : say("failed");
    case "held": return say("held");
    case "queued": return say(`queued${sends === 1 ? "One" : ""}${over ? "Over" : ""}`, { count: sends, over: over ?? "" });
  }
  if (!last || !over) return say(message.delivery === "delivered" ? "delivered" : "sent");
  const receipt = d?.receiptAt && d.sentAt ? formatDuration(Math.max(0, d.receiptAt - d.sentAt), t) : undefined;
  if (last.path === "hold") return receipt ? say("heldPickedUp", { after: receipt }) : say("heldSent");
  if (last.path === "dht" || last.path === "legacy-dht") return receipt ? say("dhtConfirmedAfter", { receipt }) : say(message.delivery === "delivered" ? "dhtConfirmed" : "dhtWaiting");
  if (receipt) return sends > 1 ? say("liveReceiptTry", { over, receipt, nth: languageOf(t) === "en" ? ordinal(sends) : sends }) : say("liveReceipt", { over, receipt });
  return say(message.delivery === "delivered" ? "liveDelivered" : message.delivery === "sent" ? "liveWaiting" : "live", { over });
}
/** "2nd", for English: the other languages write the try's number in a sentence of their own. */
const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;

/**
 * Builds the view's model from the message as the chat has it and what the engine answered (null: nothing stored for
 * it), in the language of `t` (English without one). Its JSON copy stays in English: it goes to whoever debugs it.
 */
export function buildDetails(message: ChatMessage, view: MessageDetailsView | null | undefined, options: { picture?: boolean; t?: Translate } = {}): DetailsModel {
  const t = options.t ?? englishT;
  const model = build(message, view, !!options.picture, t);
  return languageOf(t) === "en" ? model : { ...model, json: build(message, view, !!options.picture, englishT).json };
}

function build(message: ChatMessage, view: MessageDetailsView | null | undefined, picture: boolean, t: Translate): DetailsModel {
  const language = languageOf(t);
  const kind = kindOf(message, picture);
  const kindWords = t(`messageDetails.kind.${kind}`);
  const d = view?.details, link = view?.link, group = !!view?.group, mine = message.sender === "me";
  const sections: DetailSection[] = [];
  const add = (id: DetailSectionId, rows: (DetailRow | false | undefined)[]) => {
    const kept = rows.filter((r): r is DetailRow => !!r);
    if (kept.length) sections.push({ id, title: t(`messageDetails.section.${id}` as TranslationKey), rows: kept });
  };
  const L = (label: string) => t(`messageDetails.label.${label}` as TranslationKey);
  const V = (value: string, params?: Record<string, string | number>) => t(`messageDetails.value.${value}` as TranslationKey, params);
  const bytes = (n: number) => formatBytes(n, t);
  const duration = (ms: number) => formatDuration(ms, t);
  const time = (at: number) => formatTime(at, language);
  const path = (step: Pick<MessageSend, "path" | "relayed" | "relays">) => pathWords(step, t);
  const timeRow = (label: string, at: number): DetailRow => ({ label: L(label), value: time(at), mono: true, copy: new Date(at).toISOString() });
  const keyRow = (label: string, key: string): DetailRow => ({ label: L(label), value: publicKeyLabel(key), mono: true, copy: key });
  const idRow = (label: string, id: string): DetailRow => ({ label: L(label), value: id.length > 28 ? `${id.slice(0, 12)}…${id.slice(-8)}` : id, mono: true, copy: id });

  const senderKey = group ? view?.group?.member : mine ? link?.myKey : link?.peerKey;
  add("identity", [
    idRow("messageId", message.id),
    { label: L("kind"), value: kindWords },
    { label: L("direction"), value: message.sender === "system" ? V("system") : mine ? V("sentByYou") : V("received") },
    senderKey ? keyRow("senderKey", senderKey) : undefined,
    view?.message.wireId ? idRow("wireId", view.message.wireId) : undefined,
    link ? idRow("chatId", link.id) : view?.group ? idRow("groupId", view.group.id) : undefined,
    link?.profile ? link.deliveryMode === "dht" ? { label: L("chatProfile"), value: V("dhtOnly", { profile: link.profile }) } : { label: L("chatProfile"), value: link.profile, raw: true }
      : link ? { label: L("chatProfile"), value: V("compatibilityChat") } : undefined,
    view ? { label: L("textSize"), value: bytes(view.message.textBytes) } : undefined,
  ]);

  // An edited text (WISP 400 § Edits): how often, when last, and every earlier version kept, oldest first.
  const edit = message.edit;
  if (edit) add("edits", [
    { label: L("edits"), value: V("edits", { count: edit.seq, time: time(edit.at) }) },
    edit.pending ? group ? { label: L("group"), value: V("groupNotSent") } : { label: L("contact"), value: V("contactNotShown") } : undefined,
    ...edit.history.map((version): DetailRow => ({ label: t(version.at === shownTime(message) ? "messageDetails.label.original" : "messageDetails.label.before", { time: time(version.at) }), value: version.text, copy: version.text, raw: true })),
  ]);

  const last = d?.sends?.[d.sends.length - 1];
  const step = mine ? last : d?.received;
  add("path", [
    step ? { label: L(mine ? "sentOver" : "receivedOver"), value: path(step) } : undefined,
    step?.relays?.length ? { label: L("relay"), value: step.relays.join(", "), mono: true, copy: step.relays.join(", ") } : undefined,
    step?.rttMs !== undefined ? { label: L("roundTripThen"), value: duration(step.rttMs) } : undefined,
    d?.sends && d.sends.length > 1 ? { label: L("sends"), value: d.sends.map((s, i) => `${d.attempts && d.attempts > d.sends!.length && i > 0 ? "…" : ""}${time(s.at)} ${path(s)} (${s.result ?? "sending"}${s.error ? `: ${s.error}` : ""})`).join("\n"), mono: true } : undefined,
    link?.transportNow ? { label: L("connectionNow"), value: link.rttNowMs !== undefined
      ? V("connectionNow", { path: path({ path: link.transportNow, relayed: link.relayedNow }), rtt: duration(link.rttNowMs) })
      : path({ path: link.transportNow, relayed: link.relayedNow }) } : undefined,
  ]);

  const receipt = d?.receiptAt !== undefined && d.sentAt !== undefined ? d.receiptAt - d.sentAt : undefined;
  add("timing", [
    // What the sender's clock said, as it said it: beside "Received", a clock that is off shows.
    timeRow("composed", message.sentAt ?? message.timestamp),
    d?.sentAt !== undefined ? timeRow("sent", d.sentAt) : undefined,
    d?.heldAt !== undefined ? timeRow("held", d.heldAt) : undefined,
    d?.received ? timeRow("received", d.received.at) : undefined,
    d?.received ? { label: L("afterComposing"), value: V("afterComposing", { after: duration(Math.max(0, d.received.at - (message.sentAt ?? message.timestamp))) }) } : undefined,
    d?.receiptAt !== undefined ? timeRow(mine && last?.path === "hold" ? "pickedUp" : "receipt", d.receiptAt) : undefined,
    receipt !== undefined ? { label: L(mine && last?.path === "hold" ? "pickedUpAfter" : "receiptAfter"), value: duration(Math.max(0, receipt)) } : undefined,
    d?.completedAt !== undefined ? timeRow("transferCompleted", d.completedAt) : undefined,
    d?.attempts ? { label: L("attempts"), value: d.attempts === 1 ? V("attemptsOne") : V("attempts", { count: decimal(d.attempts, 0, language) }) } : undefined,
    view?.message.resendUntil ? timeRow("sendsAgainUntil", view.message.resendUntil) : undefined,
  ]);

  add("wire", [
    d?.wire ? { label: L("frame"), value: d.wire.frame, mono: true } : undefined,
    d?.wire ? { label: L("protocol"), value: d.wire.protocol, mono: true } : undefined,
    d?.wire?.plaintextBytes !== undefined ? { label: L("plaintext"), value: bytes(d.wire.plaintextBytes) } : undefined,
    d?.wire?.wireBytes !== undefined ? { label: L("onTheWire"), value: bytes(d.wire.wireBytes) } : undefined,
    d?.wire?.chunks !== undefined ? { label: L("chunks"), value: `${decimal(d.wire.chunks, 0, language)} × ${d.wire.chunkBytes ? bytes(d.wire.chunkBytes) : "?"}` } : undefined,
  ]);

  const way = step?.path ?? (view?.message.via === "hold" ? "hold" : view?.message.via === "pkarr" ? (link?.profile ? "dht" : "legacy-dht") : undefined);
  add("crypto", cryptoRows(way, view, group, t));

  // A file of mine whose bytes did not go was not sent, whatever became of the message that announced it: the bubble says so too.
  const fileEnded = mine && view?.file?.state ? FILE_NOT_SENT[view.file.state] : undefined;
  add("delivery", [
    fileEnded ? { label: L("state"), value: t(fileEnded) } : message.delivery ? { label: L("state"), value: t(DELIVERY_WORDS[message.delivery]) } : mine && view ? { label: L("state"), value: V("sent") } : undefined,
    fileEnded && view?.file?.error ? { label: L("why"), value: view.file.error, raw: true } : undefined,
    message.deliveryError && message.delivery !== "waiting" && !fileEnded ? { label: L("note"), value: message.deliveryError, raw: true } : undefined,
    message.delivery === "waiting" && message.deliveryError ? { label: L("whyItWaits"), value: message.deliveryError, raw: true } : undefined,
    mine && view?.message.wireId ? idRow("receiptId", view.message.wireId) : undefined,
    d?.hold?.seq !== undefined ? { label: L("heldItem"), value: d.hold.bytes ? V("heldItemSealed", { seq: d.hold.seq, size: bytes(d.hold.bytes) }) : V("heldItem", { seq: d.hold.seq }) } : undefined,
    d?.hold?.expires ? timeRow("heldUntil", d.hold.expires) : undefined,
  ]);

  if (view?.file) {
    const f = view.file;
    const storage = f.storage ? STORAGE[f.storage] : undefined;
    add("file", [
      { label: L("name"), value: f.name, raw: true },
      { label: L("type"), value: f.mime || V("unknown"), mono: !!f.mime },
      { label: L("size"), value: bytes(f.size) },
      f.digest ? { label: L("sha256"), value: `${f.digest.slice(0, 16)}…`, mono: true, copy: f.digest } : undefined,
      f.protocol ? { label: L("protocol"), value: f.protocol, mono: true } : undefined,
      f.state ? { label: L("transfer"), value: f.stage ? `${f.state} (${f.stage})` : f.state, raw: true } : undefined,
      f.confirmed !== undefined ? { label: L("confirmed"), value: V("confirmed", { size: bytes(f.confirmed) }) } : f.transferred !== undefined && f.state !== "done" ? { label: L("transferred"), value: bytes(f.transferred) } : undefined,
      f.since ? timeRow("offered", f.since) : undefined,
      f.consented !== undefined ? { label: L("acceptedBy"), value: V(f.consented ? "acceptedByPerson" : "acceptedByApp") } : undefined,
      f.storage ? storage ? { label: L("storedAs"), value: t(storage) } : { label: L("storedAs"), value: f.storage, raw: true } : undefined,
    ]);
    if (f.voice) add("voice", [
      { label: L("codec"), value: voiceCodec(f.mime, t) },
      { label: L("length"), value: duration(f.voice.duration) },
      f.voice.duration > 0 ? { label: L("bitrate"), value: t("messageDetails.unit.kbits", { n: decimal(Math.round(f.size * 8 / (f.voice.duration / 1000) / 1000), 0, language) }) } : undefined,
      { label: L("waveform"), value: t("messageDetails.unit.peaks", { count: decimal(f.voice.peaks, 0, language) }) },
    ]);
  }

  if (view?.payment) {
    const p = view.payment;
    add("payment", [
      idRow("paymentId", p.id),
      { label: L("kind"), value: V(`${p.kind === "request" ? "request" : "payment"}${p.direction === "out" ? "Out" : "In"}`) },
      { label: L("amount"), value: `${decimal(p.amount, 0, language)} ${p.unit}`, raw: true },
      p.method ? { label: L("rail"), value: [p.method, p.network, p.provider].filter(Boolean).join(" · "), raw: true } : undefined,
      { label: L("state"), value: p.state, raw: true },
      p.mint ? { label: L("mint"), value: p.mint, mono: true, copy: p.mint } : undefined,
      p.txid ? idRow("transaction", p.txid) : undefined,
      p.invoiceDigest ? { label: L("invoiceDigest"), value: `${p.invoiceDigest.slice(0, 16)}…`, mono: true, copy: p.invoiceDigest } : undefined,
      p.ask ? idRow("answersAsk", p.ask) : undefined,
      p.group ? idRow("group", p.group) : undefined,
      timeRow("created", p.createdAt),
      p.error ? { label: L("error"), value: p.error, raw: true } : undefined,
    ]);
  }

  const dht = d?.dht;
  const meta = !dht && message.meta && (message.meta.encryptedPayloadLength > 0 || message.meta.packetTimestamp) ? message.meta : undefined;
  if (dht || meta) add("dht", [
    dht?.recordKey ? keyRow("recordKey", dht.recordKey) : meta ? keyRow("recordKey", meta.dhtKey) : undefined,
    dht?.seq !== undefined ? { label: L("sequence"), value: String(dht.seq), mono: true } : undefined,
    dht?.issued !== undefined ? timeRow("packetIssued", dht.issued) : meta?.packetTimestamp ? timeRow("packetIssued", meta.packetTimestamp) : undefined,
    dht?.expires !== undefined ? timeRow("expires", dht.expires) : undefined,
    dht?.packetBytes !== undefined ? { label: L("signedPacket"), value: bytes(dht.packetBytes) } : meta?.encryptedPayloadLength ? { label: L("sealedPayload"), value: bytes(meta.encryptedPayloadLength) } : undefined,
    dht?.nonce ? { label: L("nonce"), value: dht.nonce, mono: true, copy: dht.nonce } : undefined,
    dht?.records?.length ? { label: L("records"), value: dht.records.join(", "), mono: true } : meta?.dnsRecords.length ? { label: L("records"), value: meta.dnsRecords.join(", "), mono: true } : undefined,
  ]);

  if (view?.group) add("group", [
    idRow("groupId", view.group.id),
    view.group.profile ? { label: L("profile"), value: `group-${view.group.profile}/1`, mono: true } : undefined,
    view.group.member ? keyRow("memberKey", view.group.member) : undefined,
  ]);

  if (message.callEvent) {
    const event = CALL_EVENTS[message.callEvent.type];
    add("call", [
      event ? { label: L("event"), value: t(event) } : { label: L("event"), value: message.callEvent.type, raw: true },
      { label: L("video"), value: V(message.callEvent.hasVideo ? "yes" : "no") },
      message.callEvent.duration ? { label: L("length"), value: formatCallLength(message.callEvent.duration, t) } : undefined,
    ]);
  }

  const summary = summarize(message, view, kind, t);
  const json: Record<string, unknown> = {
    id: message.id, kind: kindWords, summary,
    ...Object.fromEntries(sections.map(s => [s.id, Object.fromEntries(s.rows.map(r => [r.label, r.copy ?? r.value]))])),
    ...(view && { engine: view }),
  };
  return { summary, kind: kindWords, sections, json };
}
