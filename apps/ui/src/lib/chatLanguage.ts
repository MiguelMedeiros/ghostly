import { useEffect, useReducer } from "react";
import { LANGUAGE_OPTIONS, type Language } from "./settings";
import { getPrefix } from "./storage";

/*
 * A chat's language (docs/AUTO-TRANSLATE.md § Outgoing translation): what a short received message is taken to be
 * in, and what a draft is translated into. A 1:1 chat's is the last language the contact wrote with confidence; a
 * group's is the language of most of the others' last 20 confident messages, when it covers at least 60% of them,
 * else the group has none (several). One set by hand wins over both. The count is pure: it reads the languages the
 * detector was sure of (lib/translateWhich.ts's `detected`), oldest first; the set language is this device's, kept
 * beside the chat's mute (lib/chatMute.ts), never synced and never sent.
 */

/** How many of a group's latest confident messages are counted. */
export const GROUP_WINDOW = 20;
/** The share of them one language needs to be the group's. */
export const GROUP_SHARE = 0.6;

export interface ChatLanguage {
  /** ISO 639-1, or null: no confident message yet, or a group with several languages. */
  language: string | null;
  /** Set by hand, or worked out from the others' messages. */
  by: "hand" | "detected" | null;
  /** The languages the others wrote, most used first (a tie: the latest used first); what a picker offers first. */
  languages: string[];
}

const baseCode = (code: string) => code.toLowerCase().split(/[-_]/)[0] ?? "";
const CODE = /^[a-z]{2,3}$/;

/**
 * The chat's language from `detected`, the confident language of each of the others' messages, oldest first (null
 * or undefined: the detector was not sure, and it does not count). `setByHand` wins.
 */
export function chatLanguageOf(
  detected: readonly (string | null | undefined)[],
  { group, setByHand }: { group: boolean; setByHand?: string | null },
): ChatLanguage {
  const sure = detected.filter((code): code is string => !!code).map(baseCode).filter((code) => CODE.test(code));
  const counted = group ? sure.slice(-GROUP_WINDOW) : sure;
  const count = new Map<string, { n: number; last: number }>();
  counted.forEach((code, i) => count.set(code, { n: (count.get(code)?.n ?? 0) + 1, last: i }));
  const languages = [...count.entries()].sort(([, a], [, b]) => b.n - a.n || b.last - a.last).map(([code]) => code);

  if (setByHand) return { language: setByHand, by: "hand", languages };
  const top = languages[0];
  const language = !top ? null
    : !group ? counted[counted.length - 1]!
      : count.get(top)!.n >= GROUP_SHARE * counted.length ? top : null;
  return { language, by: language ? "detected" : null, languages };
}

/** Sent on this page when a chat's language is set or cleared (another page of the app sees `storage`). */
export const CHAT_LANGUAGE_EVENT = "chat-language-updated";

const KEY = "translate_lang_";
const languageKey = (chat: string) => `${getPrefix()}${KEY}${chat}`;

/** The language set by hand for this chat, or null. `chat`: a session id, or `groupChat(id)`. */
export function languageSetByHand(chat: string): string | null {
  let raw: string | null;
  try { raw = localStorage.getItem(languageKey(chat)); } catch { return null; }
  const code = raw ? baseCode(raw) : "";
  return CODE.test(code) ? code : null;
}

/** Sets this chat's language by hand, or (null) goes back to the one its messages say. */
export function setChatLanguage(chat: string, language: string | null): void {
  try {
    if (language) localStorage.setItem(languageKey(chat), baseCode(language));
    else localStorage.removeItem(languageKey(chat));
  } catch { /* storage unavailable: nothing is remembered */ }
  window.dispatchEvent(new Event(CHAT_LANGUAGE_EVENT));
}

/** Forgets a chat's language with the chat. */
export function forgetChatLanguage(chat: string): void {
  try { localStorage.removeItem(languageKey(chat)); } catch { /* storage unavailable */ }
}

/** A chat's language, kept current: redrawn when it is set here or in another page of the app. */
export function useChatLanguage(chat: string, detected: readonly (string | null | undefined)[], group: boolean): ChatLanguage {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const stored = (event: StorageEvent) => { if (!event.key || event.key.startsWith(`${getPrefix()}${KEY}`)) redraw(); };
    window.addEventListener(CHAT_LANGUAGE_EVENT, redraw);
    window.addEventListener("storage", stored);
    return () => {
      window.removeEventListener(CHAT_LANGUAGE_EVENT, redraw);
      window.removeEventListener("storage", stored);
    };
  }, []);
  return chatLanguageOf(detected, { group, setByHand: languageSetByHand(chat) });
}

/** What a chat's language can be set to: the languages its messages were in, then the app's own, each once. */
export function languageChoices(languages: readonly string[]): string[] {
  return [...new Set([...languages, ...LANGUAGE_OPTIONS.map((option) => option.value)])];
}

/** A language's name in the app's language ("Italian", "italiano"), or its code when the browser has none. */
export function languageName(code: string, appLanguage: Language): string {
  try { return new Intl.DisplayNames([appLanguage], { type: "language", fallback: "none" }).of(code) ?? code; } catch { return code; }
}
