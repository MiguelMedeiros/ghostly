import { useEffect, useSyncExternalStore } from "react";
import { generateVapidKeys, type VapidKeys } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import { activeProfileId } from "./profiles";
import { MUTE_EVENT, chatOfLink, groupChat, mutedUntil } from "./chatMute";
import { groupPath } from "./groups";
import { chatPath } from "./url";

/*
 * Wake-up push, the receiving side (WISP 401 § Wake-up push): this profile's browser push subscription, which the
 * engine shares with paired contacts so their apps can wake this one while it is closed. Only the installed web
 * app can be woken this way; it registers how (`setPushPlatform`, apps/web/src/main.tsx). The extension and Desktop
 * stay running on their own and have nothing to register, so the switch is not shown there.
 */

export interface PushKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** A row of the push worker's table: which chat a token names, and its mute. */
export interface WakeTableEntry {
  token: string;
  path: string;
  mutedUntil?: number | "forever";
}

export interface PushPlatform {
  supported(): boolean;
  subscribe(profile: string, vapid: VapidKeys): Promise<PushKeys>;
  current(profile: string): Promise<PushKeys | null>;
  unsubscribe(profile: string): Promise<void>;
  syncTable(profile: string, entries: readonly WakeTableEntry[], text: { title: string; body: string; call?: string }): Promise<void>;
}

let platform: PushPlatform | null = null;
export function setPushPlatform(next: PushPlatform | null): void {
  platform = next;
}
export function pushPlatform(): PushPlatform | null {
  return platform?.supported() ? platform : null;
}

const subscribeEngine = (listener: () => void) => engine.subscribe(listener);
const engineSnapshot = () => engine.state;

/** Whether this profile is woken now (it shared a subscription), as the engine has it. */
export function useWakeOn(): boolean {
  return !!useSyncExternalStore(subscribeEngine, engineSnapshot)?.settings.wake;
}

/** Turns wake-ups on (a new subscription and key pair, so a new token for every chat) or off. Throws a sentence to show. */
export async function setWake(on: boolean): Promise<void> {
  const push = pushPlatform();
  if (!push) throw new Error("This browser cannot wake Ghostly while it is closed.");
  const profile = activeProfileId();
  if (!on) {
    // Contacts are told first, while the subscription still exists; then it ends at the push service.
    await engine.call("setWakeSubscription", { subscription: null });
    await push.unsubscribe(profile);
    return;
  }
  const vapid = generateVapidKeys();
  const keys = await push.subscribe(profile, vapid);
  await engine.call("setWakeSubscription", { subscription: { ...keys, vapid } });
}

let rotating: Promise<void> | null = null;

/**
 * Replaces this profile's subscription after a contact that held it was deleted or muted (the engine's `wakeRotate`).
 * Without notifications allowed any more, wake-ups are turned off instead. One at a time.
 */
export function rotateWake(): Promise<void> {
  rotating ??= (async () => {
    const push = pushPlatform();
    if (!push || !engine.state?.settings.wake) return;
    const profile = activeProfileId();
    if (typeof Notification !== "undefined" && Notification.permission !== "granted") {
      await engine.call("setWakeSubscription", { subscription: null });
      await push.unsubscribe(profile);
      return;
    }
    const vapid = generateVapidKeys();
    const keys = await push.subscribe(profile, vapid);
    await engine.call("setWakeSubscription", { subscription: { ...keys, vapid } });
  })().catch(() => {}).finally(() => { rotating = null; });
  return rotating;
}

/**
 * The table the push worker reads, kept in step with the chats: a token for each chat that shared one, its route
 * and its mute (#250: a muted chat is never shown). Also puts right a subscription the browser dropped while the
 * app was closed: made again when notifications are still allowed, else wake-ups are turned off.
 */
export function useWakeTableSync(text: { title: string; body: string; call?: string }): void {
  const state = useSyncExternalStore(subscribeEngine, engineSnapshot);
  const wake = state?.settings.wake;
  const links = state?.links;
  const groups = state?.groups;
  const { title, body, call } = text;
  useEffect(() => {
    const push = pushPlatform();
    if (!push || !links) return;
    const profile = activeProfileId();
    const write = () => {
      const entries: WakeTableEntry[] = [];
      if (wake) {
        for (const link of links) {
          const chat = chatOfLink(link.id, links);
          if (!chat) continue;
          const until = mutedUntil(chat);
          // A muted chat is not woken at all: its contact is told to forget the subscription (the worker checks too).
          if (!!link.wakeMuted !== (until !== undefined)) void engine.call("setWakeMuted", { linkId: link.id, muted: until !== undefined }).catch(() => {});
          if (!link.wakeToken) continue;
          entries.push({ token: link.wakeToken, path: chatPath(chat), ...(until !== undefined && { mutedUntil: until }) });
        }
        // Private groups (WISP 9xx · Group Mesh § Wake-up push): a token per member, all opening the group; muted, none.
        for (const group of groups ?? []) {
          if (group.profile !== "mesh") continue;
          const until = mutedUntil(groupChat(group.id));
          if (!!group.wakeMuted !== (until !== undefined)) void engine.call("setWakeMuted", { linkId: groupChat(group.id), muted: until !== undefined }).catch(() => {});
          for (const token of group.wakeTokens ?? []) entries.push({ token, path: groupPath(group.id), ...(until !== undefined && { mutedUntil: until }) });
        }
      }
      void push.syncTable(profile, entries, { title, body, ...(call && { call }) }).catch(() => {});
    };
    write();
    window.addEventListener(MUTE_EVENT, write);
    window.addEventListener("storage", write);
    window.addEventListener("session-updated", write);
    return () => {
      window.removeEventListener(MUTE_EVENT, write);
      window.removeEventListener("storage", write);
      window.removeEventListener("session-updated", write);
    };
  }, [wake, links, groups, title, body, call]);

  // A contact that held the subscription was deleted or muted: a new one (new endpoint, new key pair, new tokens for
  // the others), and the old one ends at the push service, so that contact can no longer wake this app.
  const rotate = !!state?.settings.wakeRotate && !!wake;
  useEffect(() => {
    if (rotate) void rotateWake();
  }, [rotate]);

  const endpoint = wake?.endpoint;
  useEffect(() => {
    const push = pushPlatform();
    if (!push || !wake) return;
    const profile = activeProfileId();
    void push.current(profile).then(async (current) => {
      if (current?.endpoint === wake.endpoint) return;
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        const keys = await push.subscribe(profile, wake.vapid);
        await engine.call("setWakeSubscription", { subscription: { ...keys, vapid: wake.vapid } });
      } else {
        await engine.call("setWakeSubscription", { subscription: null });
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per subscription
  }, [endpoint]);
}
