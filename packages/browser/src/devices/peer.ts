import { RelayTransport } from "@ghostly/core";
import { EngineServer } from "../engine/server";
import type { NodeOptions } from "../engine/node";
import { DEFAULT_IROH_RELAYS, createIrohWebEndpoint } from "../platform/irohWeb";
import { openDeviceGate, type DeviceGate } from "./gate";
import { DeviceLinkOnlyServer, type DeviceLinkEngine, type PeerServer } from "./linkOnly";
import { DeviceLinks } from "./links";

/**
 * What device-link-only mode runs for a device that is not the active one (WISP 06 § The gate): its device links,
 * over the transports the engine would use, from the device record and the device signing key alone. The relays and
 * the Iroh relays are the app's defaults: the person's own settings are in the profile's database, which stays shut.
 * A device whose state could not be read holds no links: nothing is known of its device set.
 */
export function standbyEngine(gate: DeviceGate, options: NodeOptions | undefined): DeviceLinkEngine | undefined {
  if (gate.state === "unreadable") return undefined;
  return new DeviceLinks({
    profile: gate.profile,
    transport: options?.transport ?? new RelayTransport(),
    pollIntervals: options?.pollIntervals,
    nativeTransports: {
      ...options?.nativeTransports,
      ...(options?.irohWeb ? { "iroh/1": (seedB64: string) => createIrohWebEndpoint(seedB64, { relays: [...DEFAULT_IROH_RELAYS] }) } : {}),
    },
  });
}

/**
 * Starts what this device may run for the profile (WISP 06 § The gate): the device state is read first, and only a
 * `single` or `active` device gets the engine. Every host starts its peer through here, so `EngineServer`, whose
 * constructor starts the node at once, is never made on a standby. A standby gets its device links instead
 * (`standbyEngine`). `gate` and `standby` are for tests.
 */
export async function createPeerServer(options: NodeOptions | undefined, overrides: { gate?: DeviceGate; standby?: DeviceLinkEngine } = {}): Promise<PeerServer> {
  const gate = overrides.gate ?? await openDeviceGate();
  return gate.full ? new EngineServer(options) : new DeviceLinkOnlyServer(gate, overrides.standby ?? standbyEngine(gate, options));
}
