import { TranslateError, translateTexts } from "../desktop/translate";
import type { Language } from "./settings";
import { getPrefix } from "./storage";
import { loadDetector } from "./translateDetector";
import { translateFrom, type DetectLanguages } from "./translateWhich";
import type { ChatMessage } from "./types";

/*
 * Received messages read in the app's language (docs/AUTO-TRANSLATE.md § UI, § Cost and limits). A view of the message,
 * never stored: the original stays what is kept, quoted, searched and synced, and the translations here last as long as
 * the page. Only what bubbles on screen ask for is translated, in batches: messages that arrive or scroll in together go
 * as one request per language pair, never a whole history.
 */

/** Sent on this page when a chat's own translation choice changes (another page of the app sees `storage`). */
export const CHAT_TRANSLATE_EVENT = "chat-translate-updated";

const chatKey = (chat: string) => `${getPrefix()}translate_${chat}`;
const settingsKey = () => `${getPrefix()}app_settings`;

/** The settings as last read, and their switch: a chat draws every bubble again, and they all ask. */
let settingsRead: { raw: string | null; on: boolean } = { raw: null, on: false };

/** Settings' Translate messages (`AppSettings.translateMessages`): off until turned on. */
function settingOn(): boolean {
  let raw: string | null;
  try { raw = localStorage.getItem(settingsKey()); } catch { return false; }
  if (raw !== settingsRead.raw) {
    let on = false;
    try { on = (JSON.parse(raw ?? "null") as { translateMessages?: unknown } | null)?.translateMessages === true; } catch { /* unreadable: off */ }
    settingsRead = { raw, on };
  }
  return settingsRead.on;
}

/**
 * Whether received messages in `chat` (a session id, or `group:<id>`) are translated on this device: the chat's own
 * choice (`translate_<chat>`: "on" or "off") wins, and a chat that never chose follows Settings.
 */
export function translationOn(chat: string): boolean {
  let own: string | null = null;
  try { own = localStorage.getItem(chatKey(chat)); } catch { /* storage unavailable: as in Settings */ }
  return own === "on" ? true : own === "off" ? false : settingOn();
}

/** Calls `changed` when Settings or a chat's choice may have changed, on this page or in another page of the app. */
export function watchTranslationOn(changed: () => void): () => void {
  const stored = (event: StorageEvent) => {
    if (!event.key || event.key === settingsKey() || event.key.startsWith(`${getPrefix()}translate_`)) changed();
  };
  window.addEventListener("settings-updated", changed);
  window.addEventListener(CHAT_TRANSLATE_EVENT, changed);
  window.addEventListener("storage", stored);
  return () => {
    window.removeEventListener("settings-updated", changed);
    window.removeEventListener(CHAT_TRANSLATE_EVENT, changed);
    window.removeEventListener("storage", stored);
  };
}

/** At most this many texts per request: the spike's batch (30 in 0.3 s), so the first on screen do not wait long. */
export const BATCH_TEXTS = 30;
/** How long arrivals gather before a request: a burst of messages, or a screenful scrolled in, goes as one. */
export const BATCH_WAIT_MS = 40;
/** Longer messages are translated when asked (the bubble's Translate), never by themselves: over 100 ms each. */
export const LONG_TEXT = 4_000;
/** How many translations, and decisions of which language, the page keeps: the oldest go first. */
const KEEP = 2_000;
/** In `unavailable`: no runtime at all (not downloaded, or no translation in this build). */
const NO_RUNTIME = "*";

/** A received message as a bubble shows it: translated from `from`, once `text` came. */
export interface Translation {
  /** The message's language, an ISO 639-1 code. */
  from: string;
  /** The translation, while it has not come: the bubble shows the original meanwhile. */
  text?: string;
  /** Too long to be translated by itself: the bubble offers Translate. */
  long: boolean;
}

type Received = Pick<ChatMessage, "id" | "sender" | "text" | "file" | "paymentId" | "card" | "callEvent" | "systemEvent" | "mentions">;

/** View key (app language, message, text) → the language it is translated from, or null: shown as it was sent. */
const decided = new Map<string, string | null>();
/** `<pair>\n<text>` → its translation, or null: none (the same words back, or the runtime failed on it). */
const translated = new Map<string, string | null>();
/** Pairs whose model is not on this device, or `NO_RUNTIME`: not asked again until `forgetTranslations`. */
const unavailable = new Set<string>();
/** Long messages someone asked to translate (their view keys). */
const wanted = new Set<string>();
/** Messages shown as they were sent, by Show original: for the session. */
const originals = new Set<string>();
/** Per chat, the last language the others wrote with confidence: what a short message is taken to be in. */
const chatLanguages = new Map<string, string>();
const deciding = new Set<string>();
/** Pair → texts waiting for the next request; `pending` holds them and the ones on their way. */
const queue = new Map<string, Set<string>>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
/** Moves on with `forgetTranslations`: an answer to a request made before it is dropped. */
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let detecting: Promise<DetectLanguages | null> | undefined;

const viewKey = (message: Pick<Received, "id" | "text">, language: Language) => `${language}\n${message.id}\n${message.text}`;
const textKey = (pair: string, text: string) => `${pair}\n${text}`;
const usable = (pair: string) => !unavailable.has(NO_RUNTIME) && !unavailable.has(pair);

function keep<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > KEEP) map.delete(map.keys().next().value!);
}

function changed(): void {
  version++;
  for (const listener of listeners) listener();
}

/** Calls `listener` when a translation came, or a choice of what to show changed. */
export function watchTranslations(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Puts `text` in the next request for `pair`, unless it was translated, is on its way, or cannot be. */
function enqueue(pair: string, text: string): void {
  const key = textKey(pair, text);
  if (!usable(pair) || translated.has(key) || pending.has(key)) return;
  pending.add(key);
  let texts = queue.get(pair);
  if (!texts) queue.set(pair, texts = new Set());
  texts.add(text);
  if (!timer && !running) timer = setTimeout(() => void flush(), BATCH_WAIT_MS);
}

/** The waiting texts, `BATCH_TEXTS` at a time and one request after another: what comes meanwhile goes in the next. */
async function flush(): Promise<void> {
  timer = undefined;
  running = true;
  try {
    for (let next = queue.entries().next(); !next.done; next = queue.entries().next()) {
      const [pair, texts] = next.value;
      const batch = [...texts].slice(0, BATCH_TEXTS);
      for (const text of batch) texts.delete(text);
      if (!texts.size) queue.delete(pair);
      await translateBatch(pair, batch);
    }
  } finally {
    running = false;
  }
}

async function translateBatch(pair: string, batch: string[]): Promise<void> {
  const asked = generation;
  let answers: string[] | null = null, reason: TranslateError["reason"] = "failed";
  try { answers = await translateTexts(pair, batch); } catch (error) { if (error instanceof TranslateError) reason = error.reason; }
  if (asked !== generation) return;
  for (const text of batch) pending.delete(textKey(pair, text));
  if (answers) {
    for (const [i, text] of batch.entries()) {
      const answer = answers[i];
      // The same words back ("ok" taken as the chat's language) are no translation.
      keep(translated, textKey(pair, text), typeof answer === "string" && answer.trim() && answer.trim() !== text.trim() ? answer : null);
    }
  } else if (reason === "failed") {
    // Shown as sent, and not asked again: a text the runtime fails on would fail on every redraw.
    for (const text of batch) keep(translated, textKey(pair, text), null);
  } else {
    // No model for the pair, or no runtime: nothing more is asked of it; the bubbles show the originals.
    unavailable.add(reason === "no-model" ? pair : NO_RUNTIME);
    for (const [waiting, texts] of queue) {
      if (usable(waiting)) continue;
      for (const text of texts) pending.delete(textKey(waiting, text));
      queue.delete(waiting);
    }
  }
  changed();
}

/**
 * A bubble of `chat` on screen (or a screenful away) asks for its message's translation into `language`: its language
 * is found once (translateWhich.ts), and its text goes in the next request. `asked`: a long message's Translate.
 */
export function askTranslation(message: Received, chat: string, language: Language, asked = false): void {
  const key = viewKey(message, language);
  if (asked && !wanted.has(key)) { wanted.add(key); changed(); }
  const from = decided.get(key);
  const go = (from: string | null) => {
    if (from && (message.text.length <= LONG_TEXT || wanted.has(key))) enqueue(`${from}-${language}`, message.text);
  };
  if (from !== undefined) { go(from); return; }
  if (deciding.has(key)) return;
  deciding.add(key);
  const asking = generation;
  void (detecting ??= loadDetector().catch(() => null)).then((detect) => {
    if (asking !== generation) return;
    deciding.delete(key);
    if (!detect) return;
    let which: ReturnType<typeof translateFrom> = { from: null, detected: null };
    try {
      which = translateFrom(message, { appLanguage: language, detect, canTranslate: (from) => usable(`${from}-${language}`), chatLanguage: chatLanguages.get(chat) });
    } catch { /* a detector that throws translates nothing */ }
    if (which.detected) chatLanguages.set(chat, which.detected);
    keep(decided, key, which.from);
    go(which.from);
    if (which.from) changed();
  });
}

const views = new Map<string, { version: number; value: Translation | null }>();

/** What the bubble shows of `message` now: the same object until that changes, so a bubble draws only then. */
export function readTranslation(message: Pick<Received, "id" | "text">, language: Language): Translation | null {
  const key = viewKey(message, language);
  const seen = views.get(key);
  if (seen?.version === version) return seen.value;
  const from = decided.get(key);
  let value: Translation | null = null;
  if (from && usable(`${from}-${language}`)) {
    const text = translated.get(textKey(`${from}-${language}`, message.text));
    if (text !== null) value = { from, text, long: text === undefined && message.text.length > LONG_TEXT && !wanted.has(key) };
  }
  const same = seen?.value && value && seen.value.from === value.from && seen.value.text === value.text && seen.value.long === value.long;
  const shown = same ? seen.value : value;
  keep(views, key, { version, value: shown });
  return shown;
}

/** Whether Show original was pressed on this message (and not Show translation after it). */
export const shownOriginal = (messageId: string) => originals.has(messageId);

export function showOriginal(messageId: string, original: boolean): void {
  if (original) originals.add(messageId); else originals.delete(messageId);
  changed();
}

/** A language's name in the app's language ("Portuguese" for `pt` in English), or its code where the browser has none. */
export function languageName(code: string, language: Language): string {
  try { return new Intl.DisplayNames([language], { type: "language" }).of(code) ?? code; } catch { return code; }
}

/** Throws every translation and decision away, and asks again what was missing: after a model is downloaded or removed. */
export function forgetTranslations(): void {
  generation++;
  clearTimeout(timer);
  timer = undefined;
  detecting = undefined;
  for (const store of [decided, translated, unavailable, wanted, originals, chatLanguages, deciding, queue, pending, views]) store.clear();
  changed();
}
