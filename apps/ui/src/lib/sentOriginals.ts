import { useEffect, useReducer } from "react";
import { getPrefix } from "./storage";
import { composeMentions, type MentionView } from "./parse/mentions";

/*
 * The originals of what I sent translated (docs/AUTO-TRANSLATE.md § Outgoing translation): the contact gets only the
 * translation, as an ordinary text, and this device keeps what I typed beside it, so my bubble says "Translated to
 * Italian · Show original". The original never leaves this device: not sent, not synced to my other devices, never in
 * a backup or a handoff (profileBackup.ts leaves the keys out). It goes with its message (deleted here or for everyone)
 * and with its chat (deleted, left). Losing it only loses the Show original line.
 *
 * One key per chat under the profile's prefix, `sent_originals_<chat>` (`<chat>`: a session id, or `group:<id>` as
 * the mute store names a group), holding message id -> { to, original }, oldest first.
 */

/** What I typed, and the language it was sent in (an ISO 639 code, "it"). */
export interface SentOriginal { to: string; original: string }

/** Sent on this page when an original is kept or forgotten (another page of the app sees `storage`). */
export const SENT_ORIGINALS_EVENT = "sent-originals-updated";

/**
 * At most this many originals per chat, and this many characters in all: the oldest go first. A chat's history can be
 * far longer than what the page's storage holds (5 MB in WebKit), and a message whose original went keeps its text.
 */
export const KEPT_ORIGINALS = 200;
export const KEPT_ORIGINAL_CHARS = 100_000;

/** What follows the profile's prefix in these keys: profileBackup.ts leaves every key that starts with it out. */
export const SENT_ORIGINALS_SUFFIX = "sent_originals_";
const originalsKey = (chat: string) => `${getPrefix()}${SENT_ORIGINALS_SUFFIX}${chat}`;

type Originals = Record<string, SentOriginal>;

function parse(raw: string): Originals {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Originals = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const { to, original } = (value ?? {}) as Partial<SentOriginal>;
      if (typeof to === "string" && typeof original === "string") out[id] = { to, original };
    }
    return out;
  } catch { return {}; }
}

// Every bubble of mine asks for its original: a chat's key is parsed once per value, not once per bubble.
const parsed = new Map<string, { raw: string; originals: Originals }>();

/** A copy of a chat's originals, for a change. */
function read(chat: string): Originals {
  return { ...readShared(chat) };
}
function readShared(chat: string): Readonly<Originals> {
  const key = originalsKey(chat);
  let raw: string | null;
  try { raw = localStorage.getItem(key); } catch { return {}; }
  if (!raw) { parsed.delete(key); return {}; }
  const cached = parsed.get(key);
  if (cached?.raw === raw) return cached.originals;
  const originals = parse(raw);
  parsed.set(key, { raw, originals });
  return originals;
}

function write(chat: string, originals: Originals): void {
  try {
    if (Object.keys(originals).length === 0) localStorage.removeItem(originalsKey(chat));
    else localStorage.setItem(originalsKey(chat), JSON.stringify(originals));
  } catch { /* storage full or unavailable: the bubble shows the sent text alone */ }
  window.dispatchEvent(new Event(SENT_ORIGINALS_EVENT));
}

/**
 * Keeps what I typed beside a message I sent translated. `chat`: the session id, or `groupChat(id)`. Called by the send
 * path once the message has its id; an empty original is not kept.
 */
export function keepSentOriginal(chat: string, messageId: string, { to, original }: SentOriginal): void {
  if (!original.trim() || !to) return;
  const originals = read(chat);
  delete originals[messageId];
  originals[messageId] = { to, original };
  const ids = Object.keys(originals);
  let count = ids.length, chars = ids.reduce((sum, id) => sum + originals[id].original.length, 0);
  // The oldest go first; the one just kept stays, even alone over the limit (a message is at most 16 KiB).
  for (const id of ids) {
    if ((count <= KEPT_ORIGINALS && chars <= KEPT_ORIGINAL_CHARS) || id === messageId) break;
    chars -= originals[id].original.length;
    count -= 1;
    delete originals[id];
  }
  write(chat, originals);
}

/** The original of a message I sent translated, or undefined (not translated, sent from another device, or forgotten). */
export function sentOriginal(chat: string, messageId: string): SentOriginal | undefined {
  return readShared(chat)[messageId];
}

/** Forgets one message's original, with the message. */
export function forgetSentOriginal(chat: string, messageId: string): void {
  const originals = read(chat);
  if (!(messageId in originals)) return;
  delete originals[messageId];
  setShowsOriginal(chat, messageId, false);
  write(chat, originals);
}

/** Forgets every original of a chat, with the chat. */
export function forgetSentOriginals(chat: string): void {
  try { localStorage.removeItem(originalsKey(chat)); } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event(SENT_ORIGINALS_EVENT));
}

/*
 * Which of my translated messages show their original now (Show original): remembered per message while the app runs,
 * so a bubble scrolled away and back, or another chat opened in between, keeps what was chosen; forgotten at the next
 * start. Never stored.
 */
const showingOriginal = new Set<string>();
const shownKey = (chat: string, messageId: string) => `${chat}\n${messageId}`;
export function showsOriginal(chat: string, messageId: string): boolean {
  return showingOriginal.has(shownKey(chat, messageId));
}
export function setShowsOriginal(chat: string, messageId: string, shows: boolean): void {
  if (shows) showingOriginal.add(shownKey(chat, messageId));
  else showingOriginal.delete(shownKey(chat, messageId));
}

/**
 * The mentions of a group message as they fall in its original. A message's mention places are the translation's (the
 * text that was sent); the same "@Ann" sits elsewhere in what I typed, so each is found again there by what the
 * translation has at its place. One the original does not have shows as plain text.
 */
export function originalMentions(original: string, sent: string, mentions: readonly MentionView[] | undefined): MentionView[] | undefined {
  if (!mentions?.length) return mentions && [];
  const points = Array.from(sent.trim());
  const chosen = mentions.map((m) => ({ key: m.key, label: points.slice(m.o + 1, m.o + m.l).join("") })).filter((c) => c.label);
  const left = [...mentions];
  return composeMentions(original, chosen).flatMap(({ k, o, l }) => {
    const at = left.findIndex((m) => m.key === k);
    return at === -1 ? [] : [{ ...left.splice(at, 1)[0], o, l }];
  });
}

/** A message's original, kept current: redrawn when one is kept or forgotten here or in another page of the app. */
export function useSentOriginal(chat: string | undefined, messageId: string, enabled = true): SentOriginal | undefined {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const on = enabled && !!chat;
  useEffect(() => {
    if (!on) return;
    const stored = (event: StorageEvent) => { if (!event.key || event.key.startsWith(`${getPrefix()}${SENT_ORIGINALS_SUFFIX}`)) redraw(); };
    window.addEventListener(SENT_ORIGINALS_EVENT, redraw);
    window.addEventListener("storage", stored);
    return () => {
      window.removeEventListener(SENT_ORIGINALS_EVENT, redraw);
      window.removeEventListener("storage", stored);
    };
  }, [on]);
  return on ? sentOriginal(chat, messageId) : undefined;
}
