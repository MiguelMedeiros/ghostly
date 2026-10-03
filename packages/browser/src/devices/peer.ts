import { EngineServer } from "../engine/server";
import type { NodeOptions } from "../engine/node";
import { DEFAULT_IROH_RELAYS, createIrohWebEndpoint } from "../platform/irohWeb";
import { openDeviceGate, type DeviceGate } from "./gate";
import { DeviceLinkOnlyServer, type DeviceLinkEngine, type PeerServer } from "./linkOnly";
import { DeviceLinks } from "./links";
import { standbyNetwork } from "./network";
import { readDeviceRecord } from "./store";
import { standbyHandoff, undoStagingOf } from "./handoffStandby";

/**
 * What device-link-only mode runs for a device that is not the active one (WISP 06 § The gate): its device links,
 * over the transports the engine would use, from the device record and the device signing key alone. The person's
 * relays, Iroh relays and ICE servers come from the record's copy of the settings (`network.ts`), and with the network
 * off the links ask nothing of anyone. A device whose state could not be read holds no links: nothing is known of its
 * device set.
 */
export async function standbyEngine(gate: DeviceGate, options: NodeOptions | undefined): Promise<DeviceLinkEngine | undefined> {
  if (gate.state === "unreadable") return undefined;
  let record = null;
  try { record = await readDeviceRecord(gate.profile); } catch { /* the links read it again, and say why they hold none */ }
  const network = standbyNetwork(record?.network, options?.transport);
  const irohRelays = network.irohRelays ?? [...DEFAULT_IROH_RELAYS];
  const links: DeviceLinks = new DeviceLinks({
    profile: gate.profile,
    // A taker that lost its settle read goes back to its old namespace (WISP 06 § Installing the staged state).
    undoStaging: () => undoStagingOf(gate.profile),
    handoff: (running, host) => standbyHandoff({
      profile: gate.profile, links: running,
      show: (view) => host?.show(view),
      take: async (release, turn) => (await running.turnKeeper())?.take(release, turn) ?? null,
    }),
    offline: network.off,
    transport: network.transport,
    createPeerConnection: network.createPeerConnection,
    pollIntervals: options?.pollIntervals,
    nativeTransports: {
      ...options?.nativeTransports,
      ...(options?.irohWeb ? { "iroh/1": (seedB64: string) => createIrohWebEndpoint(seedB64, { relays: irohRelays }) } : {}),
    },
  });
  return links;
}

/**
 * Starts what this device may run for the profile (WISP 06 § The gate): the device state is read first, and only a
 * `single` or `active` device gets the engine. Every host starts its peer through here, so `EngineServer`, whose
 * constructor starts the node at once, is never made on a standby. A standby gets its device links instead
 * (`standbyEngine`). `gate` and `standby` are for tests.
 */
export async function createPeerServer(options: NodeOptions | undefined, overrides: { gate?: DeviceGate; standby?: DeviceLinkEngine } = {}): Promise<PeerServer> {
  const gate = overrides.gate ?? await openDeviceGate();
  if (gate.full) return new EngineServer(options);
  return new DeviceLinkOnlyServer(gate, overrides.standby ?? await standbyEngine(gate, options));
}
