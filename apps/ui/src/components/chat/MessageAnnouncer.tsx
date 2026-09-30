import { useEffect, useRef, useState } from "react";
import type { StatusCard } from "@ghostly/core";
import { useI18n } from "../../contexts/I18nContext";
import { previewText } from "../../lib/chatList";
import { cardLine, showsCard } from "../../lib/statusCards";

/** What the announcer reads of a message: a 1:1 chat's and a group's both have it. */
export interface Announceable {
  id: string;
  sender: string;
  text: string;
  card?: StatusCard;
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

const short = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1).trimEnd()}…` : line;
};

/**
 * Tells a screen reader, politely, that a message came into the open chat: who and the start of what, one line per
 * message, or a count when several come at once. The timeline itself is not a live region (it would read out every
 * row it draws); this one line is. The chat's history, my own messages and the chat's notes (joins, calls) are not
 * read out.
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
  const seen = useRef<{ chat: string; ids: Set<string>; last?: string } | null>(null);
  const pending = useRef<Announceable[]>([]);
  const timers = useRef<{ flush?: ReturnType<typeof setTimeout>; clear?: ReturnType<typeof setTimeout> }>({});
  const words = useRef({ t, nameOf, active });
  words.current = { t, nameOf, active };

  useEffect(() => {
    const known = seen.current;
    // A chat just opened (or another one): what it already has is history, not news.
    if (!known || known.chat !== chat) {
      seen.current = { chat, ids: new Set(messages.map(m => m.id)), last: messages[messages.length - 1]?.id };
      pending.current = [];
      clearTimeout(timers.current.flush);
      timers.current.flush = undefined;
      return;
    }
    // Only what comes after the last message known: older history loaded above it is not new.
    const from = known.last === undefined ? 0 : messages.findIndex(m => m.id === known.last) + 1;
    const fresh = from > 0 || known.last === undefined ? messages.slice(from).filter(m => !known.ids.has(m.id)) : [];
    for (const m of messages) known.ids.add(m.id);
    if (messages.length) known.last = messages[messages.length - 1].id;
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
      const line = batch.length === 1
        ? t("chat.announce.message", { name: nameOf(batch[0]), text: short(showsCard(batch[0].card) ? cardLine(batch[0].card) : previewText(batch[0].text, t)) })
        : names.size === 1
        ? t("chat.announce.messagesFrom", { count: batch.length, name: [...names][0] })
        : t("chat.announce.messages", { count: batch.length });
      setText(line);
      clearTimeout(timers.current.clear);
      timers.current.clear = setTimeout(() => setText(""), ANNOUNCE_CLEAR_MS);
    }, ANNOUNCE_WINDOW_MS);
  }, [chat, messages, active]);

  useEffect(() => () => { clearTimeout(timers.current.flush); clearTimeout(timers.current.clear); }, []);
  // Another chat: nothing of the last one is read out in this one.
  useEffect(() => { setText(""); }, [chat]);

  return <p className="sr-only" aria-live="polite" aria-atomic="true" data-testid="chat-announcement">{text}</p>;
}
