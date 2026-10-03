import { useEffect, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { getBrowserHost } from "@ghostly/browser/host";
import type { EnrollFailure } from "@ghostly/browser/devices/enroll";
import type { DeviceSetView } from "@ghostly/browser/devices/links";
import type { WalletView } from "@ghostly/browser/shared/types";
import type { TranslationKey } from "../contexts/I18nContext";
import { createProfile, currentProfile, switchProfile } from "./profiles";

/*
 * One profile on several devices (WISP 06), as the pages need it: the lock password a device set needs, the name a
 * device gets, and what an enrollment's errors say.
 */

/** The lock password of a profile with no device set (Settings, today's rule). */
export const LOCK_PASSWORD_MIN = 4;
/** A profile on several devices needs a lock password of at least 8 characters (WISP 06 § Adding a device). */
export const DEVICE_SET_PASSWORD_MIN = 8;

/** The shortest lock password this profile may have: 8 with a device set, 4 without. */
export const lockPasswordMin = (deviceSet: boolean): number => (deviceSet ? DEVICE_SET_PASSWORD_MIN : LOCK_PASSWORD_MIN);

/** Why a new lock password is refused before it is hashed: too short for this profile, or not typed the same twice. */
export function lockPasswordProblem(password: string, again: string, deviceSet: boolean): "short" | "mismatch" | null {
  if (password.length < lockPasswordMin(deviceSet)) return "short";
  if (password !== again) return "mismatch";
  return null;
}

/** A first guess at this device's name, for the person to change: the kind of device, at most 16 characters. */
export function defaultDeviceName(env: { userAgent: string; platform?: string; maxTouchPoints?: number; desktop?: boolean } = typeof navigator === "undefined" ? { userAgent: "" } : { userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints }): string {
  const ua = env.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (env.platform === "MacIntel" && (env.maxTouchPoints ?? 0) > 1)) return "iPad";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Phone" : "Tablet";
  const os = /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux|X11|CrOS/.test(ua) ? "Linux" : "";
  if (env.desktop) return os ? `${os} app` : "Desktop";
  const browser = /Firefox\//.test(ua) ? "Firefox" : /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return (browser && os ? `${browser} on ${os}` : browser || os || "Browser").slice(0, 16);
}

/** What the engine's `enroll-<reason>:` errors, and a failed enrollment's reason, say to the person. */
const FAILURE_KEYS: Record<string, TranslationKey> = {
  expired: "devices.fail.expired", digits: "devices.fail.digits", used: "devices.fail.used", cancelled: "devices.fail.cancelled",
  proof: "devices.fail.proof", dropped: "devices.fail.dropped", unanswered: "devices.fail.unanswered", unreachable: "devices.fail.unreachable",
  elsewhere: "devices.fail.elsewhere", full: "devices.fail.full", replaced: "devices.fail.replaced", failed: "devices.fail.failed",
  "in-use": "devices.fail.inUse", loading: "devices.fail.loading", offline: "devices.fail.offline", set: "devices.fail.set", typo: "devices.fail.typo", update: "devices.fail.update",
  "not-ghostly": "devices.fail.notGhostly", damaged: "devices.fail.damaged", chat: "devices.fail.chat", "home-screen": "devices.join.homeScreen",
};

export const failureKey = (reason: EnrollFailure | string): TranslationKey => FAILURE_KEYS[reason] ?? "devices.fail.failed";

/** The message key of an engine error from an enrollment call, or null for an error of another kind. */
export function enrollErrorKey(error: unknown): TranslationKey | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const reason = message.match(/^enroll-([a-z-]+):/)?.[1];
  return reason ? failureKey(reason) : null;
}

/** The profile's device set, read when the page opens and every `everyMs` while it shows (0: once). Null until read. */
export function useDeviceSet(everyMs = 3_000): DeviceSetView | null {
  const [view, setView] = useState<DeviceSetView | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => void engine.call("deviceSet").then((next) => { if (live) setView(next); }, () => {});
    read();
    const timer = everyMs > 0 ? setInterval(read, everyMs) : undefined;
    return () => { live = false; clearInterval(timer); };
  }, [everyMs]);
  return view;
}

/** Starts the app again into the gate: where the engine outlives the page (the extension), it starts again too. */
export async function reloadIntoGate(): Promise<void> {
  try { await getBrowserHost().restartEngine?.(); } catch { /* the reload says what is wrong now */ }
  window.location.reload();
}

/** What the engine's `takeover-<reason>:` errors say to the person. */
const TAKEOVER_FAILURES: Record<string, TranslationKey> = {
  password: "devices.password.wrong", "locked-out": "devices.takeover.fail.lockedOut", refused: "devices.takeover.fail.refused",
  "no-copy": "devices.takeover.fail.noCopy", "no-password": "devices.takeover.fail.noPassword", name: "devices.takeover.fail.name",
  offline: "devices.takeover.fail.offline", state: "devices.takeover.fail.state",
};

export function takeoverErrorKey(error: unknown): TranslationKey | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const reason = message.match(/^takeover-([a-z-]+):/)?.[1];
  return reason ? TAKEOVER_FAILURES[reason] ?? "devices.takeover.fail.state" : null;
}

/** What the engine's `remove-<reason>:` errors (Remove, New device secret) say to the person. */
export function removeErrorKey(error: unknown): TranslationKey | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const reason = message.match(/^remove-([a-z-]+):/)?.[1];
  if (!reason) return null;
  return reason === "busy" ? "devices.remove.fail.busy" : reason === "offline" ? "devices.fail.offline" : "devices.remove.fail.failed";
}

/** Names as a list a person reads in their language: "Desktop and Phone", "Desktop, Phone and Tablet". */
export function listNames(names: readonly string[], language: string): string {
  // Not in this build's TypeScript library, but in every browser the app runs in.
  const ListFormat = (Intl as unknown as { ListFormat?: new (locale: string, options: object) => { format(list: readonly string[]): string } }).ListFormat;
  try { if (ListFormat) return new ListFormat(language, { style: "long", type: "conjunction" }).format(names); } catch { /* below */ }
  return names.join(", ");
}

const JOIN_REQUEST = "ghostly_join_device";

/**
 * "Add this device to my profile" on a device that is out of its set (removed, or whose devices changed while it was
 * off, WISP 06 § Removing a device): a new profile here, which opens on "Add this device to my profile". The profile it
 * leaves keeps its frozen copy untouched; it is never started as a second copy.
 */
export function reenrollHere(): void {
  const entry = createProfile(currentProfile().name);
  try { sessionStorage.setItem(JOIN_REQUEST, entry.id); } catch { /* the person opens it from the home screen */ }
  switchProfile(entry.id, { route: "/" });
}

/** Whether this page was opened to add the device to a profile (`reenrollHere`). Asked once: the request is used up. */
export function takeJoinRequest(profileId: string): boolean {
  try {
    if (sessionStorage.getItem(JOIN_REQUEST) !== profileId) return false;
    sessionStorage.removeItem(JOIN_REQUEST);
    return true;
  } catch { return false; }
}

/** Wallets the lost device could spend from, as the checklist names them (WISP 06 § Removing a device, "Lost or stolen?"). */
export function lostWalletLines(wallet: WalletView | undefined): { cashu: boolean; phrase: string[]; remote: string[] } {
  const types = new Set((wallet?.wallets ?? []).map((w) => w.type));
  const names: Record<string, string> = { arkade: "Ark", bark: "Bark", spark: "Spark", bitcoin: "Bitcoin", fedimint: "Fedimint", usdt: "USDT" };
  const phrase = Object.entries(names).filter(([type]) => types.has(type as never)).map(([, name]) => name);
  const remote: string[] = [];
  for (const network of Object.values(wallet?.networks ?? {})) {
    for (const card of network?.lightnings ?? []) {
      // The Cashu mints' card is the ecash line; Breez and Fedimint are phrase wallets; a WebLN wallet lives in the lost
      // browser's own extension, not in the profile; anything else is a node of the person's own, reached with a credential.
      if (card.isDefault || card.card === "cashu" || !card.providerId || card.providerId === "cashu-mint" || card.providerId === "webln") continue;
      if (card.providerId === "breez" || card.providerId === "fedimint") { if (!phrase.includes(card.name)) phrase.push(card.name); continue; }
      if (!remote.includes(card.name)) remote.push(card.name);
    }
  }
  return { cashu: types.has("cashu"), phrase, remote };
}
