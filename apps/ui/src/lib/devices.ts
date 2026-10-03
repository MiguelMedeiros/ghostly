import { useEffect, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { getBrowserHost } from "@ghostly/browser/host";
import type { EnrollFailure } from "@ghostly/browser/devices/enroll";
import type { DeviceSetView } from "@ghostly/browser/devices/links";
import type { TranslationKey } from "../contexts/I18nContext";

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
  "in-use": "devices.fail.inUse", offline: "devices.fail.offline", set: "devices.fail.set", typo: "devices.fail.typo", update: "devices.fail.update",
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
