import {
  DEVICES_CAPABILITY, GhostLink, RTC_CONFIG, createIdentity, deviceEchoFrame, deviceEchoNonce, deviceLinkPairing, devicePingFrame, fromBase64Url,
  type DeviceFrame, type NativeEndpoint, type NativeTransport, type PairedTransport, type PkarrTransport, type PollIntervals, type TurnNetwork,
} from "@ghostly/core";
import { DEVICE_GATED_ERROR, type DeviceLinkEngine, type DeviceLinkHost } from "./linkOnly";
import { DeviceSetError, deviceIdentity, openTurnKeeper } from "./setup";
import { loadDeviceSigningKey, type DeviceSigningKey } from "./signingKey";
import type { DeviceRecord } from "./state";
import { readDeviceRecord } from "./store";
import type { TurnKeeper, TurnOutcome } from "./turn";

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
  /** Every device frame that is not the link's own ping or echo, with the signing key (base64url) of the device that sent it. */
  onFrame?: (from: string, frame: DeviceFrame) => void | Promise<void>;
  /** The links changed (one opened, closed, or the set changed). */
  onChange?: (links: DeviceLinkView[]) => void;
  /** The turn record's sources, for `turnKeeper()`. Default: the transport's own, where it has them. */
  turn?: TurnNetwork;
  /** Tests give their own. */
  readRecord?: (profile: string) => Promise<DeviceRecord | null>;
  loadKey?: (profile: string) => Promise<DeviceSigningKey | null>;
}

interface Running {
  id: string;
  key: string;
  name: string;
  slot?: number;
  earlier: boolean;
  link: GhostLink;
  /** The devices capability is agreed on the open session. */
  agreed: boolean;
  /** The transport the open session runs on. */
  transport?: PairedTransport;
  native: boolean;
  waiting: Map<string, { resolve(ms: number): void; reject(error: Error): void; sentAt: number; timer: ReturnType<typeof setTimeout> }>;
}

interface Wanted { id: string; d: Uint8Array; key: string; name: string; slot?: number; earlier: boolean }

const defaultPeerConnection = (): (() => RTCPeerConnection) | undefined =>
  (typeof RTCPeerConnection === "undefined" ? undefined : () => new RTCPeerConnection({ iceServers: RTC_CONFIG.iceServers }));

export class DeviceLinks implements DeviceLinkEngine {
  private readonly running = new Map<string, Running>();
  private readonly createPeerConnection?: () => RTCPeerConnection;
  private key: DeviceSigningKey | null = null;
  private keeper: Promise<TurnKeeper | null> | null = null;
  private stopped = false;
  /** Why this device holds no links although it has a device set (a record that cannot carry one, a missing key). */
  problem: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: DeviceLinksOptions) {
    this.createPeerConnection = "createPeerConnection" in options ? options.createPeerConnection : defaultPeerConnection();
  }

  /** `host` is the device-link-only server's; the links need nothing of it yet. */
  async start(_host?: DeviceLinkHost): Promise<void> {
    await this.refresh();
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
    for (const want of wanted) if (!this.running.has(want.id) && !this.stopped) this.open(want);
    if (closing.length || wanted.length) this.changed();
  }

  /** The links the record asks for. Empty for a `single` profile, which is not even asked for its key. */
  private async wanted(): Promise<Wanted[]> {
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
        const name = record.deviceSet.find((slot) => slot?.key === key)?.name ?? "";
        wanted.push({ id: `${earlier.d}|${key}`, d: fromBase64Url(earlier.d), key, name, earlier: true });
      }
    }
    return wanted;
  }

  private open(want: Wanted): void {
    const signer = this.key!;
    const rtc = !!this.createPeerConnection;
    const running: Running = { id: want.id, key: want.key, name: want.name, slot: want.slot, earlier: want.earlier, link: null as unknown as GhostLink, agreed: false, native: false, waiting: new Map() };
    running.link = new GhostLink({
      ...deviceLinkPairing(want.d, signer, fromBase64Url(want.key)),
      deviceCapabilities: [DEVICES_CAPABILITY],
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
        onDeviceCapabilities: (agreed) => { running.agreed = agreed.includes(DEVICES_CAPABILITY); this.changed(); },
        onDataLinkState: (state) => {
          if (state !== "open") { running.agreed = false; this.failPings(running, "The device link closed"); }
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
    await this.options.onFrame?.(running.key, frame);
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
    const transport = this.options.transport;
    const network = this.options.turn ?? (transport.turnRead && transport.turnPut
      ? { turnRead: transport.turnRead.bind(transport), turnPut: transport.turnPut.bind(transport), ...(transport.turnWarm ? { turnWarm: transport.turnWarm.bind(transport) } : {}) } as TurnNetwork : null);
    if (!network) return Promise.resolve(null);
    this.keeper ??= openTurnKeeper(this.options.profile, network, { loadKey: this.options.loadKey }).catch((error: unknown) => { this.keeper = null; throw error; });
    return this.keeper;
  }

  /** Reads the turn and does what this device's state asks for on the result, then brings the links in line with the record. */
  async checkTurn(atStart = false): Promise<TurnOutcome | null> {
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
      case "deviceLinksRefresh": await this.refresh(); return this.views();
      case "devicePing": {
        if (typeof key !== "string") throw new Error("Name the device to ping");
        return { ms: await this.ping(key) };
      }
      case "deviceTurnCheck": {
        const outcome = await this.checkTurn();
        // What a page may know of it: the kind and what to show, never a packet or a key.
        if (!outcome) return null;
        return { kind: outcome.kind, ...("screen" in outcome ? { screen: outcome.screen } : {}), ...("device" in outcome && outcome.device ? { device: outcome.device } : {}),
          ...("state" in outcome ? { state: outcome.state } : {}), ...("read" in outcome ? { result: outcome.read.result } : {}) };
      }
      default: throw new Error(`${DEVICE_GATED_ERROR} (${method} is not available yet)`);
    }
  }

  /** Says goodbye on every link and stops. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.refresh();
  }
}
