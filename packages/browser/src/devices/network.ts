import { RTC_CONFIG, RelayTransport, type PkarrTransport } from "@ghostly/core";
import { iceServerProblem } from "../shared/ice";
import type { Settings } from "../shared/types";
import { amendDevice, readDeviceRecord } from "./store";
import type { DeviceNetwork, DeviceRecord } from "./state";

/*
 * A standby's network settings (WISP 06 § The gate). The person's relays, Iroh relays, ICE servers and "network off"
 * live in the profile's database, which a device that is not the active one never opens. So the active device keeps a
 * copy of them in the device record, written whenever the person changes one (`GhostlyNode.updateSettings`) and when a
 * device set is made or joined (`saveDeviceNetwork`, which enrollment calls). Device-link-only mode reads them from
 * there: its links go through the person's relays, and with the network off it asks nothing of anyone.
 */

/** The network settings a standby needs, out of the profile's settings. */
export function deviceNetworkOf(settings: Pick<Settings, "online" | "relays" | "readRelays" | "irohRelays" | "iceServers" | "pushRelay">): DeviceNetwork {
  return {
    ...(settings.online === false ? { off: true } : {}),
    ...(settings.relays?.length ? { relays: [...settings.relays] } : {}),
    ...(settings.readRelays === true ? { readRelays: true } : {}),
    ...(settings.irohRelays?.length ? { irohRelays: [...settings.irohRelays] } : {}),
    ...(settings.iceServers?.length ? { iceServers: settings.iceServers.map((server) => ({ ...server })) } : {}),
    // A standby web app wakes another device through it (WISP 06 § Push and the phone): a page may not post to a push service.
    ...(settings.pushRelay ? { pushRelay: settings.pushRelay } : {}),
  };
}

const same = (a: DeviceNetwork | undefined, b: DeviceNetwork) => JSON.stringify(a ?? {}) === JSON.stringify(b);

/**
 * Keeps the profile's network settings in its device record. A profile with no device set has no record, and gets
 * none: nothing is written, and no database is made. Settings that did not change write nothing either.
 */
export async function saveDeviceNetwork(profile: string, settings: Parameters<typeof deviceNetworkOf>[0]): Promise<DeviceRecord | null> {
  const record = await readDeviceRecord(profile);
  if (!record) return null;
  const network = deviceNetworkOf(settings);
  if (same(record.network, network)) return record;
  return amendDevice(profile, { network });
}

/** What device links need of the network: where Pkarr is, how to make a WebRTC connection, which Iroh relays. */
export interface StandbyNetwork {
  /** The network is off: nothing is asked of anyone. */
  off: boolean;
  transport: PkarrTransport;
  /** Absent where the page has no WebRTC. */
  createPeerConnection?: () => RTCPeerConnection;
  /** The Iroh relays the person chose; absent for the defaults. */
  irohRelays?: string[];
}

/**
 * The network of device-link-only mode, from the record's copy of the settings: the given transport (Desktop's) told
 * the person's relays, or relays of the person's own; the person's ICE servers after the app's own.
 */
export function standbyNetwork(network: DeviceNetwork | undefined, given?: PkarrTransport): StandbyNetwork {
  const relays = network?.relays?.length ? network.relays : undefined;
  let transport: PkarrTransport;
  if (given) {
    transport = given;
    if (relays) given.configure?.({ relays, readRelays: network?.readRelays === true });
  } else transport = new RelayTransport(relays ? { relays } : {});
  const iceServers = [...(RTC_CONFIG.iceServers ?? []), ...(network?.iceServers ?? []).filter((server) => !iceServerProblem(server))];
  return {
    off: network?.off === true,
    transport,
    ...(typeof RTCPeerConnection === "undefined" ? {} : { createPeerConnection: () => new RTCPeerConnection({ iceServers }) }),
    ...(network?.irohRelays?.length ? { irohRelays: network.irohRelays } : {}),
  };
}
