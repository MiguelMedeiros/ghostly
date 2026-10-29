import { useEffect, useReducer } from "react";
import type { AppSettings } from "./settings";
import { getPrefix } from "./storage";

/*
 * Whether one chat's received messages are translated: On or Off whatever Settings says, or As in Settings (the
 * default, for a chat that never chose). The choice is this profile's, on this device, kept beside the chat's mute
 * (lib/chatMute.ts) and forgotten with the chat: never synced and never sent, so the contact cannot tell. The Settings
 * switch it overrides is this device's too, and so are the models.
 */

/** The choices, in the order the chat's menu shows them. "settings": no choice of its own (no key). */
export const TRANSLATE_CHOICES = ["settings", "on", "off"] as const;
export type ChatTranslateChoice = (typeof TRANSLATE_CHOICES)[number];

/** Sent on this page when a chat's choice changes (another page of the app sees `storage`). */
export const TRANSLATE_EVENT = "chat-translate-updated";

/**
 * Its keys, `translate_<chat>`: the chat's language and Translate what I send are `translate_lang_<chat>` and
 * `translate_send_<chat>`, of their own.
 */
const translateKey = (chat: string) => `${getPrefix()}translate_${chat}`;

/** This chat's choice. `chat`: a session id, or `groupChat(id)` (lib/chatMute.ts) for a group. */
export function chatTranslateChoice(chat: string): ChatTranslateChoice {
  let raw: string | null;
  try { raw = localStorage.getItem(translateKey(chat)); } catch { return "settings"; }
  // Anything else (a value of a later version, a hand edit) is no choice: Settings decides.
  return raw === "on" || raw === "off" ? raw : "settings";
}

/** Sets a chat's choice: "settings" forgets its own. */
export function setChatTranslate(chat: string, choice: ChatTranslateChoice): void {
  try {
    if (choice === "settings") localStorage.removeItem(translateKey(chat));
    else localStorage.setItem(translateKey(chat), choice);
  } catch { /* storage unavailable: nothing is remembered */ }
  window.dispatchEvent(new Event(TRANSLATE_EVENT));
}

/** Forgets a group's choice with the group (a 1:1 chat's goes with its session, lib/storage.ts). */
export function forgetChatTranslate(chat: string): void {
  try { localStorage.removeItem(translateKey(chat)); } catch { /* storage unavailable */ }
}

/** The rule: a chat's own choice wins, and a chat that never chose does as the Settings switch says. */
export function translatesChat(choice: ChatTranslateChoice, settingsOn: boolean): boolean {
  return choice === "settings" ? settingsOn : choice === "on";
}

/**
 * The Settings switch, "Translate messages into <language>" (`AppSettings.translateMessages`, off unless turned on).
 * Read through `in` while the field is not in every build of AppSettings.
 */
export function settingsTranslate(settings: AppSettings): boolean {
  return "translateMessages" in settings && settings.translateMessages === true;
}

/** Whether received messages in this chat are translated now, by its choice and the Settings switch. */
export function chatTranslates(chat: string, settings: AppSettings): boolean {
  return translatesChat(chatTranslateChoice(chat), settingsTranslate(settings));
}

/** A chat's choice, kept current: redrawn when it changes here or in another page of the app. */
export function useChatTranslate(chat: string): ChatTranslateChoice {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const stored = (event: StorageEvent) => { if (!event.key || event.key.startsWith(`${getPrefix()}translate_`)) redraw(); };
    window.addEventListener(TRANSLATE_EVENT, redraw);
    window.addEventListener("storage", stored);
    return () => {
      window.removeEventListener(TRANSLATE_EVENT, redraw);
      window.removeEventListener("storage", stored);
    };
  }, []);
  return chatTranslateChoice(chat);
}
