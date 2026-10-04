import { EngineServer } from "../engine/server";
import type { NodeOptions } from "../engine/node";
import { DEFAULT_IROH_RELAYS, createIrohWebEndpoint } from "../platform/irohWeb";
import type { PkarrTransport, TurnNetwork } from "@ghostly/core";
import { openDeviceGate, replaceDeviceGate, viewOf, type DeviceGate, type DeviceGateView } from "./gate";
import { openTurnKeeper } from "./setup";
import { recoverEnrollment } from "./enroll";
import type { TurnOutcome } from "./turn";
import { DeviceLinkOnlyServer, type DeviceLinkEngine, type PeerServer } from "./linkOnly";
import { DeviceLinks } from "./links";
import { standbyNetwork } from "./network";
import { readDeviceRecord } from "./store";
import { activeAgainIfReleasing, standbyHandoff, undoStagingOf } from "./handoffStandby";

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
    // A standby reads the turn when its screen opens and every 10 minutes: a removal reaches it as a tombstone.
    watchTurn: true,
    // A taker that lost its settle read goes back to its old namespace (WISP 06 § Installing the staged state).
    undoStaging: () => undoStagingOf(gate.profile),
    handoff: async (running, host) => {
      try {
        const handler = await standbyHandoff({
          profile: gate.profile, links: running,
          show: (view) => host?.show(view),
          take: async (release, turn) => (await running.turnKeeper())?.take(release, turn) ?? null,
        });
        if (handler) return handler;
      } catch { /* below */ }
      // No handoff can run here (no profile host, a key that does not load, any error): a device frozen for pass 2
      // never signed a release, so it is the active device again rather than no device at all.
      await activeAgainIfReleasing(gate.profile, (view) => host?.show(view));
      return null;
    },
    offline: network.off,
    // A wake push to another device for a handoff: Desktop posts it itself; a page goes through the person's push relay.
    ...(options?.pushSend ? { pushSend: options.pushSend } : {}),
    transport: network.transport,
    createPeerConnection: network.createPeerConnection,
    pollIntervals: options?.pollIntervals,
    nativeTransports: {
      // HyperDHT through the person's relay where this app runs none of its own, as the engine's chats (`nativeFactories`).
      ...(network.hyperdhtRelay && !options?.nativeTransports?.["hyperdht/1"]
        ? { "hyperdht/1": async (seedB64: string) => (await import("../platform/hyperdhtRelay")).createRelayedHyperEndpoint(seedB64, network.hyperdhtRelay!) } : {}),
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
export async function createPeerServer(options: NodeOptions | undefined, overrides: { gate?: DeviceGate; standby?: DeviceLinkEngine; turn?: TurnNetwork | null } = {}): Promise<PeerServer> {
  let gate = overrides.gate ?? await openDeviceGate();
  let turnReadAt: number | undefined;
  // The active device of a device set reads the turn before its engine starts (WISP 06 § When a device checks): a device
  // another one replaced while it was off stops here, before it dials or publishes anything.
  if (gate.full && gate.state === "active" && !options?.singleDevice) {
    const start = await activeStart(gate, options, overrides.turn);
    if (start.gated) { gate = { ...gate, state: start.gated.state, full: false, view: start.gated }; replaceDeviceGate(gate); }
    else if (start.limited) return new EngineServer({ ...options, limited: true });
    turnReadAt = start.readAt;
  }
  // The good read at start counts for the single-writer wallets while it is under a minute old (WISP 06 § Wallets).
  if (gate.full) return new EngineServer(turnReadAt === undefined ? options : { ...options, turnReadAt });
  return new DeviceLinkOnlyServer(gate, overrides.standby ?? await standbyEngine(gate, options));
}

/** How the active device starts, after its read at start: the whole engine, limited mode, or not at all (`gated`). */
export interface ActiveStart { gated?: DeviceGateView; limited?: true; /** When the read that said this device is the active one was made. */ readAt?: number }

/**
 * The read an active device makes as a condition of starting (WISP 06 § Device state by turn read, the row "active, at
 * start"): `mine` or `none` write its next record and start; another device's higher turn, a clone of this device or a
 * tombstone write the new state and start nothing; no source answered gives limited mode, which publishes, dials and
 * settles nothing until a good read (the engine reads again every 30 seconds). With the network off, or no turn path,
 * the engine starts as before: it publishes nothing either way.
 */
export async function activeStart(gate: DeviceGate, options: NodeOptions | undefined, given?: TurnNetwork | null): Promise<ActiveStart> {
  const record = await readDeviceRecord(gate.profile).catch(() => undefined);
  // The record that said `active` a moment ago cannot be read again: nothing is published until a good read.
  if (record === undefined) return { limited: true };
  if (!record || record.state !== "active" || record.network?.off) return {};
  const network = given === undefined ? turnPathOf(standbyNetwork(record.network, options?.transport).transport) : given;
  if (!network) return {};
  // An enrollment whose own record was put and whose write of it was lost takes that record back first: the read below
  // would take it for a clone of this device and stop it (as `GhostlyNode.startDeviceSet` does, in the same order).
  await recoverEnrollment(gate.profile, network).catch(() => false);
  let outcome: TurnOutcome | null;
  try {
    const keeper = await openTurnKeeper(gate.profile, network);
    outcome = keeper ? await keeper.check(true) : null;
  } catch { return { limited: true }; /* no good read: the profile offline, until one (the engine reads again) */ }
  if (!outcome) return {};
  if (outcome.kind === "gated") {
    const now = await readDeviceRecord(gate.profile).catch(() => null);
    return { gated: now ? viewOf(now) : { state: outcome.state as DeviceGateView["state"] } };
  }
  if (outcome.kind === "start" || outcome.kind === "go-on" || outcome.kind === "single") return outcome.kind === "go-on" && outcome.restricted ? { limited: true } : outcome.kind === "single" ? {} : { readAt: Date.now() };
  return { limited: true };
}

/** The turn record's own read and put on a transport, or null where it has none. */
export function turnPathOf(transport: PkarrTransport): TurnNetwork | null {
  if (!transport.turnRead || !transport.turnPut) return null;
  return { turnRead: transport.turnRead.bind(transport), turnPut: transport.turnPut.bind(transport), ...(transport.turnWarm ? { turnWarm: transport.turnWarm.bind(transport) } : {}) };
}
