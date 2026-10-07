/**
 * Where a mini-app runs in a 1:1 chat (WISP 1200 § Per client, web): the chat's own panel, beside the chat on a wide
 * screen and over it on a phone. The chat gives its panel's frame box and who the contact is (`registerAppSlot`); the
 * opener starts the app in that box and keeps it here, one app per chat.
 *
 * A frame reloads when it moves in the page, so the box never moves: the app is shown and hidden in place. Back on a
 * phone hides it, and opening the same app again in that chat shows it as it was. A chat with an app running stays
 * loaded (App.tsx), as one on a call does, so going to another chat or page and back finds the app where it was.
 */
import { useSyncExternalStore } from "react";
import type { RunningApp } from "./broker";
import type { AppTakedown } from "./open";
import type { Translate } from "../../locales/translate";

export interface ChatApp {
  ref: string;
  title: string;
  /** On screen. A phone's Back hides it; it keeps running. */
  shown: boolean;
  /** Over the whole chat on a wide screen, instead of beside it. */
  wide: boolean;
  running: RunningApp;
  /** Stopped by the client, for this reason: the panel says why until the person closes it (WISP 1200 § Takedowns). */
  stopped?: AppTakedown;
}

/** The chat's contact as its header shows them. */
export interface AppContact {
  name: string;
  /** The contact has a name (not only their key). */
  named: boolean;
}

interface Slot {
  box: HTMLElement;
  /** The chat's session (App.tsx keeps it loaded while its app runs). */
  sessionId: string;
  contact: AppContact;
}

const slots = new Map<string, Slot>();
const apps = new Map<string, ChatApp>();
const listeners = new Set<() => void>();
let version = 0;
let sessions: readonly string[] = [];

function changed() {
  version++;
  const next = [...apps.keys()].map((linkId) => slots.get(linkId)?.sessionId).filter((id): id is string => !!id);
  if (next.length !== sessions.length || next.some((id, i) => id !== sessions[i])) sessions = next;
  for (const listener of [...listeners]) listener();
}

/**
 * The chat `linkId`'s frame box, its session and its contact, or null when its panel goes (the chat closed): an app
 * running there stops. Called again as the contact's name changes.
 */
export function registerAppSlot(linkId: string, slot: Slot | null): void {
  if (slot) { slots.set(linkId, slot); return; }
  slots.delete(linkId);
  const app = apps.get(linkId);
  if (app?.stopped) setChatApp(linkId, null);
  else app?.running.stop();
}

export function appSlot(linkId: string): HTMLElement | undefined {
  return slots.get(linkId)?.box;
}

/** Who the contact is in `linkId`, as its chat shows them. */
export function appContact(linkId: string): AppContact | undefined {
  return slots.get(linkId)?.contact;
}

export function chatApp(linkId: string): ChatApp | undefined {
  return apps.get(linkId);
}

export function setChatApp(linkId: string, app: ChatApp | null): void {
  if (app) apps.set(linkId, app);
  else if (!apps.delete(linkId)) return;
  changed();
}

/** Shows or hides the app in `linkId`, or puts it over the whole chat (`wide`). */
export function updateChatApp(linkId: string, patch: Partial<Pick<ChatApp, "shown" | "wide">>): void {
  const app = apps.get(linkId);
  if (!app) return;
  apps.set(linkId, { ...app, ...patch });
  changed();
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => version;

/** The app running in the chat `linkId`, if one is. */
export function useChatApp(linkId: string | undefined): ChatApp | undefined {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return linkId ? apps.get(linkId) : undefined;
}

/** The chats an app runs in, by session: App.tsx keeps them loaded. */
export function useAppSessions(): readonly string[] {
  return useSyncExternalStore(subscribe, () => sessions, () => sessions);
}

/** "Chess with Ana": a panel's name, and a Desktop app window's title. Only the title when opened alone. */
export function appWithContact(title: string, linkId: string | null, t: Translate): string {
  const contact = linkId ? appContact(linkId) : undefined;
  return contact ? t("apps.view.with", { title, name: contact.name }) : title;
}
