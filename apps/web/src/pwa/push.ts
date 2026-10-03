import type { VapidKeys } from "@ghostly/core";
import { pushScope } from "../sw/policy";
import { clearWakeEntries, writeWakeEntries, writeWakeText, type WakeEntry, type WakeText } from "../sw/wakeStore";

/*
 * The page's side of wake-up push (WISP 401 § Wake-up push): this profile's push subscription, made on a worker
 * registered for this profile alone (`/push/<profile>/`), and the table the worker reads to show a wake-up. The
 * engine shares the subscription with paired contacts; nothing here talks to anyone but the browser.
 */

/** The subscription as the engine shares it. */
export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

const SCRIPT = "/sw.js";

function workers(): ServiceWorkerContainer | null {
  try { return "serviceWorker" in navigator && window.isSecureContext ? navigator.serviceWorker ?? null : null; } catch { return null; }
}

/**
 * Whether this browser can be woken while the app is closed: service workers, Push and notifications. Safari on
 * iPhone and iPad has Push only in an app added to the Home Screen (iOS 16.4 and later); elsewhere it is there
 * in the browser too.
 */
export function pushSupported(): boolean {
  return !!workers() && typeof window.PushManager === "function" && typeof window.Notification === "function" && import.meta.env.PROD;
}

const toBase64Url = (buffer: ArrayBuffer | null) =>
  buffer ? btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : "";
const fromBase64Url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function registration(profile: string, create: boolean): Promise<ServiceWorkerRegistration | undefined> {
  const container = workers();
  if (!container) return undefined;
  const scope = new URL(pushScope(profile), location.origin).href;
  const found = await container.getRegistration(scope);
  if (found?.scope === scope) return found;
  if (!create) return undefined;
  const made = await container.register(SCRIPT, { scope: pushScope(profile), updateViaCache: "none" });
  // Subscribing needs an active worker.
  const pending = made.installing ?? made.waiting;
  if (pending && !made.active) {
    await new Promise<void>((resolve) => {
      pending.addEventListener("statechange", () => { if (pending.state === "activated" || pending.state === "redundant") resolve(); });
    });
  }
  return made;
}

function keysOf(subscription: PushSubscription): PushSubscriptionKeys {
  return { endpoint: subscription.endpoint, p256dh: toBase64Url(subscription.getKey("p256dh")), auth: toBase64Url(subscription.getKey("auth")) };
}

/**
 * Subscribes this profile with its VAPID key (asking for notifications first: a push must show one). Throws with
 * a sentence to show when the person refuses or the browser cannot.
 */
export async function subscribePush(profile: string, vapid: Pick<VapidKeys, "publicKey">): Promise<PushSubscriptionKeys> {
  if (!pushSupported()) throw new Error("This browser cannot wake Ghostly while it is closed.");
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications are off for Ghostly in this browser. Allow them, then try again.");
  const made = await registration(profile, true);
  if (!made) throw new Error("This browser cannot wake Ghostly while it is closed.");
  const old = await made.pushManager.getSubscription();
  if (old) await old.unsubscribe().catch(() => false);
  const subscription = await made.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(vapid.publicKey) });
  return keysOf(subscription);
}

/** This profile's subscription as the browser has it now, or null (never made, or dropped by the browser). */
export async function currentPush(profile: string): Promise<PushSubscriptionKeys | null> {
  const found = await registration(profile, false).catch(() => undefined);
  const subscription = await found?.pushManager.getSubscription().catch(() => null);
  return subscription ? keysOf(subscription) : null;
}

/** Stops being woken: the subscription ends at the push service, the worker goes, its table is emptied. */
export async function unsubscribePush(profile: string): Promise<void> {
  const found = await registration(profile, false).catch(() => undefined);
  const subscription = await found?.pushManager.getSubscription().catch(() => null);
  await subscription?.unsubscribe().catch(() => false);
  await found?.unregister().catch(() => false);
  await clearWakeEntries(profile).catch(() => {});
}

/** The worker's table for this profile: which chat each token names, its mute, and the words to show. */
export function syncWakeTable(profile: string, entries: readonly WakeEntry[], text: WakeText): Promise<void> {
  return writeWakeEntries(profile, entries, text);
}

/** The words to show and where the device state is, the tokens left as they are (a standby's page, WISP 06). */
export function syncWakeText(profile: string, text: WakeText): Promise<void> {
  return writeWakeText(profile, text);
}
