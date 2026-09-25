import { useEffect, useReducer } from "react";
import type { AttentionEvent } from "@ghostly/browser/shared/rpc";
import type { NotificationSettings } from "./settings";
import { getPrefix, listSessions } from "./storage";

/*
 * Muting one chat's notifications, for a while or until turned back on. The choice is this profile's, on this
 * device: kept beside the chat's pin and read mark, never synced and never sent to the contact. Only the sound
 * and the system notification of a new message are left out; messages, receipts, delivery, the unread count
 * and the list order stay as they are.
 *
 * A mute ends by itself: every read compares its end with the clock, so it is over after a restart, or after
 * the app was closed through its end, without any timer. The timer in `useChatMute` only redraws the bell.
 */

/** Until when (milliseconds since the epoch), or until turned back on. */
export type MutedUntil = number | "forever";

/** The choices, shortest first. 15 minutes: a meeting or a burst of messages; then an hour, a day, no end. */
export const MUTE_CHOICES = ["15m", "1h", "1d", "forever"] as const;
export type MuteChoice = (typeof MUTE_CHOICES)[number];

const LENGTH: Record<Exclude<MuteChoice, "forever">, number> = { "15m": 15 * 60_000, "1h": 60 * 60_000, "1d": 24 * 60 * 60_000 };

/** When a mute chosen now ends. */
export function muteEnd(choice: MuteChoice, now = Date.now()): MutedUntil {
  return choice === "forever" ? "forever" : now + LENGTH[choice];
}

/**
 * What a muted chat leaves out. Calls ring anyway: a missed call is not what muting a chat is for, and a call
 * is rarer and more deliberate than a message. Setting `call` to true makes a muted chat's calls come in silent.
 */
export const MUTE_SILENCES: Readonly<Record<"message" | "call", boolean>> = { message: true, call: false };

/** A group's chat as the mute store names it: the id the engine files the group's messages under. */
export const groupChat = (groupId: string) => `group:${groupId}`;

/** Sent on this page when a chat is muted or unmuted (another page of the app sees `storage`). */
export const MUTE_EVENT = "chat-mute-updated";

const muteKey = (chat: string) => `${getPrefix()}mute_${chat}`;

/** Until when this chat is muted, or undefined when it is not (any more). `chat`: a session id, or `groupChat(id)`. */
export function mutedUntil(chat: string, now = Date.now()): MutedUntil | undefined {
  let raw: string | null;
  try { raw = localStorage.getItem(muteKey(chat)); } catch { return undefined; }
  if (!raw) return undefined;
  if (raw === "forever") return "forever";
  const until = Number(raw);
  if (Number.isFinite(until) && until > now) return until;
  // Over, or unreadable: forgotten, so an ended mute leaves nothing behind.
  try { localStorage.removeItem(muteKey(chat)); } catch { /* read-only storage: it stays ended all the same */ }
  return undefined;
}

/** Mutes a chat until `until`, or unmutes it (undefined). */
export function setChatMute(chat: string, until: MutedUntil | undefined): void {
  try {
    if (until === undefined) localStorage.removeItem(muteKey(chat));
    else localStorage.setItem(muteKey(chat), String(until));
  } catch { /* storage unavailable: nothing is remembered */ }
  window.dispatchEvent(new Event(MUTE_EVENT));
}

/** Forgets a chat's mute with the chat. */
export function forgetChatMute(chat: string): void {
  try { localStorage.removeItem(muteKey(chat)); } catch { /* storage unavailable */ }
}

/**
 * The chat an attention event is about, as the mute store names it: a group's link id as it is, a 1:1 chat's
 * session (found through the engine's link, by the contact's key). Undefined when the event names no chat.
 */
export function chatOfLink(linkId: string | undefined, links: readonly { id: string; peerPubKeyZ32: string }[] = []): string | undefined {
  if (!linkId) return undefined;
  if (linkId.startsWith("group:")) return linkId;
  const peer = links.find((l) => l.id === linkId)?.peerPubKeyZ32;
  return peer ? listSessions().find((s) => s.peerPubKeyB64 === peer)?.id : undefined;
}

/**
 * What a live attention event plays and shows. The global switches come first (sound off plays nothing,
 * anywhere); a muted chat then leaves out its new messages' sound and notification. What I sent, and the
 * wallet's coins and confirmations, belong to no chat's notifications and are never muted.
 */
export function attentionOutcome(type: AttentionEvent["type"], muted: boolean, notifications: NotificationSettings, background: boolean): { sound: boolean; notice: boolean } {
  const quiet = muted && type === "message" && MUTE_SILENCES.message;
  return {
    sound: notifications.soundEnabled && !quiet,
    notice: notifications.systemEnabled && type === "message" && background && !quiet,
  };
}

/** Whether an incoming call in this chat rings. Yes, muted or not, unless `MUTE_SILENCES.call` says otherwise. */
export function callRings(chat: string, now = Date.now()): boolean {
  return !(MUTE_SILENCES.call && mutedUntil(chat, now) !== undefined);
}

/**
 * A chat's mute, kept current: redrawn when it changes here or in another page of the app, and when it ends.
 */
export function useChatMute(chat: string): MutedUntil | undefined {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const until = mutedUntil(chat);
  useEffect(() => {
    window.addEventListener(MUTE_EVENT, redraw);
    window.addEventListener("storage", redraw);
    return () => {
      window.removeEventListener(MUTE_EVENT, redraw);
      window.removeEventListener("storage", redraw);
    };
  }, []);
  useEffect(() => {
    if (typeof until !== "number") return;
    const timer = setTimeout(redraw, Math.min(Math.max(until - Date.now(), 0) + 50, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [until]);
  return until;
}

/** When a mute ends, as a person reads it: the time today, else the weekday and time. */
export function muteEndText(until: number, language: string, now = Date.now()): string {
  const end = new Date(until);
  const today = end.toDateString() === new Date(now).toDateString();
  return today
    ? end.toLocaleTimeString(language, { hour: "numeric", minute: "2-digit" })
    : end.toLocaleString(language, { weekday: "short", hour: "numeric", minute: "2-digit" });
}
