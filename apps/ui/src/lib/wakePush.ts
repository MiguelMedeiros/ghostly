import { useEffect, useSyncExternalStore } from "react";
import { generateVapidKeys, type VapidKeys } from "@ghostly/core";
import { engine } from "@ghostly/browser/platform/engine";
import { databaseName } from "@ghostly/browser/shared/idb";
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

/**
 * The words the push worker shows, in the app's language. The device ones carry `{device}` where a device's name goes
 * (WISP 06 § Push and the phone), and `db` is the profile's peer database: where the worker finds its device state.
 */
export interface WakeWords {
  title: string;
  body: string;
  call?: string;
  standby?: string;
  standbyCall?: string;
  standbyUnnamed?: string;
  standbyCallUnnamed?: string;
  takeover?: string;
  moveHere?: string;
  db?: string;
}

export interface PushPlatform {
  supported(): boolean;
  subscribe(profile: string, vapid: Pick<VapidKeys, "publicKey">): Promise<PushKeys>;
  current(profile: string): Promise<PushKeys | null>;
  unsubscribe(profile: string): Promise<void>;
  syncTable(profile: string, entries: readonly WakeTableEntry[], text: WakeWords): Promise<void>;
  /** The words and the database name alone, the tokens left as they are: a standby's page writes these. */
  syncText?(profile: string, text: WakeWords): Promise<void>;
}

/** The device words of the push worker, with `{device}` left in for the worker to fill (`t` interpolates `{{device}}`). */
export function deviceWakeWords(t: (key: "pwa.wakeStandby" | "pwa.wakeStandbyCall" | "pwa.wakeStandbyUnnamed" | "pwa.wakeStandbyCallUnnamed" | "pwa.wakeTakeover" | "pwa.wakeMoveHere", values?: Record<string, string>) => string): Omit<WakeWords, "title" | "body" | "call" | "db"> {
  const device = { device: "{device}" };
  return {
    standby: t("pwa.wakeStandby", device), standbyCall: t("pwa.wakeStandbyCall", device), standbyUnnamed: t("pwa.wakeStandbyUnnamed"),
    standbyCallUnnamed: t("pwa.wakeStandbyCallUnnamed"), takeover: t("pwa.wakeTakeover", device), moveHere: t("pwa.wakeMoveHere", device),
  };
}

let platform: PushPlatform | null = null;
export function setPushPlatform(next: PushPlatform | null): void {
  platform = next;
}
export function pushPlatform(): PushPlatform | null {
  return platform?.supported() ? platform : null;
}
/** The web app in a browser that cannot be woken (no service worker, no Push, no notifications): Settings says so. */
export function pushUnavailable(): boolean {
  try { return !!platform && !platform.supported(); } catch { return !!platform; }
}

const subscribeEngine = (listener: () => void) => engine.subscribe(listener);
const engineSnapshot = () => engine.state;

/**
 * Whether this device is woken now (it shared a subscription of its own), as the engine has it. In a profile on several
 * devices a subscription that is another device's (the phone's, given to contacts while this desktop is active) is not
 * this device's: the switch is off here (WISP 06 § Push and the phone).
 */
export function useWakeOn(): boolean {
  const state = useSyncExternalStore(subscribeEngine, engineSnapshot);
  return !!state?.settings.wake && state.wakeOwner !== "away";
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
    // Another device's subscription is that device's to replace, never this one's (WISP 06 § Push and the phone).
    if (!push || !engine.state?.settings.wake || engine.state.wakeOwner === "away") return;
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
export function useWakeTableSync(text: WakeWords): void {
  const state = useSyncExternalStore(subscribeEngine, engineSnapshot);
  const wake = state?.settings.wake;
  const owner = state?.wakeOwner;
  const links = state?.links;
  const groups = state?.groups;
  const words = JSON.stringify({ ...text, db: databaseName() });
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
        // Private groups (WISP 902 · Group Mesh § Wake-up push): a token per member, all opening the group; muted, none.
        for (const group of groups ?? []) {
          if (group.profile !== "mesh") continue;
          const until = mutedUntil(groupChat(group.id));
          if (!!group.wakeMuted !== (until !== undefined)) void engine.call("setWakeMuted", { linkId: groupChat(group.id), muted: until !== undefined }).catch(() => {});
          for (const token of group.wakeTokens ?? []) entries.push({ token, path: groupPath(group.id), ...(until !== undefined && { mutedUntil: until }) });
        }
      }
      void push.syncTable(profile, entries, JSON.parse(words) as WakeWords).catch(() => {});
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
  }, [wake, links, groups, words]);

  // A contact that held the subscription was deleted or muted: a new one (new endpoint, new key pair, new tokens for
  // the others), and the old one ends at the push service, so that contact can no longer wake this app. Not for
  // another device's subscription, which that device replaces.
  const rotate = !!state?.settings.wakeRotate && !!wake && owner !== "away";
  useEffect(() => {
    if (rotate) void rotateWake();
  }, [rotate]);

  const endpoint = wake?.endpoint;
  useEffect(() => {
    const push = pushPlatform();
    if (!push || !wake) return;
    const profile = activeProfileId();
    void push.current(profile).then(async (current) => {
      if (current?.endpoint === wake.endpoint) {
        // This browser's own: in a profile on several devices it names this device (made before it had a device set).
        if (owner !== "here") await engine.call("wakeConfirm", { endpoint: wake.endpoint });
        return;
      }
      // Another device's subscription, given to contacts while this device is active (WISP 06 § Push and the phone): it
      // is neither made again here nor turned off. This device has none of its own until the person turns it on here.
      if (owner === "away") return;
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        const keys = await push.subscribe(profile, wake.vapid);
        await engine.call("setWakeSubscription", { subscription: { ...keys, vapid: wake.vapid } });
      } else {
        await engine.call("setWakeSubscription", { subscription: null });
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per subscription and owner
  }, [endpoint, owner]);
}

/**
 * A standby's side of push (WISP 06 § Push and the phone), on the standby screen of the installed web app: the words the
 * push worker shows on this device and where it finds the device state (written now: this page holds no chats), and this
 * device's own subscription kept as the browser has it. A browser may replace a subscription at any time: the device
 * record follows, with the same key pair, and the other devices are told over the device link. With notifications no
 * longer allowed, this device has none any more, and they are told that too. When a new subscription is wanted
 * (`renew`: a device that knew this one's was removed, or a contact that held it was deleted or muted on the active
 * device), a new one is made with a new key pair. Looked at again every `STANDBY_PUSH_EVERY_MS`, since the active device
 * may ask while the screen shows.
 */
export function useStandbyPush(text: WakeWords, on: boolean): void {
  const words = JSON.stringify({ ...text, db: databaseName() });
  useEffect(() => {
    const push = pushPlatform();
    if (!push || !on) return;
    const profile = activeProfileId();
    void push.syncText?.(profile, JSON.parse(words) as WakeWords).catch(() => {});
    let busy = false;
    const keep = async () => {
      if (busy) return;
      busy = true;
      try {
        const stored = await engine.call("devicePushState");
        if (!stored) return;
        const current = await push.current(profile);
        if (current?.endpoint === stored.endpoint && !stored.renew) return;
        if (typeof Notification === "undefined" || Notification.permission !== "granted") {
          await engine.call("devicePushSet", { subscription: null });
          return;
        }
        // A renewal: a new endpoint and a new key pair, so whoever held the old ones reaches nothing.
        const vapid = stored.renew ? generateVapidKeys() : undefined;
        const keys = await push.subscribe(profile, vapid ?? { publicKey: stored.vapidPublic });
        await engine.call("devicePushSet", { subscription: vapid ? { ...keys, vapid } : keys });
      } finally { busy = false; }
    };
    void keep().catch(() => {});
    const timer = setInterval(() => void keep().catch(() => {}), STANDBY_PUSH_EVERY_MS);
    return () => clearInterval(timer);
  }, [words, on]);
}

/** How often a standby's page looks at its subscription again (`useStandbyPush`). */
export const STANDBY_PUSH_EVERY_MS = 60_000;
