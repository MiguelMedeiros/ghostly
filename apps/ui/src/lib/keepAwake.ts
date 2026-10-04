import { useEffect, useState } from "react";
import { getBrowserHost } from "@ghostly/browser/host";
import { engine } from "@ghostly/browser/platform/engine";
import type { DeviceSetView } from "@ghostly/browser/devices/links";
import type { HandoffView } from "@ghostly/browser/devices/handoff";

/*
 * "Keep this computer awake" (WISP 06 § User experience, Profile, Devices): on a Desktop with a standby device, a switch
 * that keeps the computer from sleeping while it is the active device, "So your phone can take over while you are out."
 * A handoff in progress keeps it awake too, on either side, switch or not: a computer that sleeps in the middle of one
 * leaves the other device waiting. The switch is this device's, not the profile's: it is kept in this app's storage and
 * never moves with the profile.
 */

const KEY = "ghostly_keep_awake";
const EVENT = "ghostly-keep-awake";
/** How often the device set and the handoff are looked at again. */
const CHECK_EVERY_MS = 5_000;

const host = () => { try { return getBrowserHost(); } catch { return null; } };

/** Whether this app can keep its computer awake (the desktop app). */
export function keepAwakeSupported(): boolean {
  return typeof host()?.keepAwake === "function";
}

function readSetting(): boolean {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}

/** The switch, as this device keeps it. */
export function useKeepAwakeSetting(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(readSetting);
  useEffect(() => {
    const changed = () => setOn(readSetting());
    window.addEventListener(EVENT, changed);
    window.addEventListener("storage", changed);
    return () => { window.removeEventListener(EVENT, changed); window.removeEventListener("storage", changed); };
  }, []);
  const set = (next: boolean) => {
    try { if (next) localStorage.setItem(KEY, "1"); else localStorage.removeItem(KEY); } catch { /* storage off: for this session only */ }
    setOn(next);
    window.dispatchEvent(new Event(EVENT));
  };
  return [on, set];
}

/** Whether a device set has another device on standby, so the switch means something here. */
export function hasStandby(view: DeviceSetView | null): boolean {
  return !!view && view.state === "active" && view.devices.some((device) => !device.self);
}

/** A handoff is running on this device (either side): from its first step to the end of the settle wait. */
export function handoffRunning(view: HandoffView | null): boolean {
  return !!view && view.step !== "failed" && view.step !== "done" && view.step !== "offer";
}

/** Whether the computer is to be kept awake now. */
export function keepAwakeWanted(setting: boolean, set: DeviceSetView | null, handoff: HandoffView | null): boolean {
  return (setting && hasStandby(set)) || handoffRunning(handoff);
}

/**
 * Holds the computer awake while `keepAwakeWanted` says so, and lets go when it no longer does or the app goes away.
 * Nothing where the app cannot (a web page, the extension). Mounted wherever the profile runs, the standby screen too.
 */
export function useComputerAwake(): void {
  const supported = keepAwakeSupported();
  const [setting] = useKeepAwakeSetting();
  const [wanted, setWanted] = useState(false);
  useEffect(() => {
    if (!supported) return;
    let live = true;
    const check = async () => {
      const [set, handoff] = await Promise.all([engine.call("deviceSet").catch(() => null), engine.call("deviceHandoffView").catch(() => null)]);
      if (live) setWanted(keepAwakeWanted(setting, set, handoff));
    };
    void check();
    const timer = setInterval(() => void check(), CHECK_EVERY_MS);
    return () => { live = false; clearInterval(timer); };
  }, [supported, setting]);
  useEffect(() => {
    if (!supported) return;
    void host()?.keepAwake?.(wanted).catch(() => false);
  }, [supported, wanted]);
  useEffect(() => () => { if (supported) void host()?.keepAwake?.(false).catch(() => false); }, [supported]);
}
