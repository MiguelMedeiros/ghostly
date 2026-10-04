import { HANDOFF_OFFER, HANDOFF_PAKE, turnKeys, type DeviceFrame, type TurnRelease } from "@ghostly/core";
import { viewOf, type DeviceGateView } from "./gate";
import { HandoffGiver, HandoffTaker, STOPPED_STEP, type HandoffLinks, type HandoffRecords } from "./handoff";
import { handoffProfileHost, handoffSelf, type HandoffProfileHost } from "./handoffHost";
import type { DeviceHandoffHandler, DeviceLinks } from "./links";
import { deviceIdentity } from "./setup";
import { copyDeviceSigningKey } from "./signingKey";
import type { DevicePatch, DeviceRecord } from "./state";
import { amendDevice, forgetDevice, installDeviceRecord, moveDevice, readDeviceRecord } from "./store";
import { DB_VERSION } from "../shared/idb";
import { dropBreezDatabase } from "../engine/paymentAdapters/providers/breezDatabases";

/*
 * The handoff in device-link-only mode (WISP 06 § The gate, § The handoff): on a device that is not the active one,
 * one giver and one taker, made from the device record.
 *
 * - The giver: a `releasing` device going on with pass 2 after its reload into the gate, with the profile's database
 *   opened read only. If the stored database is not this build's (the app was updated between quiesce and the reload),
 *   the handoff is cancelled and the device is the active one again. A `standby` that released keeps answering a taker
 *   that asks for the release again.
 * - The taker: a standby's "Use here" and the offers of a push; a pull in progress after a reload; a `taking` device's
 *   install and take.
 *
 * Frames go to whichever of the two is in a handoff with the device that sent them.
 */

export interface StandbyHandoffOptions {
  profile: string;
  links: DeviceLinks;
  /** What the standby screen shows; a view with `reload` makes the pages start again into the gate. */
  show(view: DeviceGateView): void;
  /** The turn record's take, for a `taking` device (the device links' keeper, which steps back through `undoStaging`). */
  take(release: TurnRelease, turn: number): Promise<import("./turn").TurnOutcome | null>;
  host?: HandoffProfileHost | null;
}

/** A request, what a taker holds, confirmations: a giver's frames, whoever else is in a handoff with that device. */
const GIVER_FRAMES = new Set<string>(["handoff-request", "handoff-have", "handoff-ack", "handoff-verified", "handoff-done"]);

/** The device record of this profile, through the store. */
export function profileRecords(profile: string): HandoffRecords {
  return { read: () => readDeviceRecord(profile), amend: (patch: DevicePatch) => amendDevice(profile, patch), move: (to, patch) => moveDevice(profile, to, patch) };
}

export function handoffLinks(links: DeviceLinks): HandoffLinks {
  return { live: (key) => links.handoffLive(key), send: (key, frame) => links.send(key, frame), transcript: (key) => links.transcript(key), wake: (key) => links.wake(key) };
}

/**
 * What a taker that lost its settle read does before the keeper writes `standby` under the staged name: the record
 * under the old name goes back to `standby`, and the registry pointer back to the old namespace.
 */
export async function undoStagingOf(profile: string, host: HandoffProfileHost | null = handoffProfileHost()): Promise<void> {
  const record = await readDeviceRecord(profile);
  if (!host || !record) return;
  await HandoffTaker.stepBack({ staging: host.staging, standbyUnder: (database) => standbyUnder(database) }, record);
}

async function standbyUnder(database: string): Promise<void> {
  const record = await readDeviceRecord(database);
  if (record?.state === "taking") await moveDevice(database, "standby", { handoff: undefined, settle: undefined });
}

/**
 * A `releasing` device whose pass 2 cannot run: it never signed a release, so it writes `active` and starts again as
 * the active device (WISP 06 § Installing the staged state, the crash row "releasing").
 */
export async function activeAgainIfReleasing(profile: string, show: (view: DeviceGateView) => void): Promise<boolean> {
  const record = await readDeviceRecord(profile).catch(() => null);
  if (record?.state !== "releasing") return false;
  await moveDevice(profile, "active", { handoff: undefined });
  show({ state: "releasing", reload: true });
  return true;
}

/**
 * The Breez databases of wallets that moved away (WISP 06 § Wallets), each deleted whole (`dropBreezDatabase`: every
 * database the SDK keeps under the name, `<name>/<network>/<identity>` and its `-tree` beside it, and the old bare
 * names) with its note in the device's Breez register. Only a delete that succeeded counts: blocked (a page still has
 * it open) or failed, it rejects, the record keeps the names and it is tried again. A name that is not a Breez
 * database name is skipped.
 */
export async function dropBreezDatabases(names: readonly string[]): Promise<void> {
  for (const name of names) await dropBreezDatabase(name, { strict: true });
}

/** The handoff of a device that is not the active one, or null where the app registered no profile host. */
export async function standbyHandoff(options: StandbyHandoffOptions): Promise<DeviceHandoffHandler | null> {
  const host = options.host === undefined ? handoffProfileHost() : options.host;
  if (!host) return null;
  const identity = await deviceIdentity(options.profile).catch(() => null);
  if (!identity) return null;
  const record = identity.record;
  const links = handoffLinks(options.links);
  const records = profileRecords(options.profile);
  const common = {
    ownKey: identity.key.publicKey, sign: async (bytes: Uint8Array) => identity.key.sign(bytes), turnAddress: turnKeys(identity.d).address,
    links, records, self: () => handoffSelf(host),
  };
  const reload = () => options.show({ state: "standby", reload: true });
  // The standby screen follows the record: a device that released is on standby now, not moving.
  let shown = record.state;
  const follow = () => void readDeviceRecord(options.profile).then((now) => { if (now && now.state !== shown) { shown = now.state; options.show(viewOf(now)); } }).catch(() => {});
  const giver = new HandoffGiver({
    ...common,
    onChange: follow,
    source: host.source(options.profile),
    verifier: async () => null,
    busy: async () => null,
    dropDatabases: (names) => dropBreezDatabases(names),
    backToActive: async (stopped) => {
      // It never signed a release: it is the active device again, and starts as one. A pass 2 that stopped leaves a
      // note, so the screen says why after the reload (`HandoffGiver.resume`).
      const now = await readDeviceRecord(options.profile);
      const note = stopped ? { role: "releasing" as const, step: `${STOPPED_STEP}${stopped.failure}`, peer: stopped.peer, at: Date.now() } : undefined;
      if (now?.state === "releasing") await moveDevice(options.profile, "active", { handoff: note });
      options.show({ state: "releasing", reload: true });
    },
  });
  const taker = new HandoffTaker({
    ...common,
    staging: host.staging,
    reload,
    take: (release, turn) => options.take(release, turn),
    install: async (staged, patch) => {
      await copyDeviceSigningKey(options.profile, staged);
      await installDeviceRecord(options.profile, staged, patch);
    },
    standbyUnder,
    forget: (database) => forgetDevice(database),
  });

  // Pass 2 reads a database this build wrote: one an update migrated meanwhile is not opened for it.
  if (record.state === "releasing") {
    const stored = await host.storedVersion(options.profile).catch(() => null);
    if (stored !== DB_VERSION) { await moveDevice(options.profile, "active", { handoff: undefined }); options.show({ state: "releasing", reload: true }); return null; }
  }
  // `releasing` with no handoff of its own to go on with: active again.
  if (record.state === "releasing" && record.handoff?.role !== "releasing") { await activeAgainIfReleasing(options.profile, options.show); return null; }
  if (record.handoff?.role === "releasing" || record.breezDatabases?.length) await giver.resume();
  if (record.handoff?.role === "taking") await taker.resume();

  /** Which side a frame from `from` is for: the one in a handoff with that device. */
  const route = (from: string, frame: DeviceFrame): HandoffGiver | HandoffTaker => {
    const giving = giver.view()?.key === from && giver.view()?.step !== "failed";
    const takerView = taker.view();
    const taking = takerView?.key === from && takerView.step !== "failed";
    // A giver that released to that device and a taker in a new handoff with it (the release's `handoff-done` was
    // lost): the taker's frames go to the taker.
    if (giving && !(taking && !GIVER_FRAMES.has(frame.t))) return giver;
    if (takerView?.key === from) return taker;
    // A request, a password proof's first or third message, what a taker holds, confirmations: a giver's frames.
    if (GIVER_FRAMES.has(frame.t)) return giver;
    if (frame.t === HANDOFF_PAKE && frame.n !== 2) return giver;
    return taker;
  };

  return {
    receive: (from, frame) => {
      // An offer is always the taker's. A giver that released to the device offering it hears it too: that device
      // holds the turn, which is what the `handoff-done` it never got would have said.
      if (frame.t === HANDOFF_OFFER) { void giver.receive(from, frame); void taker.receive(from, frame); return; }
      void route(from, frame).receive(from, frame);
    },
    linkChanged: (key, live) => { giver.linkChanged(key, live); taker.linkChanged(key, live); },
    call: (method, params) => {
      const p = (params ?? {}) as { password?: unknown; later?: unknown };
      const later = typeof p.later === "number" && p.later >= 0 ? p.later : 0;
      switch (method) {
        case "deviceHandoffPull":
          if (typeof p.password !== "string" || !p.password) return Promise.reject(new Error("handoff-password: Type the profile's password."));
          // A replaced device hands over from the turn its mark holds: read the turn first, so the mark is the newest
          // the network has (the active device may have moved on since the last read), and the release matches it.
          return (async () => {
            const now = await readDeviceRecord(options.profile).catch(() => null);
            if (now?.state === "superseded") await options.links.checkTurn(false).catch(() => null);
            return taker.pull(p.password as string, later);
          })();
        case "deviceHandoffAccept": return taker.accept(later);
        case "deviceHandoffCancel": return Promise.all([taker.cancel(), giver.cancel()]).then(() => null);
        case "deviceHandoffView": return Promise.resolve(taker.view() ?? giver.view());
        default: return undefined;
      }
    },
    stop: () => { giver.stop(); taker.stop(); },
  };
}

export type { DeviceRecord };
