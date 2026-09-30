import { useEffect, useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { getUnreadCount, listSessions } from "./storage";
import { groupReadAt, groupUnreadAt } from "./groups";
import { MUTE_EVENT, groupChat, mutedFor } from "./chatMute";
import type { ChatSession } from "./types";

/*
 * The number on the app's icon (the Badging API: an installed web app's icon, where the system shows one; on
 * Desktop, the Dock icon on macOS and the launcher's on Linux desktops that show one). It
 * follows the chat mute (#250): a muted chat's messages make no sound and no notification, so they do not
 * count here either, except a mention of me in a group that lets mentions through. Unread in the list stays
 * as it is: the list shows a muted chat's count in grey.
 */

/** A group as the badge reads it (the engine's group view). */
export interface BadgeGroup {
  id: string;
  lastMessageAt: number;
  lastPeerMessageAt?: number;
  lastMentionAt?: number;
  invitation?: unknown;
}

/** Unread messages the icon counts: every unmuted 1:1 chat's, and one for each unmuted group with something new. */
export function badgeCount(sessions: readonly ChatSession[], groups: readonly BadgeGroup[], now = Date.now()): number {
  let count = 0;
  for (const session of sessions) {
    if (!mutedFor(session.id, false, now)) count += getUnreadCount(session);
  }
  for (const group of groups) {
    const readAt = groupReadAt(group.id);
    if (group.invitation || groupUnreadAt(group) <= readAt) continue;
    const mention = (group.lastMentionAt ?? 0) > readAt;
    if (!mutedFor(groupChat(group.id), mention, now)) count += 1;
  }
  return count;
}

export interface BadgeNavigator {
  setAppBadge?: (count?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

/**
 * Where the number goes instead of `navigator`: Desktop's Dock or launcher icon, whose WebView has no Badging API.
 * Its host sets it before the app is drawn, with the Badging API's two calls.
 */
let target: BadgeNavigator | null = null;
let shown: number | null = null;

/** Sends the number to `next` rather than to `navigator` (the Desktop host does); `null` goes back to the browser's. */
export function setAppBadgeTarget(next: BadgeNavigator | null): void {
  target = next;
  shown = null;
}

const badgeNavigator = (): BadgeNavigator => target ?? (typeof navigator === "undefined" ? {} : navigator as BadgeNavigator);

/** Whether this browser can put a number on the app's icon at all. */
export function canBadge(nav: BadgeNavigator = badgeNavigator()): boolean {
  return typeof nav.setAppBadge === "function";
}

/** Puts `count` on the icon, or clears it at 0. Quiet where there is no badge; only a change is sent. */
export function showAppBadge(count: number, nav: BadgeNavigator = badgeNavigator()): void {
  if (!canBadge(nav) || count === shown) return;
  shown = count;
  try {
    const done = count > 0 ? nav.setAppBadge!(count) : (nav.clearAppBadge?.() ?? nav.setAppBadge!(0));
    // Refused (a page that is not an installed app, a permission the system keeps): nothing to show then.
    void done?.catch?.(() => {});
  } catch { /* no badge here */ }
}

/** Tests only: forgets the last number sent. */
export function resetAppBadge(): void {
  shown = null;
}

const subscribeEngine = (listener: () => void) => engine.subscribe(listener);
const engineSnapshot = () => engine.state;

/** Chats are re-read this often too: a message stored by the peer says nothing to this page. As the chat list does. */
const REFRESH_MS = 3000;

/** Keeps the icon's number in step with the chats: on every change the app hears of, and every few seconds. */
export function useAppBadge(): void {
  const state = useSyncExternalStore(subscribeEngine, engineSnapshot);
  const groups = state?.groups;
  useEffect(() => {
    if (!canBadge()) return;
    const update = () => showAppBadge(badgeCount(listSessions(), groups ?? []));
    update();
    const timer = setInterval(update, REFRESH_MS);
    window.addEventListener("session-updated", update);
    window.addEventListener(MUTE_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      clearInterval(timer);
      window.removeEventListener("session-updated", update);
      window.removeEventListener(MUTE_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, [groups]);
}
