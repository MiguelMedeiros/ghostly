import { useEffect, useReducer } from "react";
import { getPrefix } from "./storage";

/*
 * "Translate what I send", per chat (docs/AUTO-TRANSLATE.md § Outgoing translation): the send button translates the
 * draft into the chat's language and sends it at once, without the preview. Off unless turned on. Like the chat's
 * translation choice and its mute, it is this profile's, on this device: never synced, never sent, and forgotten
 * with the chat.
 */

/** Sent on this page when a chat's choice changes (another page of the app sees `storage`). */
export const TRANSLATE_SEND_EVENT = "chat-translate-send-updated";

const sendKey = (chat: string) => `${getPrefix()}translate_send_${chat}`;

/** Whether `chat` (a session id, or `group:<id>`) translates what I send without the preview. */
export function translatesWhatISend(chat: string): boolean {
  try { return localStorage.getItem(sendKey(chat)) === "on"; } catch { return false; }
}

/** Turns it on or off for `chat`; off leaves no key behind. */
export function setTranslatesWhatISend(chat: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(sendKey(chat), "on");
    else localStorage.removeItem(sendKey(chat));
  } catch { /* storage unavailable: nothing is remembered */ }
  window.dispatchEvent(new Event(TRANSLATE_SEND_EVENT));
}

/** Forgets it with the chat. */
export function forgetTranslateSend(chat: string): void {
  try { localStorage.removeItem(sendKey(chat)); } catch { /* storage unavailable */ }
}

/** `translatesWhatISend(chat)`, drawn again when it changes here or on another page. */
export function useTranslatesWhatISend(chat: string | undefined): boolean {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const stored = (event: StorageEvent) => { if (!event.key || event.key.startsWith(`${getPrefix()}translate_send_`)) redraw(); };
    window.addEventListener(TRANSLATE_SEND_EVENT, redraw);
    window.addEventListener("storage", stored);
    return () => { window.removeEventListener(TRANSLATE_SEND_EVENT, redraw); window.removeEventListener("storage", stored); };
  }, []);
  return !!chat && translatesWhatISend(chat);
}
