import { useEffect, useRef, useState } from "react";
import type { StatusCard } from "@ghostly/core";
import { useI18n, type Translate } from "../../contexts/I18nContext";
import { filePreview, previewText } from "../../lib/chatList";
import { fileMoment, fileMomentLine, fileOfferLine, type FileMoment } from "../../lib/fileAnnounce";
import { isGroupFile } from "../../lib/fileStatus";
import { servicesPlatform } from "../../lib/platform";
import type { ChatFile } from "../../lib/types";
import { paymentLine } from "../paymentWords";
import { appCardLine, cardLine, showsCard } from "../../lib/statusCards";

/** What the announcer reads of a message: a 1:1 chat's and a group's both have it. */
export interface Announceable {
  id: string;
  sender: string;
  text: string;
  card?: StatusCard;
  /** A payment or a request: read out as the chat list says it, not as the English line the engine keeps. */
  paymentId?: string;
  /** A voice message or a video: read out as the chat list says it too, its text being the history's English line. */
  file?: ChatFile;
  member?: string;
  systemEvent?: unknown;
  callEvent?: unknown;
  event?: unknown;
}

/** Messages that arrive within this long of the first are read out together, as a count. */
export const ANNOUNCE_WINDOW_MS = 1_500;
/** How long an announcement stays before the region empties, so the same words next time are a change again. */
export const ANNOUNCE_CLEAR_MS = 1_000;
/** A message is read out up to this many characters. */
const PREVIEW_CHARS = 80;

/**
 * What a message says, read out: a status card's line, a payment's (paymentLine, as the chat list), a voice message's
 * or a video's (filePreview, as the chat list), else its text.
 */
function spoken(message: Announceable, t: Translate): string {
  if (showsCard(message.card)) return cardLine(message.card);
  const wallet = message.paymentId ? servicesPlatform?.wallet : undefined;
  const payment = wallet?.getPayment(message.paymentId!);
  return payment ? paymentLine(t, payment, wallet!.getState()) : appCardLine(message.card, t) ?? filePreview(message.file, t) ?? previewText(message.text, t);
}

const short = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : line;
};

/**
 * A chat's 1:1 file, as last heard: its message, where it stood, and since when it is in the chat (`-Infinity`: it
 * was there as the chat opened).
 */
interface FileHeard { message: Announceable & { file: ChatFile }; moment: FileMoment | null; since: number }

/** A message whose 1:1 file's steps are followed: a group's file is fetched, never answered, paused or cancelled. */
const followed = (m: Announceable): m is Announceable & { file: ChatFile } =>
  !!m.file && !isGroupFile(m.file) && !m.systemEvent && !m.callEvent && !m.event;

const heardNow = (message: Announceable & { file: ChatFile }, since: number): FileHeard =>
  ({ message, moment: fileMoment(servicesPlatform?.getTransfer(message.file.id) ?? null), since });

/**
 * Tells a screen reader, politely, that a message came into the open chat: who and the start of what, one line per
 * message, or a count when several come at once. The timeline itself is not a live region (it would read out every
 * row it draws); this one line is. The chat's history, my own messages and the chat's notes (joins, calls) are not
 * read out.
 *
 * A 1:1 file says more, in the same line: an offer that waits for this person's answer says so as it arrives, and
 * each later step its person did not take is read out once (the contact accepted, declined, paused, went on or
 * cancelled; it arrived; it failed), never its progress. A step within the arrival window of a file just in the chat
 * is part of how it arrived (a small file done at once), not news of its own.
 */
export function MessageAnnouncer({ chat, messages, nameOf, active = true }: {
  chat: string;
  messages: readonly Announceable[];
  nameOf(message: Announceable): string;
  /** The chat is on screen. A chat kept open behind another one reads nothing out. */
  active?: boolean;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  /** `at`: where `last` was, so rows that came or went above it are noticed. */
  const seen = useRef<{ chat: string; ids: Set<string>; last?: string; at: number } | null>(null);
  const pending = useRef<Announceable[]>([]);
  const timers = useRef<{ flush?: ReturnType<typeof setTimeout>; clear?: ReturnType<typeof setTimeout> }>({});
  const words = useRef({ t, nameOf, active });
  words.current = { t, nameOf, active };
  /** Lines waiting for the one being read to clear: two that come together are both read, one after the other. */
  const queued = useRef<string[]>([]);
  /** The chat's 1:1 files, by file id: kept as the rows come, so a step is not looked for in the whole history. */
  const files = useRef(new Map<string, FileHeard>());

  const say = (line: string) => {
    if (timers.current.clear) { queued.current.push(line); return; }
    setText(line);
    const next = () => {
      const after = queued.current.shift();
      setText(after ?? "");
      timers.current.clear = after === undefined ? undefined : setTimeout(next, ANNOUNCE_CLEAR_MS);
    };
    timers.current.clear = setTimeout(next, ANNOUNCE_CLEAR_MS);
  };
  const sayRef = useRef(say);
  sayRef.current = say;

  /** Looks at each 1:1 file of the chat again: a step it took is read out once; its progress is no step. */
  const checkFiles = useRef(() => {});
  checkFiles.current = () => {
    const { t, nameOf, active } = words.current;
    const now = Date.now();
    for (const heard of files.current.values()) {
      const file = heard.message.file;
      const transfer = servicesPlatform?.getTransfer(file.id) ?? null;
      const moment = fileMoment(transfer);
      if (moment === heard.moment || moment === null) continue;
      const before = heard.moment;
      heard.moment = moment;
      if (!active || now - heard.since < ANNOUNCE_WINDOW_MS) continue;
      const line = fileMomentLine(file, before, moment, transfer, nameOf(heard.message), t);
      if (line) sayRef.current(line);
    }
  };
  useEffect(() => servicesPlatform?.subscribe(() => checkFiles.current()), []);

  useEffect(() => {
    const known = seen.current;
    // A chat just opened (or another one): what it already has is history, not news.
    if (!known || known.chat !== chat) {
      seen.current = { chat, ids: new Set(messages.map(m => m.id)), last: messages[messages.length - 1]?.id, at: messages.length - 1 };
      files.current = new Map(messages.filter(followed).map(m => [m.file.id, heardNow(m, -Infinity)]));
      pending.current = [];
      clearTimeout(timers.current.flush);
      timers.current.flush = undefined;
      return;
    }
    // Only what comes after the last message known: older history loaded above it is not new. It is looked for from the
    // end, where a message coming in leaves it, so a long chat's history is not walked for each one.
    let at = messages.length - 1;
    while (at >= 0 && messages[at].id !== known.last) at--;
    const from = known.last === undefined ? 0 : at + 1;
    const fresh = from > 0 || known.last === undefined ? messages.slice(from).filter(m => !known.ids.has(m.id)) : [];
    // The rows above it are known already unless some came or went there (older history, a late one sorted in, one
    // deleted): only then is every id read again.
    const reread = !(from > 0 && at === known.at);
    for (const m of reread ? messages : messages.slice(from)) known.ids.add(m.id);
    // A file whose message went (deleted) is followed no more; one just in the chat is from now on.
    if (reread) {
      const kept = new Set(messages.filter(followed).map(m => m.file.id));
      for (const id of files.current.keys()) if (!kept.has(id)) files.current.delete(id);
    }
    const now = Date.now();
    for (const m of fresh) if (followed(m) && !files.current.has(m.file.id)) files.current.set(m.file.id, heardNow(m, now));
    checkFiles.current();
    if (messages.length) known.last = messages[messages.length - 1].id;
    known.at = messages.length - 1;
    const incoming = fresh.filter(m => m.sender === "peer" && !m.systemEvent && !m.callEvent && !m.event);
    if (!incoming.length || !active) return;
    pending.current.push(...incoming);
    if (timers.current.flush) return;
    timers.current.flush = setTimeout(() => {
      timers.current.flush = undefined;
      const batch = pending.current;
      pending.current = [];
      const { t, nameOf, active } = words.current;
      if (!batch.length || !active) return;
      const names = new Set(batch.map(m => nameOf(m)));
      const offer = batch.length === 1 && batch[0].file ? fileOfferLine(batch[0].file, servicesPlatform?.getTransfer(batch[0].file.id) ?? null, nameOf(batch[0]), t) : null;
      const line = offer ?? (batch.length === 1
        ? t("chat.announce.message", { name: nameOf(batch[0]), text: short(spoken(batch[0], t)) })
        : names.size === 1
        ? t("chat.announce.messagesFrom", { count: batch.length, name: [...names][0] })
        : t("chat.announce.messages", { count: batch.length }));
      sayRef.current(line);
    }, ANNOUNCE_WINDOW_MS);
  }, [chat, messages, active]);

  useEffect(() => () => { clearTimeout(timers.current.flush); clearTimeout(timers.current.clear); }, []);
  // Another chat: nothing of the last one is read out in this one.
  useEffect(() => {
    setText("");
    queued.current = [];
    clearTimeout(timers.current.clear);
    timers.current.clear = undefined;
  }, [chat]);

  return <p className="sr-only" aria-live="polite" aria-atomic="true" data-testid="chat-announcement">{text}</p>;
}
