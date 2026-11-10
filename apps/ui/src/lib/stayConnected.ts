import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { EngineState } from "@ghostly/browser/shared/types";
import { useIsLocked } from "../contexts/LockScreenContext";
import { useEngineValue } from "./engineState";
import { androidApp } from "./touchOnly";

/*
 * "Stay connected in the background" (Settings → Notifications, the Android app only, on unless turned off). Out of
 * sight (Home, another app, the screen off) Android freezes an app that runs nothing in the foreground, and every
 * chat's and group's link went down within seconds: on return each one connected again, or waited for Reconnect.
 * While the switch is on, the app unlocked and online, with a chat or a group, Rust's `connection_service` holds a
 * foreground service with a quiet "Ghostly is connected" notification (ConnectionService.kt), and a wake lock while a
 * link is up; it is told again every few minutes, and the wake lock runs out by itself should it stop being told.
 * Off, the app goes back to stopping out of sight. The switch is this device's, not the profile's.
 */

const KEY = "ghostly_stay_connected";
const EVENT = "ghostly-stay-connected";
/** How often the service is told again while on: well within its wake lock's lease (ConnectionHolds.LINKS_LEASE_MS). */
export const TELL_AGAIN_MS = 5 * 60_000;

function readSetting(): boolean {
  try { return localStorage.getItem(KEY) !== "0"; } catch { return true; }
}

/** The switch, as this device keeps it: on unless the person turned it off. */
export function useStayConnectedSetting(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(readSetting);
  useEffect(() => {
    const changed = () => setOn(readSetting());
    window.addEventListener(EVENT, changed);
    window.addEventListener("storage", changed);
    return () => { window.removeEventListener(EVENT, changed); window.removeEventListener("storage", changed); };
  }, []);
  const set = (next: boolean) => {
    try { if (next) localStorage.removeItem(KEY); else localStorage.setItem(KEY, "0"); } catch { /* storage off: for this session only */ }
    setOn(next);
    window.dispatchEvent(new Event(EVENT));
  };
  return [on, set];
}

/** What of the engine's state the service follows: anyone to stay connected to, and whether any link is up now. */
export interface ConnectionNeed {
  /** Online (Ghostly's own switch, not a limited start) with at least one chat or group. */
  wanted: boolean;
  /** A chat's link or a group member's is open now. */
  links: boolean;
}

export function connectionNeed(state: EngineState | null | undefined): ConnectionNeed {
  if (!state) return { wanted: false, links: false };
  const online = state.settings.online && !state.limited;
  const groups = state.groups.filter((group) => group.status !== undefined && group.status !== "lost");
  const wanted = online && (state.links.length > 0 || groups.length > 0);
  const links = wanted && (state.links.some((link) => link.dataLink === "open") || groups.some((group) => group.members.some((member) => member.edge?.state === "open")));
  return { wanted, links };
}

// The system ended the app under the service last time (said once a run): a notice offers the battery setting.
let stopped = false;
const stoppedListeners = new Set<() => void>();
function setStopped(next: boolean) {
  if (stopped === next) return;
  stopped = next;
  for (const listener of stoppedListeners) listener();
}
const onStopped = (listener: () => void) => { stoppedListeners.add(listener); return () => { stoppedListeners.delete(listener); }; };

/** Whether to show that Android stopped Ghostly in the background, until the person dismisses it or turns the switch off. */
export const useStoppedInBackground = (): boolean => useSyncExternalStore(onStopped, () => stopped);
export const dismissStoppedInBackground = () => setStopped(false);

/**
 * Holds the Android connection service while the switch is on, the app unlocked and the engine has someone to stay
 * connected to, and tells it again as links come and go and every `TELL_AGAIN_MS`; lets go otherwise, and when the
 * profile closes. Nothing outside the Android app.
 */
export function useStayConnected(): void {
  const android = androidApp();
  const [setting] = useStayConnectedSetting();
  const isLocked = useIsLocked();
  const need = useEngineValue(connectionNeed);
  const on = android && setting && !isLocked && need.wanted;
  const links = on && need.links;

  useEffect(() => {
    if (!android) return;
    let live = true;
    const tell = () => {
      void invoke<{ held: boolean; killed: boolean }>("connection_service", { on, links })
        .then((answer) => { if (live && answer?.killed) setStopped(true); })
        .catch(() => {});
    };
    tell();
    const timer = on ? setInterval(tell, TELL_AGAIN_MS) : undefined;
    return () => { live = false; clearInterval(timer); };
  }, [android, on, links]);

  // Turned off: no notice about it any more.
  useEffect(() => { if (!setting) setStopped(false); }, [setting]);

  useEffect(() => () => { if (android) void invoke("connection_service", { on: false, links: false }).catch(() => {}); }, [android]);
}
