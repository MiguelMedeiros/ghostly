import { databaseName } from "../shared/idb";
import { runsEngine, type DeviceRecord, type DeviceState } from "./state";
import { readDeviceRecord } from "./store";

/*
 * The gate (WISP 06 § The gate). The device state is read before the engine exists, on every client: `GhostlyNode`
 * opens the peer database, starts the identities, the DID and every wallet as soon as it starts, and none of that may
 * run on a device that is not the active one. So the choice is made here, once per page, from one small local read:
 *
 * - `single` or `active`: the whole engine, as before;
 * - any other state: device-link-only mode (`linkOnly.ts`). No peer database is opened and nothing is published;
 * - a state that cannot be read: nothing starts, and the app says so. It is never taken for `single`.
 */

/** What the pages are told about the gate: names only, never the device-set secret or a key. */
export interface DeviceGateView {
  /** `unreadable`: the device state database did not open, or holds a record this build cannot read. */
  state: Exclude<DeviceState, "single" | "active"> | "unreadable";
  /** The device the stored turn record names active, when there is one and it is not this device. */
  activeDevice?: string;
  /** What the system said, for `unreadable`. */
  detail?: string;
  /**
   * `standby` only: the device was enrolled and has not seen the active device's record that lists it yet (WISP 06
   * § Adding a device, "Not finished"). It holds nothing usable; Remove takes the device set off this device.
   */
  unfinished?: true;
}

export interface DeviceGate {
  /** The profile's peer database name. */
  profile: string;
  state: DeviceState | "unreadable";
  /** Whether the whole engine may start. */
  full: boolean;
  /** For the pages, when the engine may not start. */
  view: DeviceGateView | null;
}

const gates = new Map<string, Promise<DeviceGate>>();
const known = new Map<string, DeviceGate>();

/** What the pages are told of a device record that keeps the engine from starting. */
export function viewOf(record: DeviceRecord): DeviceGateView {
  const active = record.activeSlot !== undefined && record.activeSlot !== record.ownSlot ? record.deviceSet[record.activeSlot] : undefined;
  // Every standby that finished its enrollment accepted a record that lists it: one with no packet did not.
  const unfinished = record.state === "standby" && !record.turnPacket;
  return { state: record.state as DeviceGateView["state"], ...(active?.name ? { activeDevice: active.name } : {}), ...(unfinished ? { unfinished: true as const } : {}) };
}

async function read(profile: string): Promise<DeviceGate> {
  // No IndexedDB at all (a headless run without one): there is no device state to hold, and no peer database either.
  if (typeof indexedDB === "undefined") return { profile, state: "single", full: true, view: null };
  try {
    const record = await readDeviceRecord(profile);
    const state = record?.state ?? "single";
    if (runsEngine(state)) return { profile, state, full: true, view: null };
    return { profile, state, full: false, view: viewOf(record!) };
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { profile, state: "unreadable", full: false, view: { state: "unreadable", detail } };
  }
}

/**
 * The gate of a profile on this device, read once per page: every caller gets the same answer, and a change of state
 * is made by writing it and reloading into the gate, never by asking again. `profile` is the peer database's name,
 * the running profile's unless given.
 */
export function openDeviceGate(profile: string = databaseName()): Promise<DeviceGate> {
  let gate = gates.get(profile);
  if (!gate) {
    gate = read(profile).then((result) => { known.set(profile, result); return result; });
    gates.set(profile, gate);
  }
  return gate;
}

/** The gate as already read on this page, without waiting: undefined until `openDeviceGate` has answered. */
export function knownDeviceGate(profile: string = databaseName()): DeviceGate | undefined {
  return known.get(profile);
}

/** Tests only: forgets what was read, as a reload of the page does. */
export function resetDeviceGates(): void {
  gates.clear();
  known.clear();
}
