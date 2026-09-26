import { createContext, useContext } from "react";
import type { AttentionCue, AttentionEvent } from "@ghostly/browser/shared/rpc";
import { DEFAULT_CUES, loadSettings, type CueCategory, type NotificationSettings } from "./settings";
import { mutedFor } from "./chatMute";
import { playSound, type SoundName } from "./sounds";

/*
 * The finer sounds: short cues for payments, identities, connection, chat and the interface, each category turned
 * on or off in Settings > Notifications and sounds, all of them under the Sounds switch. The first sounds (a message,
 * sent, a coin, confirmed, a call, connected) keep their own rules (chatMute.ts, AttentionFeedback).
 *
 * Rules every cue follows:
 * - One sound per event: an event's key plays once, and the same cue again within `REPEAT_MS` is the same sound
 *   (a re-render, a state pushed twice).
 * - A chat's cue is silent while that chat is muted, as its messages are; a mention it lets through is not.
 * - Nothing new plays while the app is in the background. A cue that stands for a sound which already played there
 *   (`replaces`: a mention instead of a message) keeps that sound's rules instead.
 * - Reduced motion does not silence them. No platform tells a web page of a system "reduce sounds" wish (there is no
 *   media query or API for it), so the switches here are the way to quiet them.
 */

export type CueName = AttentionCue | "paid" | "realmoney" | "mention" | "spoiler" | "deleted" | "slide" | "flip" | "wallet";

interface CueRule {
  category: CueCategory;
  /** Belongs to a chat: its mute silences it. */
  chat?: true;
  /** The first sound this one stands in for, on the same event: with the category off, that one plays as before. */
  replaces?: SoundName;
}

export const CUES = {
  paid: { category: "payments", replaces: "confirmed" },
  request: { category: "payments", chat: true },
  realmoney: { category: "payments" },
  testcoins: { category: "payments", replaces: "coin" },
  failed: { category: "payments", chat: true },
  sealed: { category: "identities" },
  shared: { category: "identities", chat: true },
  checked: { category: "identities", chat: true },
  knock: { category: "connection", chat: true },
  switched: { category: "connection" },
  back: { category: "connection" },
  mention: { category: "chat", chat: true, replaces: "message" },
  spoiler: { category: "chat", chat: true },
  downloaded: { category: "chat", chat: true },
  deleted: { category: "chat", chat: true },
  slide: { category: "interface" },
  flip: { category: "interface" },
  wallet: { category: "interface" },
  group: { category: "interface", replaces: "message" },
} as const satisfies Record<CueName, CueRule>;

/** What each category's ▶ in Settings plays. */
export const CATEGORY_PREVIEW: Readonly<Record<CueCategory, CueName>> = { payments: "paid", identities: "sealed", connection: "knock", chat: "mention", interface: "flip" };

/** Whether a category plays: the Sounds switch, then the category's own. */
export function categoryOn(category: CueCategory, notifications: NotificationSettings): boolean {
  return notifications.soundEnabled && (notifications.cues?.[category] ?? DEFAULT_CUES[category]);
}

/** Whether a cue plays now. `muted`: its chat's mute silences it (mutedFor). `background`: the app is not in front. */
export function cueOutcome(cue: CueName, notifications: NotificationSettings, muted: boolean, background: boolean): boolean {
  const rule: CueRule = CUES[cue];
  if (!categoryOn(rule.category, notifications)) return false;
  if (rule.chat && muted) return false;
  return !background || !!rule.replaces;
}

/**
 * The sound of one of the first events, finer when its category is on: a mention instead of a message, a group's own
 * line, test coins instead of a coin, a payment of mine gone out (`confirmed`) as a coin whooshing away.
 */
export function eventSound(event: Pick<AttentionEvent, "cue" | "mention"> & { type: Exclude<AttentionEvent["type"], "cue"> }, notifications: NotificationSettings): SoundName {
  const finer: CueName | undefined = event.cue ?? (event.type === "message" && event.mention ? "mention" : event.type === "confirmed" ? "paid" : undefined);
  const rule: CueRule | undefined = finer && CUES[finer];
  return finer && rule?.replaces === event.type && categoryOn(rule.category, notifications) ? finer : event.type;
}

/** The same cue again this soon is the same sound (a re-render, an effect run twice). */
export const REPEAT_MS = 150;
const lastPlayed = new Map<CueName, number>();
const playedKeys: string[] = [];

export const inBackground = () => typeof document !== "undefined" && (document.visibilityState === "hidden" || !document.hasFocus());

/**
 * Plays a cue if its rules let it: `chat` names the chat it belongs to (a session id, or `group:<id>`), `key` the
 * event, so the same event heard again stays one sound. Returns whether it played.
 */
export function playCue(cue: CueName, { chat, mention = false, key }: { chat?: string; mention?: boolean; key?: string } = {}, now = Date.now()): boolean {
  if (key && playedKeys.includes(key)) return false;
  if (now - (lastPlayed.get(cue) ?? -Infinity) < REPEAT_MS) return false;
  if (!cueOutcome(cue, loadSettings().notifications, mutedFor(chat, mention, now), inBackground())) return false;
  lastPlayed.set(cue, now);
  if (key) { playedKeys.push(key); if (playedKeys.length > 256) playedKeys.shift(); }
  playSound(cue);
  return true;
}

/** Forgets what played (tests). */
export function resetCues(): void { lastPlayed.clear(); playedKeys.length = 0; }

/** The chat on screen, as the mute store names it, for cues played from inside its messages (a spoiler, a delete). */
export const CueChat = createContext<string | undefined>(undefined);
export const useCueChat = () => useContext(CueChat);
