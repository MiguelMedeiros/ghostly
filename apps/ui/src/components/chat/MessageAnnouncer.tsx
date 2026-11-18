import { useEffect, useRef, useState } from "react";
import type { StatusCard } from "@ghostly/core";
import type { GroupPayNote } from "@ghostly/browser/shared/types";
import { useI18n, type Translate } from "../../contexts/I18nContext";
import { useOnline } from "../../hooks/useOnline";
import { filePreview, previewText } from "../../lib/chatList";
import { fileMoment, fileMomentLine, fileOfferLine, type FileMoment } from "../../lib/fileAnnounce";
import { isGroupFile } from "../../lib/fileStatus";
import { servicesPlatform, type ChatPayment } from "../../lib/platform";
import type { ChatFile } from "../../lib/types";
import { paymentLine, paymentStateLine, storedPaymentLine } from "../paymentWords";
import { appCardLine, appCardsShown, cardLine, showsCard } from "../../lib/statusCards";
import { useAppsAvailable } from "../../lib/apps/flag";

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
  /** A group's note about a payment between two members: a change of where it stands is said (`noteLine`). */
  groupPay?: GroupPayNote;
  /** Where a message of mine is (ChatMessage's `delivery`): one that turns not sent, or starts waiting, is said. */
  delivery?: string;
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
 * or a video's (filePreview, as the chat list), else its text. An app card's line only where the chat's bubbles draw it
 * as a card (`appCards`: `appCardsShown`), its text elsewhere, as the bubble shows it. A group's payment note as its
 * timeline shows it (`noteLine`), not the engine's English line.
 */
function spoken(message: Announceable, t: Translate, appCards: boolean, noteLine?: (note: GroupPayNote) => string | null): string {
  if (showsCard(message.card)) return cardLine(message.card);
  const note = message.groupPay && noteLine?.(message.groupPay);
  if (note) return note;
  const wallet = message.paymentId ? servicesPlatform?.wallet : undefined;
  const payment = wallet?.getPayment(message.paymentId!);
  if (payment) return paymentLine(t, payment, wallet!.getState());
  // A payment the wallet does not know (yet): its stored English line, said as the bubble says it.
  if (message.paymentId) return storedPaymentLine(t, message.text, message.sender === "me");
  return appCardLine(message.card, appCards, t) ?? filePreview(message.file, t) ?? previewText(message.text, t);
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

/** The steps of a text of mine that need the person: it was not sent (send it again), or it waits for the contact. */
type Turn = "failed" | "waiting";
const turnOf = (delivery: string | undefined): Turn | undefined =>
  delivery === "failed" ? "failed" : delivery === "waiting" ? "waiting" : undefined;

/** A message of mine whose delivery is followed: a file says its own steps (fileMomentLine), a chat's note none. */
const mineFollowed = (m: Announceable) => m.sender === "me" && !m.file && !m.systemEvent && !m.callEvent && !m.event;
/** A text of mine as last seen: where it was in the list, and its delivery. */
interface Watched { at: number; delivery: string }

const heardNow = (message: Announceable & { file: ChatFile }, since: number): FileHeard =>
  ({ message, moment: fileMoment(servicesPlatform?.getTransfer(message.file.id) ?? null), since });

/**
 * A payment or a request of the chat, as last seen: its state line (`paymentStateLine`, as its bubble says it; null
 * while the wallet does not know it) and the language it was said in, so another language is no step of its own. The
 * payment it was worked out of: an engine state that brings that one back unchanged is no reason to work it out again.
 */
interface PaymentHeard { paymentId: string; line: string | null; language?: string; payment?: ChatPayment }
/** A message whose payment's state is followed: a group's note says its own (`noteLine`). */
const paid = (m: Announceable): m is Announceable & { paymentId: string } => !!m.paymentId && !m.groupPay;
const paymentNow = (paymentId: string, t: Translate): PaymentHeard => {
  const payment = servicesPlatform?.wallet?.getPayment(paymentId);
  return { paymentId, line: payment ? paymentStateLine(t, payment) : null, language: t.language, payment: payment ?? undefined };
};

/** Where a group's payment note stands, in no language: a member named again is no step of it. */
const noteKey = (note: GroupPayNote) => JSON.stringify([note.state, note.by ?? "", note.claims ?? []]);
/** A note that can still take a step: paid and closed are where it stays. */
const noteOpen = (note: GroupPayNote) => note.state !== "paid" && note.state !== "closed";

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
 *
 * A text of mine says only the steps that need me: it turned not sent, or it started waiting for the contact to be
 * online (said only while this device is online: offline, every text waits for this device instead). Sent, delivered
 * and read are not said. What the chat had as it opened is not said either; steps that come together are one line,
 * a count when there are several.
 *
 * A payment or a request says where it stands each time that changes, as its bubble's state line does (Paid, Received,
 * Failed, Taken back), once; a group's payment note too (`noteLine`). Never their first draw: what the chat had as it
 * opened, a payment just in the chat (its arrival is said), one the wallet comes to know.
 */
export function MessageAnnouncer({ chat, linkId, messages, nameOf, noteLine, active = true, ready = true }: {
  chat: string;
  /**
   * The chat as its bubbles are given it (`MessageBubble`'s `linkId`): an app card is read as its card where they draw
   * one (`appCardsShown`), as its text where they show its text (a group, a v0.4 chat, Apps off).
   */
  linkId?: string;
  messages: readonly Announceable[];
  nameOf(message: Announceable): string;
  /**
   * A group's payment note as its timeline shows it (who pays whom, how much, where it stands): said when it changes.
   * Nothing for a note the timeline does not draw (one said by a payment's own bubble).
   */
  noteLine?(note: GroupPayNote): string | null;
  /** The chat is on screen. A chat kept open behind another one reads nothing out. */
  active?: boolean;
  /**
   * The chat's history is in. Until it is, what the chat has is not what it had as it opened (a group's history comes
   * a moment after its first draw): what it has once its history is in is history, not news.
   */
  ready?: boolean;
}) {
  const { t } = useI18n();
  const online = useOnline();
  const [text, setText] = useState("");
  /** `at`: where `last` was, so rows that came or went above it are noticed. */
  const seen = useRef<{ chat: string; ids: Set<string>; last?: string; at: number } | null>(null);
  const pending = useRef<Announceable[]>([]);
  /** The chat's messages as last drawn: what is pending is read from them, as it stands when the window ends. */
  const latest = useRef(messages);
  latest.current = messages;
  const timers = useRef<{ flush?: ReturnType<typeof setTimeout>; clear?: ReturnType<typeof setTimeout>; turns?: ReturnType<typeof setTimeout> }>({});
  const appCards = appCardsShown(linkId, useAppsAvailable());
  const words = useRef({ t, nameOf, noteLine, active, online, appCards });
  words.current = { t, nameOf, noteLine, active, online, appCards };
  /** My texts that can still take a step (not delivered yet), by message id: a change to not sent or waiting is said. */
  const watched = useRef(new Map<string, Watched>());
  /** My texts that took such a step since the last line, by id: said together once the window is over. */
  const turns = useRef(new Map<string, { message: Announceable; turn: Turn }>());
  /** Lines waiting for the one being read to clear: two that come together are both read, one after the other. */
  const queued = useRef<string[]>([]);
  /** The chat's 1:1 files, by file id: kept as the rows come, so a step is not looked for in the whole history. */
  const files = useRef(new Map<string, FileHeard>());
  /** The chat's payments and requests, by message id: kept as the rows come, as the files are. */
  const payments = useRef(new Map<string, PaymentHeard>());
  /** The group's payment notes that can still take a step, by message id: where each was in the list, and where it stood. */
  const notes = useRef(new Map<string, { at: number; key: string }>());

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
  /** Looks at each payment of the chat again: one whose state line changed says it once, with what it is. */
  const checkPayments = useRef(() => {});
  checkPayments.current = () => {
    const { t, active } = words.current;
    const wallet = servicesPlatform?.wallet;
    for (const heard of payments.current.values()) {
      const payment = wallet?.getPayment(heard.paymentId);
      if (!payment || (payment === heard.payment && heard.language === t.language)) continue;
      heard.payment = payment;
      const line = paymentStateLine(t, payment);
      if (line === heard.line && heard.language === t.language) continue;
      const before = heard.line, sameLanguage = heard.language === t.language;
      heard.line = line;
      heard.language = t.language;
      // Not known before (the wallet just loaded it), said in another language, or nothing to say: no news.
      if (before === null || !sameLanguage || !active || !line) continue;
      sayRef.current(t("chat.announce.paymentState", { payment: paymentLine(t, payment, wallet!.getState()), state: line }));
    }
  };
  useEffect(() => servicesPlatform?.subscribe(() => { checkFiles.current(); checkPayments.current(); }), []);

  /**
   * Looks at the group's payment notes that can still take a step, where they were, and the new rows (the whole list
   * when rows came or went above, as for my texts): a note that took one says it once. A note just in the chat counts
   * from where it stands (its arrival is said), as does one that was there as the chat opened.
   */
  const checkNotes = useRef((_messages: readonly Announceable[], _from: number, _reread: boolean) => {});
  checkNotes.current = (messages, from, reread) => {
    const before = notes.current;
    let whole = reread;
    if (!whole) for (const [id, { at }] of before) if (messages[at]?.id !== id) { whole = true; break; }
    const after = whole ? new Map<string, { at: number; key: string }>() : before;
    const { noteLine, active } = words.current;
    const look = (m: Announceable | undefined, at: number) => {
      const note = m?.groupPay;
      if (!m || !note) return;
      const key = noteKey(note), was = before.get(m.id);
      if (noteOpen(note)) after.set(m.id, { at, key });
      else after.delete(m.id);
      const line = was && was.key !== key && active && noteLine?.(note);
      if (line) sayRef.current(line);
    };
    if (whole) messages.forEach(look);
    else {
      for (const { at } of [...before.values()]) look(messages[at], at);
      for (let at = from; at < messages.length; at++) look(messages[at], at);
    }
    notes.current = after;
  };

  /**
   * Looks at the delivery of my texts that can still take a step: one that turned not sent or started waiting is kept
   * for the next line. A text just in the chat (sent now) counts from nothing; one that was there as the chat opened, or
   * appeared above (older history), is history. Only those texts are looked at, where they were, and the new rows: the
   * whole list only when rows came or went above (`reread`), as for the messages themselves.
   */
  const checkDeliveries = useRef((_messages: readonly Announceable[], _fresh: readonly Announceable[], _from: number, _reread: boolean) => {});
  checkDeliveries.current = (messages, fresh, from, reread) => {
    const before = watched.current;
    const now = new Set(fresh.map(m => m.id));
    // A watched text not where it was (it took another id in place): the whole list then.
    let whole = reread;
    if (!whole) for (const [id, { at }] of before) if (messages[at]?.id !== id) { whole = true; break; }
    const after = whole ? new Map<string, Watched>() : before;
    const look = (m: Announceable, at: number) => {
      if (!mineFollowed(m)) return;
      const was = before.get(m.id);
      const prior = was ? was.delivery : now.has(m.id) ? undefined : m.delivery;
      // Delivered is where a text stays; a text with no delivery state is one from before them.
      if (m.delivery && m.delivery !== "delivered") after.set(m.id, { at, delivery: m.delivery });
      else after.delete(m.id);
      const turn = turnOf(m.delivery);
      if (turn && turnOf(prior) !== turn && words.current.active) turns.current.set(m.id, { message: m, turn });
    };
    if (whole) messages.forEach(look);
    else {
      for (const { at } of [...before.values()]) look(messages[at], at);
      for (let at = from; at < messages.length; at++) if (now.has(messages[at].id)) look(messages[at], at);
    }
    watched.current = after;
    if (!turns.current.size || timers.current.turns) return;
    timers.current.turns = setTimeout(() => {
      timers.current.turns = undefined;
      const { t, active, online, appCards } = words.current;
      // Only what still stands: a text sent again (or delivered after all) within the window is no news.
      const batch = [...turns.current.values()].filter(({ message, turn }) => turnOf(watched.current.get(message.id)?.delivery) === turn);
      turns.current.clear();
      if (!active) return;
      const failed = batch.filter(b => b.turn === "failed").map(b => b.message);
      const waiting = online ? batch.filter(b => b.turn === "waiting").map(b => b.message) : [];
      // One text: a sentence of its own with what it says inside it. Not the line a message is read in ("Not sent: …"),
      // which a contact named "Not sent" would say word for word with any text it sends.
      const line = (list: Announceable[], one: "chat.announce.notSent" | "chat.announce.waiting", count: "chat.announce.notSentCount" | "chat.announce.waitingCount") =>
        list.length === 1 ? t(one, { text: short(spoken(list[0], t, appCards)) }) : t(count, { count: list.length });
      if (failed.length) sayRef.current(line(failed, "chat.announce.notSent", "chat.announce.notSentCount"));
      if (waiting.length) sayRef.current(line(waiting, "chat.announce.waiting", "chat.announce.waitingCount"));
    }, ANNOUNCE_WINDOW_MS);
  };

  useEffect(() => {
    const known = seen.current;
    // A chat just opened (or another one): what it already has is history, not news. One whose history is not in yet
    // takes it once it is.
    if (!ready || !known || known.chat !== chat) {
      seen.current = ready ? { chat, ids: new Set(messages.map(m => m.id)), last: messages[messages.length - 1]?.id, at: messages.length - 1 } : null;
      files.current = new Map(messages.filter(followed).map(m => [m.file.id, heardNow(m, -Infinity)]));
      watched.current = new Map();
      payments.current = new Map();
      notes.current = new Map();
      messages.forEach((m, at) => {
        if (mineFollowed(m) && m.delivery && m.delivery !== "delivered") watched.current.set(m.id, { at, delivery: m.delivery });
        if (paid(m)) payments.current.set(m.id, paymentNow(m.paymentId, words.current.t));
        if (m.groupPay && noteOpen(m.groupPay)) notes.current.set(m.id, { at, key: noteKey(m.groupPay) });
      });
      pending.current = [];
      turns.current.clear();
      clearTimeout(timers.current.flush);
      clearTimeout(timers.current.turns);
      timers.current.flush = undefined;
      timers.current.turns = undefined;
      return;
    }
    // Only what comes after the last message known: older history loaded above it is not new. It is looked for from the
    // end, where a message coming in leaves it, so a long chat's history is not walked for each one. That one may be
    // gone in this same update (deleted, or mine taking its sent id as the contact's answer came): the one known
    // before it then.
    let at = messages.length - 1;
    while (at >= 0 && !known.ids.has(messages[at].id)) at--;
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
      // A payment's message likewise; one there now and not followed yet (older history) counts from where it stands.
      const before = payments.current;
      payments.current = new Map(messages.filter(paid).map(m => [m.id, before.get(m.id) ?? paymentNow(m.paymentId, words.current.t)]));
    }
    const now = Date.now();
    for (const m of fresh) {
      if (followed(m) && !files.current.has(m.file.id)) files.current.set(m.file.id, heardNow(m, now));
      if (paid(m) && !payments.current.has(m.id)) payments.current.set(m.id, paymentNow(m.paymentId, words.current.t));
    }
    checkFiles.current();
    checkPayments.current();
    checkNotes.current(messages, from, reread);
    checkDeliveries.current(messages, fresh, from, reread);
    if (messages.length) known.last = messages[messages.length - 1].id;
    known.at = messages.length - 1;
    // A note the timeline does not draw (no `noteLine`) is not news either: the payment's own bubble says it.
    const unsaid = (m: Announceable) => !!m.groupPay && words.current.noteLine?.(m.groupPay) === null;
    const incoming = fresh.filter(m => m.sender === "peer" && !m.systemEvent && !m.callEvent && !m.event && !unsaid(m));
    if (!incoming.length || !active) return;
    pending.current.push(...incoming);
    if (timers.current.flush) return;
    timers.current.flush = setTimeout(() => {
      timers.current.flush = undefined;
      // Only what is still in the chat, as it is now: one deleted within the window is not read out, one edited is read
      // as it stands. Looked for from the end, where they came in.
      const wanted = new Set(pending.current.map(m => m.id));
      pending.current = [];
      const list = latest.current, batch: Announceable[] = [];
      for (let at = list.length - 1; at >= 0 && batch.length < wanted.size; at--) if (wanted.has(list[at].id)) batch.unshift(list[at]);
      const { t, nameOf, noteLine, active, appCards } = words.current;
      if (!batch.length || !active) return;
      const names = new Set(batch.map(m => nameOf(m)));
      const offer = batch.length === 1 && batch[0].file ? fileOfferLine(batch[0].file, servicesPlatform?.getTransfer(batch[0].file.id) ?? null, nameOf(batch[0]), t) : null;
      const line = offer ?? (batch.length === 1
        ? t("chat.announce.message", { name: nameOf(batch[0]), text: short(spoken(batch[0], t, appCards, noteLine)) })
        : names.size === 1
        ? t("chat.announce.messagesFrom", { count: batch.length, name: [...names][0] })
        : t("chat.announce.messages", { count: batch.length }));
      sayRef.current(line);
    }, ANNOUNCE_WINDOW_MS);
  }, [chat, messages, active, ready]);

  useEffect(() => () => { clearTimeout(timers.current.flush); clearTimeout(timers.current.clear); clearTimeout(timers.current.turns); }, []);
  // Another chat: nothing of the last one is read out in this one.
  useEffect(() => {
    setText("");
    queued.current = [];
    clearTimeout(timers.current.clear);
    timers.current.clear = undefined;
  }, [chat]);

  return <p className="sr-only" aria-live="polite" aria-atomic="true" data-testid="chat-announcement">{text}</p>;
}
