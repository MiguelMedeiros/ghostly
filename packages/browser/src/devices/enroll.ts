import {
  ENROLL_CAPABILITY, ENROLL_DONE, ENROLL_GRANT, ENROLL_HELLO, ENROLL_PROOF, GhostLink, classifyTurnRead, createDeviceInvite, deviceInviteJoinerParams, deviceKeyZ32,
  enrollCancelFrame, enrollCancelReason, enrollDigits, enrollDoneFrame, enrollGrantFrame, enrollHelloFrame, enrollProofFrame, firstDeviceSetSecret, fromBase64Url,
  nextTurnPosition, publicKeyFromZ32, randomBytes, readDeviceInvite, readEnrollGrant, readEnrollHello, signTurnPacket, toBase64Url, turnKeys, turnName, verifyEnrollProof,
  type DeviceFrame, type DeviceInviteRefusal, type DeviceKind, type EnrollCancelReason, type EnrollNetwork, type EnrollSlot, type LinkParams, type NativeEndpoint, type NativeTransport,
  type PkarrTransport, type PollIntervals, type Signer, type TurnNetwork, type TurnRead,
} from "@ghostly/core";
import { isIosBrowserTab, type InstallEnv } from "./install";
import { DeviceSetError, deviceIdentity, firstTurn, openTurnKeeper } from "./setup";
import { createDeviceSigningKey, type DeviceSigningKey } from "./signingKey";
import { MAX_DEVICES, MAX_UNFINISHED_GRANTS, type DeviceRecord, type DeviceSlot, type UnfinishedGrant } from "./state";
import { amendDevice, enrollDevice, readDeviceRecord } from "./store";
import { deviceSetOf, type TurnKeeper } from "./turn";

/*
 * Adding a device (WISP 06 § Adding a device): `enroll/1` over a one-time session that a device code opens.
 *
 * The inviter (`EnrollInviter`) is the active device, or a `single` profile that gets its first device set now. It
 * makes a code good for ten minutes and admits the first joiner that authenticates: the one-time link takes that
 * joiner's device signing key and no other, and the code is spent. It proves itself, shows the digits, and once the
 * person says they match it grants `D`, the device set with the new slot and the turn it will publish. When the joiner
 * says it stored that, the inviter writes its own record with the new slot (stored before it is put, put byte for
 * byte, as the turn keeper does) and publishes it; it is done once a source returns that record.
 *
 * The joiner (`EnrollJoiner`) is a new device: its profile here is `single`. It makes its device signing key, pins the
 * inviter's key from the code, says hello, shows the digits only after the inviter's proof verified against that key,
 * stores the grant durably as `standby`, says `enroll-done`, and then reads the turn record until it lists this device
 * (`finishEnrollment`). Until then it is "Not finished": a `standby` record with no turn packet, since every standby
 * that finished accepted a record that lists it.
 *
 * A crash at any step leaves no enrollment or a complete one, never a half device in the set:
 * - the inviter writes nothing before the joiner said it stored the grant, and then writes everything in one record;
 *   the record is stored before it is put, so a crash after it is completed by the next start's put;
 * - the joiner writes once, before it says done; a joiner the inviter never lists holds nothing usable and shows
 *   "Not finished" with Remove.
 * `packages/browser/test/deviceEnroll.test.ts` runs that matrix.
 */

/** The inviter waits this long for `enroll-done` after its grant. */
export const ENROLL_DONE_TIMEOUT_MS = 60_000;
/** The joiner waits this long for the inviter's proof, from its first try to connect. */
export const ENROLL_PROOF_TIMEOUT_MS = 120_000;
/** How long, and how often, the joiner reads the turn record for the record that lists it. */
export const ENROLL_FINISH = { rounds: 20, everyMs: 3_000 };

/** Why an enrollment ended without a device added. */
export type EnrollFailure =
  /** The code's ten minutes ran out. */
  | "expired"
  /** The person said the digits do not match, on either device. */
  | "digits"
  /** Another device already used this code. */
  | "used"
  /** The other side stopped. */
  | "cancelled"
  /** The other device could not prove itself (a hello or a proof that does not verify). */
  | "proof"
  /** The connection dropped, or the other device stopped answering. */
  | "dropped"
  /** The other device did not answer at all. */
  | "unanswered"
  /** Which device is active could not be read. */
  | "unreachable"
  /** The profile already has a device set this device does not hold (another copy of the profile has devices). */
  | "elsewhere"
  /** Four devices already. */
  | "full"
  /** This device is no longer the active one. */
  | "replaced"
  | "failed";

/** What a page is told of an enrollment in progress. Never a secret: the code is for the person to hand over. */
export type EnrollView =
  /** The code is out; nobody has used it yet. `refused`: how many other devices tried it after it was spent. */
  | { role: "inviter"; step: "waiting"; code: string; expires: number; refused?: number }
  /** Both screens show these digits; the person says whether they match. */
  | { role: "inviter"; step: "confirm"; digits: string; device: string; kind: DeviceKind; refused?: number }
  /** The grant is out: the new device stores it, then this one adds it to the turn record. */
  | { role: "inviter"; step: "adding"; device: string }
  /** `published`: a source returned the record that lists it; otherwise it goes out at the next start. */
  | { role: "inviter"; step: "done"; device: string; published: boolean }
  | { role: "joiner"; step: "connecting" }
  | { role: "joiner"; step: "confirm"; digits: string }
  /** Stored as a standby: waiting for the active device's record that lists this one. */
  | { role: "joiner"; step: "finishing"; device: string }
  | { role: "joiner"; step: "done"; device: string }
  /** Stored, and the active device's record that lists it was not seen: "Not finished". */
  | { role: "joiner"; step: "unfinished"; device: string }
  | { role: "inviter" | "joiner"; step: "failed"; reason: EnrollFailure; device?: string };

/** A refused code, with the reason the person is told. */
export class EnrollCodeError extends Error {
  constructor(readonly reason: DeviceInviteRefusal | "set" | "home-screen") {
    super(reason === "set" ? "This profile already has a device set on this device" : reason === "home-screen" ? "Add Ghostly to your Home Screen first." : `This code cannot add a device (${reason})`);
    this.name = "EnrollCodeError";
  }
}

/** The one-time session, as the state machines below use it: GhostLink in the app (`ghostLinkEnrollChannel`), a pair of pipes in tests. */
export interface EnrollChannel {
  send(frame: DeviceFrame): void;
  stop(): Promise<void>;
}

export interface EnrollChannelEvents {
  /** The session is up, with `enroll/1` agreed: the other side's device signing key, and the session's transcript hash. */
  onOpen(peerKey: Uint8Array, transcriptHash: string): void;
  onFrame(frame: DeviceFrame): void;
  /** The session went down. */
  onClose(): void;
  /** Another device tried the link with another key than the one it took (the inviter), or than the code names (the joiner). */
  onPeerRefused(): void;
}

/** `peerKey`: the other side's device signing key when it is known (the joiner, from the code); null for the inviter, which takes the first. */
export type OpenEnrollChannel = (setup: { params: LinkParams; signer: Signer; peerKey: Uint8Array | null }, events: EnrollChannelEvents) => EnrollChannel;

/** Where a test stops an enrollment, as a crash would: nothing after it runs. */
export type EnrollCrashPoint =
  | "inviter:noted" | "inviter:granted" | "inviter:done-received" | "inviter:before-write" | "inviter:after-write" | "inviter:after-put"
  | "joiner:key-made" | "joiner:grant-received" | "joiner:after-write" | "joiner:after-done";

/** A crash a test asked for: the state machine stops where it is. */
export class EnrollCrash extends Error {
  constructor(readonly at: EnrollCrashPoint) {
    super(`crashed at ${at}`);
    this.name = "EnrollCrash";
  }
}

interface Shared {
  /** The profile's peer database name: the key of its device record and of its device signing key. */
  profile: string;
  /** The turn record's sources. */
  network: TurnNetwork;
  open: OpenEnrollChannel;
  /** Seconds and milliseconds since 1970: the code's expiry is in seconds. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Runs after this device's record was written with the device set: the network settings go in, and the links start. */
  afterWrite?: () => Promise<void>;
  /** A view changed. */
  onChange?: (view: EnrollView) => void;
  /** A stored seed in place of a non-extractable key (tests). */
  forceSeed?: boolean;
  /** Tests stop here, as a crash would. */
  crash?: (at: EnrollCrashPoint) => void;
  /** Tests: the timers' lengths. */
  timing?: Partial<{ doneMs: number; proofMs: number; grantMs: number; finishRounds: number; finishEveryMs: number }>;
}

const sameKey = (a: Uint8Array, b: Uint8Array) => toBase64Url(a) === toBase64Url(b);
const failureOf = (why: EnrollCancelReason): EnrollFailure => (why === "digits" ? "digits" : why === "used" ? "used" : why === "expired" ? "expired" : why === "full" ? "full" : why === "cancelled" ? "cancelled" : "failed");

abstract class Enrollment {
  protected view: EnrollView;
  protected channel: EnrollChannel | null = null;
  protected over = false;
  /**
   * Past the point of no return: the inviter got `enroll-done`, the joiner stored the grant. A cancel (the person's,
   * the other side's, a dropped session) no longer ends it: what is written is finished, not left half done.
   */
  protected committed = false;
  protected readonly now: () => number;
  protected readonly sleep: (ms: number) => Promise<void>;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(protected readonly shared: Shared, first: EnrollView) {
    this.view = first;
    this.now = shared.now ?? Date.now;
    this.sleep = shared.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** What the pages show now. */
  current(): EnrollView { return this.view; }
  /** Whether it ended (done, failed or unfinished). */
  get ended(): boolean { return this.over; }

  protected show(view: EnrollView): void {
    this.view = view;
    try { this.shared.onChange?.(view); } catch { /* a listener's own trouble */ }
  }

  /** A crash a test asked for: nothing of this enrollment runs any more, as nothing of a process that died does. */
  protected crash(at: EnrollCrashPoint): void {
    try { this.shared.crash?.(at); } catch (error) { this.die(); throw error; }
  }

  private die(): void {
    this.over = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.channel = null;
  }

  protected timer(ms: number, run: () => void): () => void {
    const timer = setTimeout(() => { this.timers.delete(timer); run(); }, ms);
    this.timers.add(timer);
    return () => { clearTimeout(timer); this.timers.delete(timer); };
  }

  protected send(frame: DeviceFrame): void {
    try { this.channel?.send(frame); } catch { /* the session closed under it: the other side times out */ }
  }

  /** Ends the enrollment: the one-time session is stopped and its link is served no longer. */
  protected async end(view: EnrollView): Promise<void> {
    if (this.over) return;
    this.over = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.show(view);
    const channel = this.channel;
    this.channel = null;
    await channel?.stop().catch(() => {});
  }

  /** `force`: a failure of the committed steps themselves (no good read, a store that failed), which still ends it. */
  protected fail(reason: EnrollFailure, tell?: EnrollCancelReason, device?: string, force = false): Promise<void> {
    if (this.over || (this.committed && !force)) return Promise.resolve();
    if (tell) this.send(enrollCancelFrame(tell));
    return this.end({ role: this.view.role, step: "failed", reason, ...(device ? { device } : {}) } as EnrollView);
  }

  /** The person stops it, on either side. */
  cancel(): Promise<void> { return this.fail("cancelled", "cancelled"); }

  /** A step that throws (a crash a test asked for, a store that failed) ends it, except a crash: that leaves everything as it was. */
  protected guard(work: () => Promise<void>): void {
    void work().catch((error: unknown) => {
      if (error instanceof EnrollCrash) { this.die(); return; }
      void this.fail("failed", "failed", undefined, true);
    });
  }
}

/** One read of the turn at an address this device may hold no record of yet. */
async function readAt(network: TurnNetwork, d: Uint8Array, ownKey: Uint8Array, ownSlot: number): Promise<TurnRead> {
  const keys = turnKeys(d);
  const answers = await network.turnRead(keys.identity.pubKeyZ32);
  return classifyTurnRead({ keys, ownKey, stored: null, ownSlot, seen: 0n }, answers);
}

/** The device set as the record keeps it, from a grant's slots, padded to four. */
const recordSlots = (set: EnrollSlot[]): (DeviceSlot | null)[] =>
  Array.from({ length: MAX_DEVICES }, (_, i) => { const slot = set[i]; return slot ? { key: toBase64Url(slot.key), name: slot.name } : null; });

export interface InviterOptions extends Shared {
  /** The DID key's seed: the first `D` of a profile that has no device set yet comes from it (WISP 06 § Terms). */
  didSeed: () => Promise<Uint8Array>;
  /** This device's name in the set, when it gets its first device set now. */
  name: string;
  /** The turn keeper of the profile, once it has a record (tests give their own). */
  keeper?: () => Promise<TurnKeeper | null>;
  /** The person's network settings, which the grant carries to the new standby. */
  networkSettings?: () => EnrollNetwork | undefined;
}

/**
 * The active device's side (or a `single` profile's, which becomes the active device of its first device set at the
 * end). `start()` makes the code; the person compares the digits and calls `confirm`.
 */
export class EnrollInviter extends Enrollment {
  private key!: DeviceSigningKey;
  private d!: Uint8Array;
  private record: DeviceRecord | null = null;
  private session: { peerKey: Uint8Array; hash: string } | null = null;
  private joiner: { key: Uint8Array; name: string; kind: DeviceKind } | null = null;
  private granted: { slots: EnrollSlot[]; ownSlot: number; turn: number; rev: number } | null = null;
  /** This enrollment makes the profile's first device set: its record was written, with a set of one, at the grant. */
  private first = false;
  private refused = 0;
  private stopDoneWait: (() => void) | null = null;

  constructor(private readonly options: InviterOptions) {
    super(options, { role: "inviter", step: "waiting", code: "", expires: 0 });
  }

  /** Makes the code and opens the one-time link. Throws when this device cannot add one now; nothing is written. */
  async start(): Promise<EnrollView> {
    const { profile, network } = this.options;
    this.record = await readDeviceRecord(profile);
    if (this.record && this.record.state !== "active") throw new Error("Only the active device adds a device");
    if (this.record) {
      const identity = await deviceIdentity(profile, { record: this.record });
      if (!identity) throw new DeviceSetError("no device set");
      this.key = identity.key;
      this.d = identity.d;
      if (this.record.deviceSet.filter(Boolean).length >= MAX_DEVICES) throw new EnrollRefusal("full");
    } else {
      this.key = await createDeviceSigningKey(profile, { forceSeed: this.options.forceSeed });
      this.d = firstDeviceSetSecret(await this.options.didSeed());
      // A profile that gets its first device set: nothing may be at its turn address yet. A record there means
      // another copy of this profile (a restored backup) made a device set this one does not hold.
      const read = await readAt(network, this.d, this.key.publicKey, 0);
      if (!read.good) throw new EnrollRefusal("unreachable");
      if (read.result !== "none") throw new EnrollRefusal("elsewhere");
    }
    const side = createDeviceInvite(this.key.publicKey, Math.floor(this.now() / 1000));
    this.show({ role: "inviter", step: "waiting", code: side.code, expires: side.invite.expires });
    this.channel = this.options.open({ params: side.params, signer: this.key, peerKey: null }, {
      onOpen: (peerKey, hash) => { if (!this.joiner || sameKey(peerKey, this.joiner.key)) this.session = { peerKey, hash }; },
      onFrame: (frame) => this.guard(() => this.receive(frame)),
      onClose: () => { if (!this.over && this.view.step !== "waiting" && this.view.step !== "done") void this.fail("dropped"); },
      onPeerRefused: () => {
        // A second device tried the code that the first one spent: it gets nothing, and the person is told.
        this.refused++;
        const view = this.view;
        if (view.role === "inviter" && (view.step === "waiting" || view.step === "confirm")) this.show({ ...view, refused: this.refused });
      },
    });
    // The ten minutes bound the admission: a code nobody confirmed by then is spent.
    this.timer(Math.max(0, side.invite.expires * 1000 - this.now()), () => { if (this.view.step === "waiting" || this.view.step === "confirm") void this.fail("expired", "expired"); });
    return this.view;
  }

  private async receive(frame: DeviceFrame): Promise<void> {
    if (this.over) return;
    const cancelled = enrollCancelReason(frame);
    if (cancelled) { await this.fail(failureOf(cancelled), undefined, this.joiner?.name); return; }
    if (frame.t === ENROLL_HELLO && this.view.step === "waiting" && this.session && !this.joiner) {
      const hello = readEnrollHello(frame, this.session.hash, this.key.publicKey, this.session.peerKey);
      if (!hello) { await this.fail("proof", "failed"); return; }
      // The first joiner that authenticated: the code is spent.
      this.joiner = { key: hello.key, name: hello.name || "Device", kind: hello.kind };
      this.send(await enrollProofFrame(this.session.hash, this.key, hello.key));
      this.show({ role: "inviter", step: "confirm", digits: enrollDigits(this.session.hash, this.key.publicKey, hello.key), device: this.joiner.name, kind: hello.kind, ...(this.refused ? { refused: this.refused } : {}) });
      return;
    }
    if (frame.t === ENROLL_DONE && this.view.step === "adding" && !this.committed) { this.committed = true; this.stopDoneWait?.(); await this.finish(); }
  }

  /**
   * The person compared the digits. On a match the grant goes out; on no match, or on anything else, the session ends
   * and nothing was written.
   */
  async confirm(match: boolean): Promise<EnrollView> {
    if (this.over || this.view.step !== "confirm" || !this.joiner) throw new Error("There are no digits to confirm");
    if (!match) { await this.fail("digits", "digits", this.joiner.name); return this.view; }
    const joiner = this.joiner;
    let slots: EnrollSlot[], ownSlot: number, turn: number, rev: number;
    const note: UnfinishedGrant = { key: toBase64Url(joiner.key), name: joiner.name, at: this.now() };
    if (!this.record) {
      ownSlot = 0;
      const own = { key: this.key.publicKey, name: turnName(this.options.name) || "Device" };
      slots = [own, { key: joiner.key, name: joiner.name }, null, null];
      turn = firstTurn();
      rev = 0;
      // Before `D` leaves this device, it notes that it hands `D` out: the profile gets its device set now, with this
      // device alone in it and the grant noted. A grant whose done never comes back stays noted ("Not finished").
      this.record = await enrollDevice(this.options.profile, "active", {
        d: toBase64Url(this.d), deviceSet: recordSlots([own]), ownSlot: 0, activeSlot: 0, turn, rev: 0, signingKey: this.key.kind, unfinishedGrants: [note],
      });
      this.first = true;
    } else {
      // The record may have changed since the code was made (a rename, a turn read): read it again.
      this.record = await readDeviceRecord(this.options.profile);
      if (!this.record || this.record.state !== "active" || this.record.ownSlot === undefined) { await this.fail("replaced", "failed", joiner.name); return this.view; }
      ownSlot = this.record.ownSlot;
      const set = Array.from({ length: MAX_DEVICES }, (_, i) => this.record!.deviceSet[i] ?? null);
      if (set.some((slot) => slot?.key === toBase64Url(joiner.key))) { await this.fail("failed", "failed", joiner.name); return this.view; }
      const free = set.indexOf(null);
      if (free < 0) { await this.fail("full", "full", joiner.name); return this.view; }
      slots = set.map((slot, i) => (i === free ? { key: joiner.key, name: joiner.name } : slot ? { key: fromBase64Url(slot.key), name: slot.name } : null));
      // Where the keeper will write: the next `rev` of this turn above all it saw (the turn moves on only when `rev` runs
      // out); `rev` 0 when this device never put a record (its first set's first grant did not finish).
      const place = nextTurnPosition(this.record.turn, this.record.turnPacket ? this.record.rev : null, ownSlot, this.record.seenSequence ?? 0);
      if (!place) { await this.fail("failed", "failed", joiner.name); return this.view; }
      ({ turn, rev } = place);
      const kept = (this.record.unfinishedGrants ?? []).filter((grant) => grant.key !== note.key);
      this.record = await amendDevice(this.options.profile, { unfinishedGrants: [...kept, note].slice(-MAX_UNFINISHED_GRANTS) });
    }
    this.crash("inviter:noted");
    this.granted = { slots, ownSlot, turn, rev };
    const settings = this.options.networkSettings?.();
    this.send(enrollGrantFrame({ d: this.d, set: slots, turn, rev, ...(settings ? { network: settings } : {}) }));
    this.show({ role: "inviter", step: "adding", device: joiner.name });
    this.crash("inviter:granted");
    this.stopDoneWait = this.timer(this.options.timing?.doneMs ?? ENROLL_DONE_TIMEOUT_MS, () => { if (this.view.step === "adding") void this.fail("dropped", "failed", joiner.name); });
    return this.view;
  }

  /**
   * The new device stored the grant: this one writes its record with the new slot, in one durable write, and only
   * then puts it. It is done once a source returns that record.
   */
  private async finish(): Promise<void> {
    const { profile, network } = this.options;
    const joiner = this.joiner!, granted = this.granted!;
    this.crash("inviter:done-received");
    let keeper: TurnKeeper | null;
    let conditions: Record<string, string | null>;
    // The record with the new slot no longer notes the grant: one write does both.
    const unfinishedGrants = (this.record?.unfinishedGrants ?? []).filter((grant) => grant.key !== toBase64Url(joiner.key));
    if (this.first) {
      const read = await readAt(network, this.d, this.key.publicKey, 0);
      if (!read.good) { await this.fail("unreachable", "failed", joiner.name, true); return; }
      if (read.result !== "none") { await this.fail("elsewhere", "failed", joiner.name, true); return; }
      const keys = turnKeys(this.d);
      const packet = await signTurnPacket(keys, {
        turn: granted.turn, rev: 0, author: 0, active: 0, instance: randomBytes(8),
        slots: granted.slots.map((slot) => slot && { key: slot.key, name: slot.name }),
      }, (bytes) => this.key.sign(bytes));
      this.crash("inviter:before-write");
      // One write: both devices, the stored packet, and the grant no longer noted.
      await amendDevice(profile, { deviceSet: recordSlots(granted.slots), turn: granted.turn, rev: 0, turnPacket: toBase64Url(packet), unfinishedGrants });
      this.crash("inviter:after-write");
      keeper = await (this.options.keeper?.() ?? openTurnKeeper(profile, network));
      if (!keeper) throw new Error("The device set has no turn keeper");
      conditions = read.conditions;
      await keeper.putStored(conditions);
    } else {
      keeper = await (this.options.keeper?.() ?? openTurnKeeper(profile, network));
      if (!keeper) throw new Error("The device set has no turn keeper");
      const read = await keeper.read();
      if (!read || !read.good) { await this.fail("unreachable", "failed", joiner.name, true); return; }
      if (read.result !== "mine" && read.result !== "none" && read.result !== "behind") {
        // Another device holds the turn, or the address is closed: the keeper does what this device's state asks for.
        await keeper.check(false).catch(() => null);
        await this.fail("replaced", "failed", joiner.name, true);
        return;
      }
      this.crash("inviter:before-write");
      // Signed, stored with the new slot (and the grant no longer noted) in one write, and only then put.
      await keeper.write(read.conditions, { slots: recordSlots(granted.slots), patch: { unfinishedGrants } });
    }
    this.crash("inviter:after-put");
    const published = await confirmPublished(keeper, this.sleep);
    await this.options.afterWrite?.().catch(() => {});
    await this.end({ role: "inviter", step: "done", device: joiner.name, published });
  }
}

/** A device cannot add one now: nothing was written, no code was made. */
export class EnrollRefusal extends Error {
  constructor(readonly reason: Extract<EnrollFailure, "unreachable" | "elsewhere" | "full">) {
    super(reason === "full" ? "This profile has four devices already" : reason === "elsewhere" ? "This profile already has devices elsewhere" : "Ghostly could not check which device is active");
    this.name = "EnrollRefusal";
  }
}

/**
 * Reads until a source returns the record this device stored: `mine`. A record no source holds is put again (the same
 * bytes, on the conditions of the read). Gives up after a few rounds: the record is stored, and the next start puts it.
 */
async function confirmPublished(keeper: TurnKeeper, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  for (let round = 0; round < 4; round++) {
    const read = await keeper.read().catch(() => null);
    if (!read) return false;
    if (read.result === "mine") return true;
    if (read.result === "none" || read.result === "behind") await keeper.putStored(read.conditions).catch(() => null);
    else if (read.result === "unreachable" || read.result === "closed") await sleep(2_000);
    else { await keeper.check(false).catch(() => null); return false; }
  }
  return false;
}

export interface JoinerOptions extends Shared {
  /** This device as the set will name it, and what kind of client it is. */
  about: { name: string; kind: DeviceKind; app: string };
  /** The browser, for the iPhone and iPad check (tests give their own). */
  install?: InstallEnv | null;
}

/** The new device's side. `start(code)` reads the code and connects; the rest follows the frames. */
export class EnrollJoiner extends Enrollment {
  private key!: DeviceSigningKey;
  private invite!: ReturnType<typeof readDeviceInvite> & { ok: true };
  private hash: string | null = null;
  private proven = false;
  private inviterName = "";

  constructor(private readonly options: JoinerOptions) {
    super(options, { role: "joiner", step: "connecting" });
  }

  /** Reads the code and connects. Throws `EnrollCodeError` for a code it refuses, or a device that may not join here: nothing was written. */
  async start(code: string): Promise<EnrollView> {
    if (isIosBrowserTab(this.options.install)) throw new EnrollCodeError("home-screen");
    const reading = readDeviceInvite(code, Math.floor(this.now() / 1000));
    if (!reading.ok) throw new EnrollCodeError(reading.reason);
    this.invite = reading;
    if (await readDeviceRecord(this.options.profile)) throw new EnrollCodeError("set");
    this.key = await createDeviceSigningKey(this.options.profile, { forceSeed: this.options.forceSeed });
    this.crash("joiner:key-made");
    const inviterKey = reading.invite.inviterKey;
    this.show({ role: "joiner", step: "connecting" });
    this.channel = this.options.open({ params: deviceInviteJoinerParams(reading.invite), signer: this.key, peerKey: inviterKey }, {
      onOpen: (peerKey, hash) => this.guard(() => this.opened(peerKey, hash)),
      onFrame: (frame) => this.guard(() => this.receive(frame)),
      onClose: () => { if (!this.over && (this.view.step === "connecting" || this.view.step === "confirm") && this.hash) void this.fail("dropped"); },
      onPeerRefused: () => {},
    });
    // No proof in time: the code was spent by another device, or the other one is gone.
    this.timer(this.options.timing?.proofMs ?? ENROLL_PROOF_TIMEOUT_MS, () => { if (!this.proven) void this.fail("unanswered", "failed"); });
    return this.view;
  }

  private async opened(peerKey: Uint8Array, hash: string): Promise<void> {
    if (this.over || this.hash) return;
    // The session pinned the key in the code; anything else is not the inviter.
    if (!sameKey(peerKey, this.invite.invite.inviterKey)) return;
    this.hash = hash;
    this.send(await enrollHelloFrame(hash, this.invite.invite.inviterKey, this.key, this.options.about));
  }

  private async receive(frame: DeviceFrame): Promise<void> {
    if (this.over || !this.hash) return;
    const cancelled = enrollCancelReason(frame);
    if (cancelled) { await this.fail(failureOf(cancelled)); return; }
    const inviterKey = this.invite.invite.inviterKey;
    if (frame.t === ENROLL_PROOF && !this.proven) {
      // The digits only after the inviter proved itself with the key in the code.
      if (!verifyEnrollProof(frame, this.hash, inviterKey, this.key.publicKey)) { await this.fail("proof", "failed"); return; }
      this.proven = true;
      // The person confirms on the other device within the code's ten minutes; no grant by then (and a little after),
      // and the other device is gone: nothing was written here.
      const grantMs = this.options.timing?.grantMs ?? Math.max(0, this.invite.invite.expires * 1000 - this.now()) + ENROLL_DONE_TIMEOUT_MS;
      this.timer(grantMs, () => { if (!this.committed && this.view.step === "confirm") void this.fail("unanswered", "failed"); });
      this.show({ role: "joiner", step: "confirm", digits: enrollDigits(this.hash, inviterKey, this.key.publicKey) });
      return;
    }
    if (frame.t === ENROLL_GRANT && this.proven && this.view.step === "confirm") {
      const grant = readEnrollGrant(frame, inviterKey, this.key.publicKey);
      if (!grant) { await this.fail("failed", "failed"); return; }
      this.inviterName = grant.set[grant.inviterSlot]?.name ?? "";
      this.crash("joiner:grant-received");
      // One durable write: `single` becomes `standby`, with the secret, the set, this device's slot and the person's
      // network settings as the active device has them.
      await enrollDevice(this.options.profile, "standby", {
        d: toBase64Url(grant.d), deviceSet: recordSlots(grant.set), ownSlot: grant.ownSlot, activeSlot: grant.inviterSlot,
        turn: grant.turn, rev: grant.rev, signingKey: this.key.kind, ...(grant.network ? { network: grant.network } : {}),
      });
      this.committed = true;
      this.crash("joiner:after-write");
      // A grant from a build that carries no network settings: this app's own go in.
      if (!grant.network) await this.options.afterWrite?.().catch(() => {});
      this.send(enrollDoneFrame());
      this.crash("joiner:after-done");
      this.show({ role: "joiner", step: "finishing", device: this.inviterName });
      const finished = await finishEnrollment(this.options.profile, this.options.network, {
        sleep: this.sleep, rounds: this.options.timing?.finishRounds, everyMs: this.options.timing?.finishEveryMs, stopped: () => this.over,
      });
      await this.end({ role: "joiner", step: finished ? "done" : "unfinished", device: this.inviterName });
    }
  }
}

/**
 * The active device's own record, found again (WISP 06 § Durable device state assumes a strict write survives; this is
 * for when it did not). An enrollment that noted a grant, wrote the record with the new slot, put it, and then lost
 * that write finds on the network a record of its own slot, signed with its own key, above what it stored: the turn
 * read calls that a clone, and the device would stop. When that record is what the enrollment was writing (every
 * device of the stored set, plus a device whose grant is noted), it is this device's own: it is stored again, and the
 * grant is no longer noted. Anything else is left to the turn read. True when a record was taken back.
 */
export async function recoverEnrollment(profile: string, network: TurnNetwork): Promise<boolean> {
  const record = await readDeviceRecord(profile);
  if (!record || record.state !== "active" || !record.d || record.ownSlot === undefined || !record.unfinishedGrants?.length) return false;
  const own = record.deviceSet[record.ownSlot];
  if (!own) return false;
  const ownKey = fromBase64Url(own.key);
  const keys = turnKeys(fromBase64Url(record.d));
  const answers = await network.turnRead(keys.identity.pubKeyZ32).catch(() => null);
  if (!answers) return false;
  const read = classifyTurnRead({ keys, ownKey, stored: record.turnPacket ? fromBase64Url(record.turnPacket) : null, ownSlot: record.ownSlot, seen: BigInt(record.seenSequence ?? 0) }, answers);
  if (read.result !== "clone" || read.clone !== "above" || !read.record || !read.payload) return false;
  const found = read.record;
  const author = found.slots[found.author];
  if (found.author !== record.ownSlot || !author || !sameKey(author.key, ownKey)) return false;
  const listed = new Set(found.slots.flatMap((slot) => (slot ? [toBase64Url(slot.key)] : [])));
  if (!record.deviceSet.every((slot) => !slot || listed.has(slot.key))) return false;
  const added = record.unfinishedGrants.filter((grant) => listed.has(grant.key));
  if (!added.length) return false;
  await amendDevice(profile, {
    turn: found.turn, rev: found.rev, turnPacket: toBase64Url(read.payload), activeSlot: found.active, deviceSet: deviceSetOf(found),
    unfinishedGrants: record.unfinishedGrants.filter((grant) => !listed.has(grant.key)),
    ...(found.sequence > (record.seenSequence ?? 0) ? { seenSequence: found.sequence } : {}),
  });
  return true;
}

/** Whether a record lists this device in the slot it was given. */
const listsAt = (read: TurnRead, ownKey: Uint8Array, ownSlot: number): boolean => {
  const slot = read.record?.slots[ownSlot];
  return !!slot && sameKey(slot.key, ownKey);
};

/**
 * The last step of a joiner, which a crash may leave for the next start: it reads the turn record until a valid one
 * lists this device in its slot, and then keeps it as the record it accepted. True once it holds such a record (now
 * or before); false while it does not ("Not finished").
 */
export async function finishEnrollment(profile: string, network: TurnNetwork, options: { sleep?: (ms: number) => Promise<void>; rounds?: number; everyMs?: number; stopped?: () => boolean } = {}): Promise<boolean> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const rounds = options.rounds ?? ENROLL_FINISH.rounds;
  for (let round = 0; round < rounds; round++) {
    const record = await readDeviceRecord(profile);
    if (!record || record.state !== "standby" || !record.d || record.ownSlot === undefined) return !!record?.turnPacket;
    if (record.turnPacket) return true;
    const own = record.deviceSet[record.ownSlot];
    if (!own) return false;
    const ownKey = fromBase64Url(own.key);
    const read = await readAt(network, fromBase64Url(record.d), ownKey, record.ownSlot).catch(() => null);
    if (read && read.result === "other" && read.record && read.payload && !read.record.tombstone && listsAt(read, ownKey, record.ownSlot)) {
      const seen = Number(read.record.sequence);
      await amendDevice(profile, {
        turn: read.record.turn, rev: read.record.rev, turnPacket: toBase64Url(read.payload), activeSlot: read.record.active, deviceSet: deviceSetOf(read.record),
        ...(seen > (record.seenSequence ?? 0) ? { seenSequence: seen } : {}),
      });
      return true;
    }
    if (options.stopped?.() || round === rounds - 1) break;
    await sleep(options.everyMs ?? ENROLL_FINISH.everyMs);
  }
  return false;
}

/** Whether a profile's device record is an enrollment that did not finish: a standby that never accepted a record listing it. */
export const enrollmentUnfinished = (record: DeviceRecord | null): boolean => !!record && record.state === "standby" && !record.turnPacket && record.copy !== "restored" && !record.setNotice;

/** What a `GhostLink` for the one-time session needs of the app. */
export interface EnrollLinkOptions {
  transport: PkarrTransport;
  createPeerConnection?: () => RTCPeerConnection;
  nativeTransports?: Partial<Record<NativeTransport, (seedB64: string) => Promise<NativeEndpoint>>>;
  pollIntervals?: PollIntervals;
}

/**
 * The one-time session on a `GhostLink`: a paired session whose participation keys are the two device signing keys,
 * signing through the signer, with `enroll/1` as its only capability. The joiner pins the inviter's key from the code;
 * the inviter takes the first key that authenticates and no other (trust on first use, for this one session only).
 * Nothing of it is stored: when it stops, its link is gone.
 */
export function ghostLinkEnrollChannel(options: EnrollLinkOptions): OpenEnrollChannel {
  return ({ params, signer, peerKey }, events) => {
    const pinned = peerKey ? deviceKeyZ32(peerKey) : undefined;
    let taken: string | undefined = pinned;
    let opened = false;
    const credentials = pinned
      ? { seedB64: "", signer, peerKey: pinned, expectedPeerKey: pinned, verifiedPeerKey: pinned, requireSignedSignals: true }
      : { seedB64: "", signer };
    let link: GhostLink | null = null;
    const rtc = !!options.createPeerConnection;
    const tryOpen = () => {
      if (opened || !link?.supportsDevice(ENROLL_CAPABILITY)) return;
      const hash = link.sessionTranscriptHash, key = credentials.peerKey;
      if (!hash || !key) return;
      opened = true;
      events.onOpen(publicKeyFromZ32(key), hash);
    };
    link = new GhostLink({
      params,
      pairing: {
        credentials,
        pinPeer: async (key) => {
          if (taken && key !== taken) throw new Error("Not the device this code is for");
          taken = key;
        },
        trustOnFirstUse: !pinned,
      },
      deviceCapabilities: [ENROLL_CAPABILITY],
      rtcAvailable: rtc,
      native: { automatic: true },
      packetTransports: true,
      transport: options.transport,
      pollIntervals: options.pollIntervals,
      autoConnect: true,
      createPeerConnection: () => {
        if (!options.createPeerConnection) throw new ReferenceError("RTCPeerConnection is not defined");
        return options.createPeerConnection();
      },
      localFetch: async () => { throw new Error("An enrollment link serves no local web app"); },
      getServices: () => [{ id: "chat", type: "chat" }],
      getHostedHttpService: () => undefined,
      events: {
        onDeviceCapabilities: () => tryOpen(),
        onPairingState: () => tryOpen(),
        onDataLinkState: (state) => {
          if (state === "open") { tryOpen(); return; }
          if (opened) { opened = false; events.onClose(); }
        },
        onDeviceFrame: (frame) => { if (opened) events.onFrame(frame); },
        onPeerKeyRefused: () => events.onPeerRefused(),
      },
    });
    link.start();
    // Where this page has no WebRTC, the session runs on the native transports, each on a seed made for this run.
    if (!rtc) void (async () => {
      for (const [transport, factory] of Object.entries(options.nativeTransports ?? {})) {
        if (!factory) continue;
        try {
          const endpoint = await factory(randomSeed());
          if (!link) { await endpoint.close(); return; }
          link.registerEndpoint(endpoint);
        } catch { /* this transport is not available now */ }
        void transport;
      }
    })();
    return {
      send: (frame) => link!.sendDeviceFrame(frame),
      stop: async () => { const running = link; link = null; await running?.stop().catch(() => {}); },
    };
  };
}

const randomSeed = () => toBase64Url(randomBytes(32));
