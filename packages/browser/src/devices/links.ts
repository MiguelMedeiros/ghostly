import {
  DEVICES_CAPABILITY, HANDOFF_CAPABILITY, GhostLink, RTC_CONFIG, SET_ACK, SET_UPDATE, checkPushEndpoint, vapidKeysMatch, createIdentity, deviceEchoFrame, deviceEchoNonce, deviceLinkPairing, devicePingFrame,
  fromBase64Url, setAckFrame, type DeviceFrame, type NativeEndpoint, type NativeTransport, type PairedTransport, type PkarrTransport, type PollIntervals, type PushRequest, type TurnNetwork,
  type WakeTarget,
} from "@ghostly/core";
import { DEVICE_RENEW_FRAME, DEVICE_TOKENS_FRAME, DEVICE_WAKE_FRAME, DeviceWaker, deviceWakeFrame, otherTarget, ownTargetFor, postPush, pushForSet, readDeviceTokens, readDeviceWake, withAllowed, withOtherPush, withOwnPush, withRenew } from "./push";
import type { WakeSubscription } from "../shared/types";
import { enrollmentUnfinished, finishEnrollment } from "./enroll";
import { viewOf } from "./gate";
import { DEVICE_GATED_ERROR, type DeviceLinkEngine, type DeviceLinkHost } from "./linkOnly";
import { DeviceSetError, deviceIdentity, openTurnKeeper } from "./setup";
import { loadDeviceSigningKey, type DeviceSigningKey } from "./signingKey";
import type { DevicePatch, DeviceRecord, DeviceState } from "./state";
import { amendDevice, forgetDevice, moveDevice, readDeviceRecord } from "./store";
import { acknowledged, pendingFrames } from "./remove";
import { checkSetUpdate } from "./setUpdate";
import type { TurnKeeper, TurnOutcome } from "./turn";
import { TakeoverRefusal, canTakeOver, forceTakeover, takeoverTarget } from "./takeover";
import { canStartOwnSet, resumeOwnSet, startOwnSet, supersedeOwnTombstone, type OwnSetOutcome, type OwnSetPorts } from "./ownSet";
import { peekTurn } from "./restoreGuard";
import { newDeviceSecretDue } from "./rotate";
import { provesHandoffPassword } from "./handoffPake";

/**
 * What runs the handoff on this device (WISP 06 § The handoff): the giver while the engine runs, the giver and the
 * taker in device-link-only mode (`handoffStandby.ts`). It gets every `handoff-` frame and every change of a link
 * that carries `handoff/1`, and answers the pages' `deviceHandoff…` calls.
 */
export interface DeviceHandoffHandler {
  receive(from: string, frame: DeviceFrame): void;
  linkChanged(key: string, live: boolean): void;
  /** A page's call, or undefined when the method is not this handler's. */
  call?(method: string, params: unknown): Promise<unknown> | undefined;
  stop(): void;
}

/*
 * The device links of one profile on this device (WISP 06 § Terms, § The gate): one paired session to each other
 * device of the set, on keys derived from the device-set secret `D` and the two device signing keys, each pinned to
 * the other device's signing key, with trust on first use off. They run over the transports a chat uses, and they
 * are what device-link-only mode runs in place of the engine: everything here comes from the device record and the
 * device signing key, so a standby holds its links without opening the profile's database.
 *
 * In this part a link carries a ping and its echo, and hands every other device frame to `onFrame`: enrollment, the
 * handoff and `set-update` (later parts) plug in there and send through `send`.
 *
 * Which links a device holds follows from its record alone, and is brought in line by `refresh()`:
 * - under the current `D`, one to every other device the set lists;
 * - under the `D` of an earlier set, one to each staying device that has not acknowledged the move yet (the list
 *   kept for it), so the new secret can reach it over the old link;
 * - none for a `removed` device, and none for a `single` profile: no record, no key read, nothing asked of a relay.
 * A link whose `D` or device is no longer in the record is closed. So a device that no longer holds the current `D`
 * derives none of the links the others hold, and loses the ones it had as soon as they move.
 *
 * A standby's network settings (its relays, its ICE servers) are the app's defaults: the person's own are in the
 * profile's database, which a standby does not open.
 */

/** One link, as a page may be told: names and states, never a key's secret or `D`. */
export interface DeviceLinkView {
  /** The other device's signing key (public), base64url. */
  key: string;
  name: string;
  /** Its slot in the device set; absent for a link kept under an earlier set's secret. */
  slot?: number;
  /** A link under an earlier device set's secret, kept to hand that device the new one. */
  earlier?: boolean;
  /** `live`: the session is open and both ends announced `devices/1`. */
  status: "connecting" | "live";
  transport?: PairedTransport;
}

/** The device set as a page shows it (Profile, Devices; the standby screen): names and states, never a secret. */
export interface DeviceSetView {
  state: DeviceState;
  devices: { key: string; name: string; slot: number; self: boolean; active: boolean; status?: DeviceLinkView["status"] }[];
  /**
   * Devices this one granted the set to whose enrollment never came back: they hold `D` and are in no record. Shown
   * as "Not finished"; moving the set to a new `D` (removal, a later part) is what takes `D` from them.
   */
  unfinishedGrants?: { key: string; name: string; at: number }[];
  /** This device's enrollment did not finish (WISP 06 § Adding a device, "Not finished"). */
  unfinished?: true;
  /**
   * The set should move to a new device-set secret (`rotate.ts`): a device granted it never finished, and may hold it.
   * The active device makes the move by itself; this says it is due.
   */
  newSecretDue?: true;
  /** "New device secret" is offered: this device took over from `device`, which still holds the old secret. `lost`: the person said it was lost or stolen. */
  secretOffer?: { device?: string; lost?: true };
  /** Devices that stay and have not taken the new secret yet: they get it the next time they open Ghostly. */
  waiting?: { key: string; name: string }[];
  /** Another tombstone stands where this device put its own: a device that was left behind started a set of its own, or something else closed it. */
  foreignSet?: true;
  /** After an accepted `set-update`, once: the new device list, until the person answers. */
  notice?: string[];
  /** Nothing this device can accept brings it back into the set: it is added again by enrollment. */
  reenroll?: true;
}

/** The view of a device record and the links this device holds. A profile with no record is `single`, with no devices. */
export function deviceSetView(record: DeviceRecord | null, links: DeviceLinkView[]): DeviceSetView {
  if (!record) return { state: "single", devices: [] };
  const devices = record.deviceSet.flatMap((slot, index) => {
    if (!slot) return [];
    const link = links.find((l) => l.key === slot.key && !l.earlier);
    return [{ key: slot.key, name: slot.name, slot: index, self: index === record.ownSlot, active: index === record.activeSlot, ...(link ? { status: link.status } : {}) }];
  });
  const listed = new Set(record.deviceSet.flatMap((slot) => (slot ? [slot.key] : [])));
  const grants = (record.unfinishedGrants ?? []).filter((grant) => !listed.has(grant.key));
  const due = newDeviceSecretDue(record);
  const waiting = pendingFrames(record).flatMap(({ key }, i, all) => {
    const slot = record.deviceSet.find((s) => s?.key === key);
    return slot && all.findIndex((other) => other.key === key) === i ? [{ key, name: slot.name }] : [];
  });
  return { state: record.state, devices, ...(grants.length ? { unfinishedGrants: grants } : {}), ...(enrollmentUnfinished(record) ? { unfinished: true as const } : {}),
    ...(due?.why === "unfinished-grant" ? { newSecretDue: true as const } : {}),
    ...(record.state === "active" && record.secretOffer ? { secretOffer: { ...(record.secretOffer.device ? { device: record.secretOffer.device } : {}), ...(record.secretOffer.lost ? { lost: true as const } : {}) } } : {}),
    ...(record.state === "active" && waiting.length ? { waiting } : {}),
    ...(record.state === "active" && record.earlierSets.some((set) => set.foreign) ? { foreignSet: true as const } : {}),
    ...(record.setNotice && !record.setNotice.seen ? { notice: record.setNotice.names } : {}),
    ...(record.reenroll ? { reenroll: true as const } : {}) };
}

export interface DeviceLinksOptions {
  /** The profile's peer database name: the key of its device record. */
  profile: string;
  /** How to reach Pkarr: where the links' rendezvous records are published and read. */
  transport: PkarrTransport;
  /** Absent where the page has no WebRTC; the links then run on the native transports alone. */
  createPeerConnection?: () => RTCPeerConnection;
  /** The native transports this app runs, as the engine is given them (`NodeOptions.nativeTransports`). */
  nativeTransports?: Partial<Record<NativeTransport, (seedB64: string) => Promise<NativeEndpoint>>>;
  pollIntervals?: PollIntervals;
  /** The person turned the network off: no link is started and nothing is asked of a relay or the DHT. */
  offline?: boolean;
  /** Every device frame that is not the link's own ping or echo, with the signing key (base64url) of the device that sent it. */
  onFrame?: (from: string, frame: DeviceFrame) => void | Promise<void>;
  /** The links changed (one opened, closed, or the set changed). */
  onChange?: (links: DeviceLinkView[]) => void;
  /** The turn record's sources, for `turnKeeper()`. Default: the transport's own, where it has them. */
  turn?: TurnNetwork;
  /** A taker that lost its settle read steps back (`TurnKeeperOptions.undoStaging`). */
  undoStaging?: () => Promise<void>;
  /** Makes who runs the handoff here (device-link-only mode), once the links started. */
  handoff?: (links: DeviceLinks, host: DeviceLinkHost | null) => Promise<DeviceHandoffHandler | null>;
  /**
   * A standby reads the turn record when its screen opens and every 10 minutes while it shows (WISP 06 § When a device
   * checks), and tells the pages when its state changed (a tombstone makes it `moving` or `removed`). Device-link-only mode.
   */
  watchTurn?: boolean;
  /**
   * Another device shared its push target (`push.ts`), or said it has none: kept in the record here; the active device
   * also brings the profile's target in line (`profileWakeAfter`), which is the engine's, in the profile's database.
   */
  onDeviceWake?: (from: string, target: WakeTarget | null) => void | Promise<void>;
  /**
   * The active device got another device's hint that it holds the turn (WISP 06 § When a device checks: "at once on a
   * hint"). The engine reads the turn itself, so that a read saying another device took over stops it.
   */
  onActiveHint?: () => void;
  /** How a wake-up is posted where a page may not post it itself (Desktop's command). Default: `fetch`, then the push relay. */
  pushSend?: (request: PushRequest) => Promise<number>;
  /** Tests give their own. */
  readRecord?: (profile: string) => Promise<DeviceRecord | null>;
  loadKey?: (profile: string) => Promise<DeviceSigningKey | null>;
}

interface Running {
  id: string;
  /** The device-set secret the link is derived from, base64url: an earlier set's, or the current one. */
  d: string;
  key: string;
  name: string;
  slot?: number;
  earlier: boolean;
  link: GhostLink;
  /** The devices capability is agreed on the open session. */
  agreed: boolean;
  /** `handoff/1` is agreed on the open session. */
  handoff?: boolean;
  /** The transport the open session runs on. */
  transport?: PairedTransport;
  native: boolean;
  waiting: Map<string, { resolve(ms: number): void; reject(error: Error): void; sentAt: number; timer: ReturnType<typeof setTimeout> }>;
}

interface Wanted { id: string; d: Uint8Array; key: string; name: string; slot?: number; earlier: boolean }

/** How often a standby reads the turn while its screen shows (WISP 06 § When a device checks), and the jitter on it. */
export const STANDBY_TURN_EVERY_MS = 10 * 60_000;
const STANDBY_TURN_JITTER_MS = 60_000;
/** How long a device that took a new secret waits after its `set-ack` before it closes the old link the ack went out on. */
export const SET_ACK_FLUSH_MS = 1_500;
/**
 * The active device's hint on each device link that opens: "I hold the turn" (WISP 06 § When a device checks, a link
 * that says "I took the turn"). A hint is never authority: the device that gets it reads the turn record, at most once
 * in this long. So a standby learns of a handoff or a takeover while the record is still there to read, before a
 * removal's tombstone hides it.
 */
export const DEVICE_TURN_HINT = "device-turn";
export const TURN_HINT_EVERY_MS = 30_000;

const defaultPeerConnection = (): (() => RTCPeerConnection) | undefined =>
  (typeof RTCPeerConnection === "undefined" ? undefined : () => new RTCPeerConnection({ iceServers: RTC_CONFIG.iceServers }));

export class DeviceLinks implements DeviceLinkEngine {
  private readonly running = new Map<string, Running>();
  private readonly createPeerConnection?: () => RTCPeerConnection;
  private key: DeviceSigningKey | null = null;
  private keeper: Promise<TurnKeeper | null> | null = null;
  private stopped = false;
  /** The record's push targets were checked against the set once since start (`pushForSet`). */
  private pushPruned = false;
  /** Why this device holds no links although it has a device set (a record that cannot carry one, a missing key). */
  problem: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** Turn reads and new secrets one after the other: a read made under the old secret must not undo a secret just taken. */
  private turnQueue: Promise<unknown> = Promise.resolve();
  private turnTimer: ReturnType<typeof setTimeout> | null = null;
  private lastHintRead = 0;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly options: DeviceLinksOptions) {
    this.createPeerConnection = "createPeerConnection" in options ? options.createPeerConnection : defaultPeerConnection();
  }

  /** `host` is the device-link-only server's: it is told when what the standby screen shows changes. */
  async start(host?: DeviceLinkHost): Promise<void> {
    this.host = host ?? null;
    await this.refresh();
    if (this.options.handoff) {
      try { const handler = await this.options.handoff(this, this.host); if (handler && !this.stopped) this.setHandoff(handler); else handler?.stop(); }
      catch { /* no handoff here: the links still run */ }
    }
    // An enrollment that a crash or a slow network left before its last step: it finishes now if it can.
    void this.finishEnrollment().catch(() => {});
    // A device set of its own that was settling when the app stopped (`ownSet.ts`): it settles now.
    if ((await this.record().catch(() => null))?.ownSet) this.settleOwnSet();
    if (this.options.watchTurn) this.watchTurn(0);
  }

  /**
   * A standby's own reads of the turn: now, then every 10 minutes (with jitter) while it runs. A read that changes the
   * device's state (a tombstone: `moving` or `removed`; a record that names another active device) tells the pages.
   */
  private watchTurn(after: number): void {
    if (this.stopped) return;
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = setTimeout(() => {
      this.turnTimer = null;
      void this.checkAndShow().catch(() => null).finally(() => this.watchTurn(STANDBY_TURN_EVERY_MS + Math.floor(Math.random() * STANDBY_TURN_JITTER_MS)));
    }, after);
  }

  /** Reads the turn and, when the device's state or the device it believes changed, tells the pages. */
  private async checkAndShow(): Promise<TurnOutcome | null> {
    const before = await this.record().catch(() => null);
    const outcome = await this.checkTurn();
    const now = await this.record().catch(() => null);
    if (now && before && (now.state !== before.state || now.activeSlot !== before.activeSlot || now.d !== before.d || now.reenroll !== before.reenroll)) this.host?.show(viewOf(now));
    return outcome;
  }

  /** The frames still pending go again on every old link that is live now (the hourly run: a refusal for a passing reason is retried). */
  async deliverPending(): Promise<void> {
    for (const running of [...this.running.values()]) if (running.earlier && this.isLive(running)) await this.linkLive(running).catch(() => {});
  }

  private record(): Promise<DeviceRecord | null> {
    return (this.options.readRecord ?? readDeviceRecord)(this.options.profile);
  }

  private later(ms: number, run: () => void): void {
    const timer = setTimeout(() => { this.timers.delete(timer); if (!this.stopped) run(); }, ms);
    this.timers.add(timer);
  }

  private turnExclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.turnQueue.catch(() => {}).then(work);
    this.turnQueue = run;
    return run;
  }
  private host: DeviceLinkHost | null = null;

  /**
   * The last step of this device's enrollment (`enroll.ts`), when it is not done: reads the turn record until it lists
   * this device, and then tells the pages. True once it is done (now or before).
   */
  async finishEnrollment(): Promise<boolean> {
    const record = await (this.options.readRecord ?? readDeviceRecord)(this.options.profile);
    if (!enrollmentUnfinished(record)) return true;
    const network = this.turnNetwork();
    if (!network || this.options.offline) return false;
    const finished = await finishEnrollment(this.options.profile, network, { stopped: () => this.stopped });
    if (finished) {
      const now = await (this.options.readRecord ?? readDeviceRecord)(this.options.profile);
      if (now) this.host?.show(viewOf(now));
      await this.refresh();
    }
    return finished;
  }

  /**
   * Reads the device record and brings the links in line with it: the ones it no longer names are closed, the ones it
   * names and this device does not hold yet are started. Called at start, and by whatever changes the record (a
   * device added, a new `D`, a state that holds no links).
   */
  refresh(): Promise<void> {
    const run = this.queue.catch(() => {}).then(() => this.reconcile());
    this.queue = run;
    return run;
  }

  private async reconcile(): Promise<void> {
    const wanted = this.stopped ? [] : await this.wanted();
    const keep = new Set(wanted.map((w) => w.id));
    const closing = [...this.running.values()].filter((r) => !keep.has(r.id));
    for (const gone of closing) this.running.delete(gone.id);
    await Promise.all(closing.map((gone) => this.close(gone)));
    for (const want of wanted) {
      const kept = this.running.get(want.id);
      if (!kept) { if (!this.stopped) this.open(want); continue; }
      // The same derived link, now kept for another reason: the set moved to a new secret and this one became an
      // earlier set's, kept to hand that device the new one. Already live, it delivers now: no new session will come.
      const became = want.earlier && !kept.earlier;
      if (kept.earlier !== want.earlier && kept.handoff) { kept.handoff = false; this.handoffLink(kept.key, false); }
      kept.earlier = want.earlier; kept.slot = want.slot; kept.name = want.name;
      if (became && this.isLive(kept)) void this.linkLive(kept).catch(() => {});
    }
    if (closing.length || wanted.length) this.changed();
    // A device the set no longer lists (removed) takes its push target and its token with it. Also once at start: a
    // device removed while this one was closed had no link open here to close.
    if (!this.stopped && (closing.length || !this.pushPruned)) {
      this.pushPruned = true;
      await this.pushExclusive(async () => {
        const record = await this.record();
        const patch = record && pushForSet(record);
        if (patch) await amendDevice(this.options.profile, patch);
      }).catch(() => {});
    }
  }

  /** The links the record asks for. Empty for a `single` profile, which is not even asked for its key. */
  private async wanted(): Promise<Wanted[]> {
    if (this.options.offline) return [];
    const record = await (this.options.readRecord ?? readDeviceRecord)(this.options.profile);
    this.problem = null;
    if (!record) { this.key = null; this.keeper = null; return []; }
    if (record.state === "removed") return [];
    let identity;
    try { identity = await deviceIdentity(this.options.profile, { record, loadKey: this.options.loadKey ?? loadDeviceSigningKey }); }
    catch (error) {
      if (!(error instanceof DeviceSetError)) throw error;
      this.problem = error.message;
      return [];
    }
    if (!identity) return [];
    this.key = identity.key;
    const own = record.deviceSet[identity.ownSlot]!.key;
    const wanted: Wanted[] = [];
    record.deviceSet.forEach((slot, index) => {
      if (slot && index !== identity.ownSlot && slot.key !== own) wanted.push({ id: `${record.d}|${slot.key}`, d: identity.d, key: slot.key, name: slot.name, slot: index, earlier: false });
    });
    // An earlier set's secret reaches the devices that stay over the links of that set, until each acknowledged it.
    for (const earlier of record.earlierSets) {
      for (const key of earlier.pending) {
        if (key === own || earlier.d === record.d) continue;
        // Only a device that stays: a key the current set no longer lists gets no link, whatever the list says.
        const staying = record.deviceSet.find((slot) => slot?.key === key);
        if (!staying) continue;
        // One link per old secret and device: two sets that both wait for it share none.
        if (!wanted.some((w) => w.id === `${earlier.d}|${key}`)) wanted.push({ id: `${earlier.d}|${key}`, d: fromBase64Url(earlier.d), key, name: staying.name, earlier: true });
      }
    }
    return wanted;
  }

  private open(want: Wanted): void {
    const signer = this.key!;
    const rtc = !!this.createPeerConnection;
    const running: Running = { id: want.id, d: want.id.slice(0, want.id.indexOf("|")), key: want.key, name: want.name, slot: want.slot, earlier: want.earlier, link: null as unknown as GhostLink, agreed: false, native: false, waiting: new Map() };
    running.link = new GhostLink({
      ...deviceLinkPairing(want.d, signer, fromBase64Url(want.key)),
      deviceCapabilities: [DEVICES_CAPABILITY, HANDOFF_CAPABILITY],
      rtcAvailable: rtc,
      // As a group's link does where one side has no WebRTC: each side says in its own packet what it runs and how
      // to dial it, since a device link has no capability record.
      native: { automatic: true },
      packetTransports: true,
      transport: this.options.transport,
      pollIntervals: this.options.pollIntervals,
      autoConnect: true,
      createPeerConnection: () => {
        if (!this.createPeerConnection) throw new ReferenceError("RTCPeerConnection is not defined");
        return this.createPeerConnection();
      },
      localFetch: async () => { throw new Error("A device link serves no local web app"); },
      getServices: () => [{ id: "chat", type: "chat" }],
      getHostedHttpService: () => undefined,
      events: {
        onPairingState: (state) => { running.transport = state.status === "ready" ? state.transport : undefined; },
        onDeviceCapabilities: (agreed) => {
          const was = running.agreed;
          running.agreed = agreed.includes(DEVICES_CAPABILITY);
          if (running.agreed && !was && this.running.get(running.id) === running) void this.linkLive(running).catch(() => {});
          const handoff = agreed.includes(HANDOFF_CAPABILITY);
          if (handoff !== running.handoff) { running.handoff = handoff; if (!running.earlier) this.handoffLink(running.key, handoff); }
          this.changed();
        },
        onDataLinkState: (state) => {
          if (state !== "open") {
            running.agreed = false; this.failPings(running, "The device link closed");
            if (running.handoff) { running.handoff = false; if (!running.earlier) this.handoffLink(running.key, false); }
          }
          this.changed();
        },
        onDeviceFrame: (frame) => this.receive(running, frame),
        // The other device has no WebRTC: this one starts its native endpoints for it.
        onPacketTransports: (transports) => { if (!transports.includes("webrtc/1")) void this.startNative(running); },
      },
    });
    this.running.set(want.id, running);
    running.link.start();
    if (!rtc) void this.startNative(running);
  }

  /** The native endpoints of a link, each on a seed made for this run: its address goes out in the link's own packet. */
  private async startNative(running: Running): Promise<void> {
    if (running.native) return;
    running.native = true;
    for (const [transport, factory] of Object.entries(this.options.nativeTransports ?? {})) {
      if (!factory || running.link.availableTransports.includes(transport as NativeTransport)) continue;
      try {
        const endpoint = await factory(createIdentity().seedB64);
        if (this.stopped || this.running.get(running.id) !== running) { await endpoint.close(); return; }
        running.link.registerEndpoint(endpoint);
      } catch { /* this transport is not available now; the others, and WebRTC, still are */ }
    }
  }

  private async receive(running: Running, frame: DeviceFrame): Promise<void> {
    const echo = deviceEchoFrame(frame);
    if (echo) { try { running.link.sendDeviceFrame(echo); } catch { /* the link closed under it */ } return; }
    const nonce = deviceEchoNonce(frame);
    if (nonce) {
      const waiter = running.waiting.get(nonce);
      if (waiter) { running.waiting.delete(nonce); clearTimeout(waiter.timer); waiter.resolve(Date.now() - waiter.sentAt); }
      return;
    }
    // A link kept under an earlier set's secret carries the new secret, never a handoff.
    if (frame.t.startsWith("handoff-")) { if (!running.earlier) this.handoff?.receive(running.key, frame); return; }
    if (frame.t === SET_UPDATE) { await this.setUpdate(running, frame); return; }
    if (frame.t === SET_ACK) { if (running.earlier) await this.acked(running.key, running.d); return; }
    if (frame.t === DEVICE_TURN_HINT) { if (!running.earlier) await this.hinted(); return; }
    if (frame.t === DEVICE_WAKE_FRAME) { if (!running.earlier) await this.deviceWake(running.key, frame); return; }
    if (frame.t === DEVICE_RENEW_FRAME || frame.t === DEVICE_TOKENS_FRAME) { if (!running.earlier) await this.fromActive(running.key, frame); return; }
    await this.options.onFrame?.(running.key, frame);
  }

  /**
   * What the active device asks of the device whose subscription it hands out (`push.ts`): a new subscription
   * (`device-renew`), or the chats' tokens its push worker may show (`device-tokens`). Taken only from the device the
   * record names active, and never by the active device itself.
   */
  private async fromActive(from: string, frame: DeviceFrame): Promise<void> {
    await this.pushExclusive(async () => {
      const record = await this.record();
      if (!record || record.state === "active" || record.activeSlot === undefined || record.deviceSet[record.activeSlot]?.key !== from) return;
      let patch: DevicePatch | null = null;
      if (frame.t === DEVICE_RENEW_FRAME) patch = withRenew(record);
      else { const tokens = readDeviceTokens(frame); if (tokens) patch = withAllowed(record, tokens); }
      if (patch) await amendDevice(this.options.profile, patch);
    });
  }

  /** Asks the device with this signing key to make a new subscription. False when its link is not live (ask again later). */
  askRenew(key: string): boolean {
    const running = this.find(key);
    if (!running || running.earlier || !this.isLive(running)) return false;
    try { running.link.sendDeviceFrame({ t: DEVICE_RENEW_FRAME }); return true; } catch { return false; }
  }

  /** Tells the device with this signing key which chats' tokens are handed out under the profile's subscription. */
  sendTokens(key: string, tokens: string[]): boolean {
    const running = this.find(key);
    if (!running || running.earlier || !this.isLive(running)) return false;
    try { running.link.sendDeviceFrame({ t: DEVICE_TOKENS_FRAME, k: tokens }); return true; } catch { return false; }
  }

  // ---------- push between the devices (WISP 06 § Push and the phone, `push.ts`) ----------

  private pushQueue: Promise<unknown> = Promise.resolve();
  /** The record's push fields are changed one at a time: two frames at once must not write over each other. */
  private pushExclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.pushQueue.catch(() => {}).then(work);
    this.pushQueue = run;
    return run;
  }

  /** Another device shared its push target, or said it has none: kept here, and the engine told. A malformed frame says nothing. */
  private async deviceWake(from: string, frame: DeviceFrame): Promise<void> {
    const target = readDeviceWake(frame);
    if (target === undefined) return;
    await this.pushExclusive(async () => {
      const record = await this.record();
      if (!record || !record.deviceSet.some((slot) => slot?.key === from)) return;
      const patch = withOtherPush(record, from, target);
      if (patch) await amendDevice(this.options.profile, patch);
    });
    try { await this.options.onDeviceWake?.(from, target); } catch { /* the engine's own trouble */ }
  }

  /** Tells the device on this link how to wake this one (or that it cannot), under the token made for it. */
  private async shareOwnPush(running: Running): Promise<void> {
    const target = await this.pushExclusive(async () => {
      const record = await this.record();
      if (!record) return undefined;
      const { target, patch } = ownTargetFor(record, running.key);
      if (patch) await amendDevice(this.options.profile, patch);
      return target;
    });
    if (target === undefined) return;
    try { running.link.sendDeviceFrame(deviceWakeFrame(target)); } catch { /* said again on the next session */ }
  }

  /**
   * This device's own push subscription for the profile (null: none any more): kept in the record, and told to every
   * device whose link is live now (the others hear it on their next session). The VAPID pair stays the one the record
   * holds when `subscription` gives only the browser's part (a standby whose browser replaced its subscription).
   */
  async setOwnPush(subscription: (Pick<WakeSubscription, "endpoint" | "p256dh" | "auth"> & { vapid?: WakeSubscription["vapid"] }) | null): Promise<void> {
    const changed = await this.pushExclusive(async () => {
      const record = await this.record();
      if (!record) return false;
      const vapid = subscription?.vapid ?? (record.push?.own ? { publicKey: record.push.own.vp, privateKey: record.push.own.vk } : undefined);
      if (subscription && !vapid) throw new Error("This device has no push key pair to go with that subscription");
      const patch = withOwnPush(record, subscription && { ...subscription, vapid: vapid! });
      if (patch) await amendDevice(this.options.profile, patch);
      return !!patch;
    });
    if (!changed) return;
    for (const running of [...this.running.values()]) if (!running.earlier && this.isLive(running)) await this.shareOwnPush(running).catch(() => {});
  }

  private waker: DeviceWaker | null = null;

  /**
   * Wakes the device with this signing key for a handoff (WISP 06 § Push and the phone): a push to the subscription it
   * shared, only when its link is down. `sent` when the push service took it; `none` when there is nothing to wake it
   * with (no target, or its link is live already); a subscription that is gone is forgotten.
   */
  async wake(key: string): Promise<"sent" | "none" | "skipped" | "failed"> {
    if (this.options.offline || this.live(key)) return "none";
    const record = await this.record().catch(() => null);
    const target = otherTarget(record, key);
    if (!target) return "none";
    this.waker ??= new DeviceWaker(async (request) => postPush(request, { pushSend: this.options.pushSend, relay: (await this.record().catch(() => null))?.network?.pushRelay }));
    const outcome = await this.waker.wake(key, target);
    if (outcome === "gone") {
      await this.pushExclusive(async () => {
        const now = await this.record();
        const patch = now && otherTarget(now, key)?.endpoint === target.endpoint ? withOtherPush(now, key, null) : null;
        if (patch) await amendDevice(this.options.profile, patch);
      }).catch(() => {});
      return "none";
    }
    return outcome;
  }

  /**
   * A link is live (both ends announced `devices/1`). Under an earlier set's secret: the frame of that set goes to the
   * device, as at every session until it answers. Under the current secret: the device holds it (only a holder of this
   * `D` with its own signing key opens this link), which acknowledges every earlier set's frame for it.
   */
  private async linkLive(running: Running): Promise<void> {
    const record = await this.record();
    if (!record) return;
    if (running.earlier) {
      for (const pending of pendingFrames(record)) {
        if (pending.d !== running.d || pending.key !== running.key) continue;
        try { running.link.sendDeviceFrame(pending.frame); } catch { /* the link closed under it: the next session sends it */ }
      }
      return;
    }
    if (running.d !== record.d) return;
    // The active device says it holds the turn: the other device reads the record while it is still there to read.
    if (record.state === "active") { try { running.link.sendDeviceFrame({ t: DEVICE_TURN_HINT }); } catch { /* the next session says it */ } }
    // How to wake this device (or that it cannot be), on every session: the other device may have missed a change.
    await this.shareOwnPush(running).catch(() => {});
    await this.acked(running.key);
  }

  /**
   * A hint from another device that it holds the turn: read it, at most once in `TURN_HINT_EVERY_MS`. On the active
   * device the engine reads it (`onActiveHint`): it stops itself when another device took over.
   */
  private async hinted(): Promise<void> {
    if (Date.now() - this.lastHintRead < TURN_HINT_EVERY_MS) return;
    const record = await this.record();
    if (record?.state === "active") { this.lastHintRead = Date.now(); this.options.onActiveHint?.(); return; }
    if (!record || record.state === "removed") return;
    this.lastHintRead = Date.now();
    await this.checkAndShow().catch(() => null);
  }

  /** `key` holds the set under `d` (or the current one): its pending frame is done, and the old link goes. */
  private async acked(key: string, d?: string): Promise<void> {
    const patch = acknowledged(await this.record(), key, d);
    if (!patch) return;
    await amendDevice(this.options.profile, patch);
    await this.refresh();
    this.changed();
  }

  /**
   * A `set-update` (WISP 06 § Removing a device): accepted only under the rule of `setUpdate.ts`. Accepted, it is
   * written durably before `set-ack` goes back; the old links close a moment later (so the ack is not cut off) and the
   * new set's record is read. One that this device already took is just answered.
   */
  private setUpdate(running: Running, frame: DeviceFrame): Promise<void> {
    return this.turnExclusive(async () => {
      const record = await this.record();
      const check = checkSetUpdate(record, frame, Date.now());
      if (check.kind === "known") { try { running.link.sendDeviceFrame(setAckFrame()); } catch { /* it asks again */ } return; }
      if (check.kind === "refuse") {
        if (check.why === "removed" && record && (record.state === "standby" || record.state === "moving" || record.state === "superseded")) {
          await moveDevice(this.options.profile, "removed", {});
          await this.afterChange();
        } else if (check.reenroll && record?.state === "moving" && !record.reenroll) {
          await amendDevice(this.options.profile, { reenroll: true });
          await this.afterChange();
        }
        return;
      }
      // A replaced device has read the tombstone the frame carries: it is `moving` first, as the table says.
      if (check.from === "superseded") await moveDevice(this.options.profile, "moving", {});
      if (check.from === "standby") await amendDevice(this.options.profile, check.patch);
      else await moveDevice(this.options.profile, "standby", check.patch);
      try { running.link.sendDeviceFrame(setAckFrame()); } catch { /* the remover sends it again; the new link acknowledges it too */ }
      // It had started a set of its own: its tombstone, which lists only itself, gives way to one that lists the
      // remover's devices, so the others still waiting at the old address are not made `removed` (`ownSet.ts`).
      if (record?.ownSet && typeof frame.tomb === "string") {
        await amendDevice(this.options.profile, { ownSet: undefined }).catch(() => {});
        await this.ownSetPorts().then((ports) => supersedeOwnTombstone(ports, record, fromBase64Url(frame.tomb as string))).catch(() => false);
      }
      const now = await this.record();
      if (now) this.host?.show(viewOf(now));
      this.later(SET_ACK_FLUSH_MS, () => void this.refresh().then(() => this.restartHandoff()).then(() => this.checkTurn()).catch(() => {}));
    });
  }

  /** The handoff of this device made again: it signs and checks releases over the turn address, which moved with the secret. */
  private async restartHandoff(): Promise<void> {
    if (!this.options.handoff || this.stopped) return;
    try { const handler = await this.options.handoff(this, this.host); if (handler && !this.stopped) this.setHandoff(handler); else handler?.stop(); }
    catch { /* no handoff here: the links still run */ }
  }

  /** The record changed in a way the pages show, and the links follow it. */
  private async afterChange(): Promise<void> {
    const now = await this.record();
    if (now) this.host?.show(viewOf(now));
    await this.refresh();
  }

  private failPings(running: Running, why: string): void {
    for (const [nonce, waiter] of running.waiting) { running.waiting.delete(nonce); clearTimeout(waiter.timer); waiter.reject(new Error(why)); }
  }

  private async close(running: Running): Promise<void> {
    this.failPings(running, "The device link closed");
    running.agreed = false;
    await running.link.stop().catch(() => {});
  }

  private find(key: string): Running | undefined {
    // A device may be reached on two links while its set moves: the one under the current secret, and one kept under
    // an earlier secret until it took the new one. The live one is used, the current one first.
    const all = [...this.running.values()].filter((r) => r.key === key);
    return all.find((r) => !r.earlier && this.isLive(r)) ?? all.find((r) => this.isLive(r)) ?? all.find((r) => !r.earlier) ?? all[0];
  }

  private isLive(running: Running): boolean {
    return running.agreed && running.link.isDataLinkOpen && running.link.supportsDevice(DEVICES_CAPABILITY);
  }

  private handoff: DeviceHandoffHandler | null = null;

  /** Who runs the handoff here; it is told at once of the links that already carry it. */
  setHandoff(handler: DeviceHandoffHandler | null): void {
    this.handoff?.stop();
    this.handoff = handler;
    if (handler) for (const running of this.running.values()) if (running.handoff && !running.earlier) handler.linkChanged(running.key, true);
  }

  private handoffLink(key: string, live: boolean): void {
    try { this.handoff?.linkChanged(key, live); } catch { /* the handler's own trouble */ }
  }

  /** The link to that device carries `handoff/1` now. */
  handoffLive(key: string): boolean {
    const running = [...this.running.values()].find((r) => r.key === key && !r.earlier);
    return !!running && running.link.isDataLinkOpen && running.link.supportsDevice(HANDOFF_CAPABILITY);
  }

  /** The transcript hash of the session open with that device (WISP 401), lower-case hex. */
  transcript(key: string): string | undefined {
    const running = [...this.running.values()].find((r) => r.key === key && !r.earlier);
    return running?.link.sessionTranscriptHash;
  }

  /** The links this device holds now. */
  views(): DeviceLinkView[] {
    return [...this.running.values()].map((r) => {
      const live = this.isLive(r);
      const transport = live ? r.transport : undefined;
      return { key: r.key, name: r.name, ...(r.slot === undefined ? {} : { slot: r.slot }), ...(r.earlier ? { earlier: true } : {}), status: live ? "live" as const : "connecting" as const, ...(transport ? { transport } : {}) };
    });
  }

  private changed(): void {
    try { this.options.onChange?.(this.views()); } catch { /* a listener's own trouble */ }
  }

  /** Whether the link to the device with this signing key (base64url) is open and carries device frames. */
  live(key: string): boolean {
    const running = this.find(key);
    return !!running && this.isLive(running);
  }

  /** A frame to the device with this signing key, under a capability both ends announced. Throws when the link is not live. */
  send(key: string, frame: DeviceFrame): void {
    const running = this.find(key);
    if (!running) throw new Error("This device has no link to that device");
    running.link.sendDeviceFrame(frame);
  }

  /** Sends a ping over the link and waits for its echo: how long it took, in milliseconds. */
  ping(key: string, timeoutMs = 10_000): Promise<number> {
    const running = this.find(key);
    if (!running) return Promise.reject(new Error("This device has no link to that device"));
    const ping = devicePingFrame();
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => { running.waiting.delete(ping.n); reject(new Error("The other device did not answer")); }, timeoutMs);
      running.waiting.set(ping.n, { resolve, reject, sentAt: Date.now(), timer });
      try { running.link.sendDeviceFrame(ping); } catch (error) {
        running.waiting.delete(ping.n); clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * The profile's turn keeper, signing with this device's signing key and reading `D` and its slot from the device
   * record (`setup.ts`). Null for a `single` profile, and where this transport has no turn path.
   */
  turnKeeper(): Promise<TurnKeeper | null> {
    if (this.options.offline) return Promise.resolve(null);
    const network = this.turnNetwork();
    if (!network) return Promise.resolve(null);
    this.keeper ??= openTurnKeeper(this.options.profile, network, { loadKey: this.options.loadKey, ...(this.options.undoStaging ? { undoStaging: this.options.undoStaging } : {}) }).catch((error: unknown) => { this.keeper = null; throw error; });
    return this.keeper;
  }

  /** The turn record's sources: the ones given, or the transport's own where it has them. */
  private turnNetwork(): TurnNetwork | null {
    const transport = this.options.transport;
    return this.options.turn ?? (transport.turnRead && transport.turnPut
      ? { turnRead: transport.turnRead.bind(transport), turnPut: transport.turnPut.bind(transport), ...(transport.turnWarm ? { turnWarm: transport.turnWarm.bind(transport) } : {}) } as TurnNetwork : null);
  }

  /** Reads the turn and does what this device's state asks for on the result, then brings the links in line with the record. */
  checkTurn(atStart = false): Promise<TurnOutcome | null> {
    return this.turnExclusive(() => this.checkTurnNow(atStart));
  }

  private async checkTurnNow(atStart: boolean): Promise<TurnOutcome | null> {
    // A handoff that freezes this device or takes the turn reads the turn itself: the table's `releasing` row would
    // make this device active again in the middle of pass 2, and a `taking` one settles through its own take.
    const record = await (this.options.readRecord ?? readDeviceRecord)(this.options.profile);
    if (record && ((record.state === "releasing" && record.handoff?.role === "releasing") || (record.state === "taking" && record.handoff?.release))) return null;
    const keeper = await this.turnKeeper();
    if (!keeper) return null;
    const outcome = await keeper.check(atStart);
    await this.refresh();
    return outcome;
  }

  /** A call from a page (`DeviceLinkOnlyServer`): what the standby screen and the later parts ask of the links. */
  async call(method: string, params: unknown): Promise<unknown> {
    const key = (params as { key?: unknown } | null | undefined)?.key;
    switch (method) {
      case "deviceLinks": return this.views();
      case "deviceSet": return deviceSetView(await (this.options.readRecord ?? readDeviceRecord)(this.options.profile), this.views());
      case "deviceEnrollFinish": return { finished: await this.finishEnrollment() };
      case "deviceEnrollRemove": {
        // "Not finished" with Remove (WISP 06 § Adding a device): the device holds nothing usable, and its device set
        // goes. Only then: a device that finished is removed from the active device, which moves the set to a new `D`.
        const record = await (this.options.readRecord ?? readDeviceRecord)(this.options.profile);
        if (!enrollmentUnfinished(record)) throw new Error("Only an enrollment that did not finish is removed here");
        await this.stop();
        await forgetDevice(this.options.profile);
        return null;
      }
      case "deviceLinksRefresh": await this.refresh(); return this.views();
      case "devicePushState": {
        // What a standby's page needs to keep its push subscription (`useStandbyPush`): the endpoint the record holds,
        // and the public half of its VAPID pair to subscribe again with. Never the private half.
        // `renew`: a new subscription is wanted (a removal, or a contact deleted or muted on the active device).
        const push = (await this.record())?.push;
        return push?.own ? { endpoint: push.own.e, vapidPublic: push.own.vp, ...(push.renew ? { renew: true } : {}) } : null;
      }
      case "devicePushSet": {
        // A standby's browser replaced its subscription (or notifications were turned off): the record follows, and the
        // other devices are told. With `vapid`: a renewal, a new key pair with the new subscription.
        const p = (params as { subscription?: unknown } | null)?.subscription as { endpoint?: unknown; p256dh?: unknown; auth?: unknown; vapid?: { publicKey?: unknown; privateKey?: unknown } } | null | undefined;
        if (p === null) { await this.setOwnPush(null); return null; }
        if (!p || typeof p.endpoint !== "string" || typeof p.p256dh !== "string" || typeof p.auth !== "string") throw new Error("Not a push subscription");
        checkPushEndpoint(p.endpoint);
        if (!/^[A-Za-z0-9_-]{80,100}$/.test(p.p256dh) || !/^[A-Za-z0-9_-]{20,24}$/.test(p.auth)) throw new Error("Not a push subscription");
        const vapid = p.vapid && typeof p.vapid.publicKey === "string" && typeof p.vapid.privateKey === "string" ? { publicKey: p.vapid.publicKey, privateKey: p.vapid.privateKey } : undefined;
        if (p.vapid !== undefined && (!vapid || !vapidKeysMatch(vapid))) throw new Error("The VAPID keys are not a pair");
        await this.setOwnPush({ endpoint: p.endpoint, p256dh: p.p256dh, auth: p.auth, ...(vapid ? { vapid } : {}) });
        return null;
      }
      case "deviceSetNoticeSeen": {
        // "Your devices are now: ..." answered. "This is wrong": the device stays out of that set and asks to be enrolled anew.
        const wrong = (params as { wrong?: unknown } | null)?.wrong === true;
        const record = await this.record();
        if (!record?.setNotice) return null;
        const seen = { ...record.setNotice, seen: true as const };
        if (wrong && record.state === "standby") await moveDevice(this.options.profile, "removed", { setNotice: seen, reenroll: true });
        else await amendDevice(this.options.profile, { setNotice: seen });
        await this.afterChange();
        return null;
      }
      case "deviceTurnPeek": {
        const d = (params as { d?: unknown } | null)?.d;
        const secret = typeof d === "string" ? fromBase64Url(d) : new Uint8Array();
        const network = this.turnNetwork();
        if (secret.length !== 32) throw new Error("Not a device-set secret");
        if (!network || this.options.offline) return { result: "unreachable" };
        return peekTurn(secret, network);
      }
      case "deviceTakeoverInfo": {
        // What the takeover screen needs: whether it is offered here, which device stops, whether a password is asked.
        const record = await (this.options.readRecord ?? readDeviceRecord)(this.options.profile);
        if (!record) return { offered: false };
        const target = takeoverTarget(record);
        // A `moving` device whose remover is gone: a device set of its own (`ownSet.ts`), offered with the same screen.
        const moving = record.state === "moving";
        return { offered: moving ? canStartOwnSet(record) : canTakeOver(record), ...(moving ? { ownSet: true } : {}), ...(target ? { device: target } : {}), ...(record.copy ? { copy: record.copy } : {}), password: record.copy === "frozen" || !!record.verifier };
      }
      case "deviceTakeover": {
        const p = (params ?? {}) as { password?: unknown; name?: unknown; lost?: unknown };
        if ((await this.record())?.state === "moving") {
          const outcome = await this.turnExclusive(async () => startOwnSet(await this.ownSetPorts(), { password: typeof p.password === "string" ? p.password : "", name: typeof p.name === "string" ? p.name : "" }));
          await this.afterOwnSet(outcome);
          return { kind: outcome };
        }
        const outcome = await forceTakeover({
          read: () => (this.options.readRecord ?? readDeviceRecord)(this.options.profile),
          amend: (patch) => amendDevice(this.options.profile, patch),
          proves: (verifier, password) => provesHandoffPassword(verifier, password),
          keeper: () => this.turnKeeper(),
        }, { password: typeof p.password === "string" ? p.password : "", name: typeof p.name === "string" ? p.name : "" });
        // Lost or stolen: once the profile opens here, the money checklist comes first, then removing that device.
        if (outcome.kind === "start" && p.lost === true) {
          const now = await (this.options.readRecord ?? readDeviceRecord)(this.options.profile);
          if (now?.secretOffer) await amendDevice(this.options.profile, { secretOffer: { ...now.secretOffer, lost: true } }).catch(() => {});
        }
        // Active now: the pages start again into the gate, where the engine raises the counters and starts.
        if (outcome.kind === "start") this.host?.show({ state: "standby", reload: true });
        else { const now = await (this.options.readRecord ?? readDeviceRecord)(this.options.profile); if (now) this.host?.show(viewOf(now)); }
        return { kind: outcome.kind, ...("read" in outcome ? { result: outcome.read.result } : {}), ...("state" in outcome ? { state: outcome.state } : {}) };
      }
      case "devicePing": {
        if (typeof key !== "string") throw new Error("Name the device to ping");
        return { ms: await this.ping(key) };
      }
      case "deviceTurnCheck": {
        // Also what a standby screen asks when it comes back to the front: what it shows follows a changed state.
        const outcome = await this.checkAndShow();
        // What a page may know of it: the kind and what to show, never a packet or a key.
        if (!outcome) return null;
        return { kind: outcome.kind, ...("screen" in outcome ? { screen: outcome.screen } : {}), ...("device" in outcome && outcome.device ? { device: outcome.device } : {}),
          ...("state" in outcome ? { state: outcome.state } : {}), ...("read" in outcome ? { result: outcome.read.result } : {}) };
      }
      default: {
        const answer = this.handoff?.call?.(method, params);
        if (answer) return answer;
        throw new Error(`${DEVICE_GATED_ERROR} (${method} is not available yet)`);
      }
    }
  }

  // ---------- a device set of its own (WISP 06 § Removing a device, "When the remover is gone for good") ----------

  /** What `ownSet.ts` needs of this device: its record, its signing key and the turn's sources. */
  private async ownSetPorts(): Promise<OwnSetPorts> {
    const profile = this.options.profile;
    const identity = await deviceIdentity(profile, { loadKey: this.options.loadKey ?? loadDeviceSigningKey });
    if (!identity) throw new TakeoverRefusal("state", "This profile has no device set.");
    return {
      read: () => this.record(),
      amend: (patch) => amendDevice(profile, patch),
      move: (to, patch) => moveDevice(profile, to, patch),
      proves: (verifier, password) => provesHandoffPassword(verifier, password),
      signer: (bytes) => identity.key.sign(bytes),
      network: this.options.offline ? null : this.turnNetwork(),
    };
  }

  /** What the pages show after it: the app, started again into the gate as the active device, or the state it is in now. */
  private async afterOwnSet(outcome: OwnSetOutcome): Promise<void> {
    if (outcome === "start") { this.host?.show({ state: "standby", reload: true }); return; }
    const now = await this.record().catch(() => null);
    if (now) this.host?.show(viewOf(now));
    if (outcome === "removed") await this.refresh();
  }

  /** A device set of its own that was settling when the app stopped: it settles now. */
  private settleOwnSet(): void {
    void this.turnExclusive(async () => resumeOwnSet(await this.ownSetPorts())).then((outcome) => this.afterOwnSet(outcome)).catch(() => {});
  }

  /** Says goodbye on every link and stops. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.handoff?.stop();
    await this.refresh();
  }
}
