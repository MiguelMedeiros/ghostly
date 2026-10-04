import { useSyncExternalStore } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import { knownDeviceGate, type DeviceGateView } from "@ghostly/browser/devices/gate";

const subscribe = (listener: () => void) => engine.subscribe(listener);
/** What the peer said, or what the page itself read before it drew anything (the entry points do, see `openDeviceGate`). */
const gateNow = (): DeviceGateView | null => engine.deviceGate ?? knownDeviceGate()?.view ?? null;

/**
 * Set when this device is not the active one for the profile (WISP 06 § The gate). The app then shows the standby
 * screen and nothing of the profile: no chat list, no composer, no link intake, since nothing may be written into a
 * standby's copy and no engine runs to send anything.
 */
export function useDeviceGate(): DeviceGateView | null {
  return useSyncExternalStore(subscribe, gateNow);
}
