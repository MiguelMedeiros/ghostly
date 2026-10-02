import { EngineServer } from "../engine/server";
import type { NodeOptions } from "../engine/node";
import { openDeviceGate, type DeviceGate } from "./gate";
import { DeviceLinkOnlyServer, type DeviceLinkEngine, type PeerServer } from "./linkOnly";

/**
 * Starts what this device may run for the profile (WISP 06 § The gate): the device state is read first, and only a
 * `single` or `active` device gets the engine. Every host starts its peer through here, so `EngineServer`, whose
 * constructor starts the node at once, is never made on a standby. `gate` and `standby` are for tests.
 */
export async function createPeerServer(options: NodeOptions | undefined, overrides: { gate?: DeviceGate; standby?: DeviceLinkEngine } = {}): Promise<PeerServer> {
  const gate = overrides.gate ?? await openDeviceGate();
  return gate.full ? new EngineServer(options) : new DeviceLinkOnlyServer(gate, overrides.standby);
}
