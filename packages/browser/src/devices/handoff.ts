import {
  HANDOFF_ACK, HANDOFF_BUSY, HANDOFF_CANCEL, HANDOFF_DATA, HANDOFF_DONE, HANDOFF_HAVE, HANDOFF_HELLO, HANDOFF_MANIFEST, HANDOFF_OFFER, HANDOFF_PAKE,
  HANDOFF_PIECE_BYTES, HANDOFF_RELEASE, HANDOFF_REQUEST, HANDOFF_TIMINGS, HANDOFF_VERIFIED, HANDOFF_WINDOW,
  filePartDigest, filePartName, fromBase64Url, handoffAckFrame, handoffAttemptAllowed, handoffAttemptFailed, handoffAttemptSucceeded, handoffBusyFrame,
  handoffCancelFrame, handoffContext, handoffDataFrame, handoffDigest, handoffDoneFrame, handoffEphemeral, handoffHaveFrames, handoffHelloFrame,
  handoffManifestFrames, handoffOfferFrame, handoffPakeFrame, handoffReleaseFrame, handoffRequestFrame, handoffRetryAfter, handoffStreamKey,
  handoffVerifiedFrame, handoffVersions, newHandoffId, openHandoffPiece, readHandoffAck, readHandoffBusy, readHandoffCancel, readHandoffData,
  readHandoffDone, readHandoffHave, readHandoffHello, readHandoffManifest, readHandoffPake, readHandoffRelease, readHandoffTurnFrame,
  readHandoffVerified, sealHandoffPiece, signTurnRelease, toBase64Url, turnReleaseMessage, verify,
  type DeviceFrame, type HandoffBusyReason, type HandoffCancelReason, type HandoffHello, type HandoffPart, type TurnRelease,
  TURN_MAX,
} from "@ghostly/core";
import { sha256 } from "@noble/hashes/sha2.js";
import { HandoffPasswordError, startPakeGiver, startPakeTaker, type HandoffVerifier, type PakeGiver, type PakeTaker } from "./handoffPake";
import type { DeviceAttempts, DevicePatch, DeviceRecord, HeldFile, LeftFile, StoredDeviceState } from "./state";
import type { TurnOutcome } from "./turn";
import type { HandoffTakerFacts } from "./handoffWallets";

/*
 * The handoff (WISP 06 § The handoff): the whole state of a profile moves from the active device (A, the giver) to
 * another device of the set (B, the taker), which then takes the turn. One handoff at a time per profile.
 *
 * The two sides are two classes, each driven by the frames of the device link and by the person's buttons, and each
 * reaching storage, the network and the engine only through its ports, so the state table can be run in a test cell
 * by cell. What the ports are on a device:
 *
 * - `HandoffLinks`: the device links (`links.ts`): which link is live, a frame to it, its session's transcript hash.
 * - `HandoffRecords`: the device record (`store.ts`), every change durable before the next step.
 * - `HandoffSource` (A): the profile's files and, for pass 2, the rest of it as one part, read without writing.
 * - `HandoffStaging` (B): the staging namespace a pull writes into, and the registry pointer that installs it.
 *
 * The giver runs in two places. While A is active (pass 1) it is the engine's (`GhostlyNode`), and A goes on sending
 * and receiving for the person. At quiesce A stops its engine without a word to any contact, writes `releasing` and
 * reloads into the gate; from there the giver is device-link-only mode's, which opens the profile's database read
 * only for pass 2, signs the release only after it wrote `standby`, and then stays to answer a taker that asks for
 * the release again.
 *
 * The taker runs in device-link-only mode, as B is a standby. It writes pass 1 into the staging namespace while A
 * stays live, restores pass 2 there before it says `handoff-verified` (so a crash after that loses nothing it needs),
 * and on the release writes `taking`, installs (the record under both names, then one pointer) and reloads. The page
 * that starts under the new name finishes the take: the turn record of `N + 1`, the settle wait, `active` only on
 * `mine`.
 */

/**
 * The step a giver's record notes, before the failure's name, when pass 2 stopped and it went back to active
 * (`stopped:stalled`): its screen says so after the reload.
 */
export const STOPPED_STEP = "stopped:";
/** The failures of pass 2 that the screen shows again after the reload. */
const SHOWN_AFTER_RELOAD = new Set<HandoffFailure>(["stalled", "dropped", "damaged", "cancelled"]);
/** A take the taker's settle wait gave up waiting for. */
const NO_ANSWER: unique symbol = Symbol("no answer");

/** Why a handoff did not happen, as the screens say it. */
export type HandoffFailure =
  | "unreachable" | "password" | "locked-out" | "refused" | "payment" | "call" | "busy" | "older" | "room" | "damaged" | "dropped"
  | "wallet" | "loading" | "mainnet" | "expiry" | "cancelled" | "turn" | "offline" | "version" | "failed" | "woken"
  /** The copy stopped: nothing came from the other device for `HANDOFF_TIMINGS.stuckMs`. */
  | "stalled"
  /** The taker installed, and no settled read of the turn came within `HANDOFF_TIMINGS.settleMs`: Try again. */
  | "settle";

/** What the screens show of a handoff on either device. Never a secret. */
export interface HandoffView {
  role: "giver" | "taker";
  /** The other device's name. */
  device: string;
  /** The other device's signing key, base64url. */
  key: string;
  step: "offer" | "connecting" | "authorizing" | "copying" | "paused" | "ready" | "rest" | "checking" | "switching" | "settling" | "finishing" | "done" | "failed";
  /** Which pass the bytes are of. */
  pass?: 1 | 2;
  /** Bytes confirmed, of `total`. */
  bytes: number;
  total: number;
  /** Bytes of the files left for later. */
  later?: number;
  failure?: HandoffFailure;
  /** Seconds until the other device may try again (`locked-out`). */
  retry?: number;
  /** A push from the active device, waiting for Use here: about this many bytes. */
  offer?: number;
  /** The taker runs a newer database: the giver must update before it takes the profile back. */
  newer?: true;
  /** A failure about one wallet (`expiry`, `mainnet`, `loading`): its type, and for `expiry` when its coins expire. */
  wallet?: string;
  expiresAt?: number;
  /** The giver: the wallets that stay on this device, and when their coins expire (WISP 06 § Wallets that stay home). */
  stays?: HandoffStay[];
  /** The other device's link was down and a wake push went to it: "Open Ghostly on <device> and keep it open." */
  woken?: true;
}

/** A wallet that stays on its home device in this handoff. */
export interface HandoffStay { type: string; network: string; expiresAt?: number }

export interface HandoffLinks {
  /** The link to that device is open and carries `handoff/1`. */
  live(key: string): boolean;
  send(key: string, frame: DeviceFrame): void;
  /** The open session's transcript hash (lower-case hex), or undefined while none is open. */
  transcript(key: string): string | undefined;
  /**
   * Wakes that device for the handoff when its link is down (WISP 06 § Push and the phone): a push to the subscription
   * it shared over the link. `sent` when the push service took one. Absent where nothing can be woken.
   */
  wake?(key: string): Promise<"sent" | "none" | "skipped" | "failed">;
}

/** How long a taker that woke the other device waits for its link: the person has to see the notice and open Ghostly there. */
export const WOKEN_CONNECT_MS = 3 * 60_000;

export interface HandoffRecords {
  read(): Promise<DeviceRecord | null>;
  amend(patch: DevicePatch): Promise<DeviceRecord>;
  move(to: StoredDeviceState, patch?: DevicePatch): Promise<DeviceRecord>;
}

/** A file of the profile, by id, with its size and SHA-256 (base64url). */
export interface HandoffFile { id: string; size: number; sha256: string }

/** What the giver reads of the profile. Pass 2 reads it with the database open read only. */
export interface HandoffSource {
  /** Every file whose bytes are on this device. */
  files(): Promise<HandoffFile[]>;
  read(id: string, offset: number, length: number): Promise<Uint8Array>;
  /** Everything else of the profile, as the part `db/peer`: its database, its local keys and wallet databases. */
  bundle(): Promise<Uint8Array>;
}

/** Where a pull writes: a staging namespace, never the live profile (WISP 06 § Installing the staged state). */
export interface HandoffStaging {
  /** The staged peer database's name. */
  readonly database: string;
  /** The files this staging holds whole and checked. */
  held(): Promise<HandoffFile[]>;
  /** A file is about to be written from its start. */
  begin(id: string): Promise<void>;
  append(id: string, offset: number, bytes: Uint8Array): Promise<void>;
  /** A file is whole and its digest checked: kept, and listed by `held`. */
  finish(file: HandoffFile): Promise<void>;
  /** A file that failed its check. */
  discard(id: string): Promise<void>;
  /** A file the frozen copy of this device holds, copied in under `file.id`. */
  copyHeld(fromId: string, file: HandoffFile): Promise<void>;
  /** A file already staged under another id, copied under `file.id` (two records of one file). */
  copyStaged(fromId: string, file: HandoffFile): Promise<void>;
  /** The rest of the profile written into the staged database and keys; each file's record points at its bytes. */
  restore(bundle: Uint8Array, files: HandoffFile[]): Promise<void>;
  /** The staged database and keys go; the staged files stay for a later try. */
  dropRest(): Promise<void>;
  /** Bytes this device can still take, or null when it does not say. */
  room(): Promise<number | null>;
}

export interface HandoffStagingHost {
  /** The staging namespace of this database name, or a new one. */
  open(database?: string): Promise<HandoffStaging>;
  /** The registry entry of `old` points at `staged`: one write. */
  install(old: string, staged: string): Promise<void>;
  /** And back. */
  revert(old: string, staged: string): Promise<void>;
  /** A namespace goes for good: its database, files and local keys. */
  drop(database: string): Promise<void>;
}

/** Why the giver cannot hand over now, as this device's own screens say it. */
export type LocalBusy = "wallet" | "payment" | "call" | "loading" | "mainnet" | "expiry";

/** Why, and about which wallet: its type, and for `expiry` when its coins expire. */
export interface BusyReport { why: LocalBusy; wallet?: string; expiresAt?: number }

const reportOf = (busy: LocalBusy | BusyReport | null): BusyReport | null => (busy === null ? null : typeof busy === "string" ? { why: busy } : busy);

/** What a device says about itself in `handoff-hello`, but its key for this session. */
export type HandoffSelf = Omit<HandoffHello, "v" | "e" | "id" | "later">;

interface Common {
  /** This device's signing key, and a signer for it. */
  ownKey: Uint8Array;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
  /** The turn address of the current device set. */
  turnAddress: Uint8Array;
  links: HandoffLinks;
  records: HandoffRecords;
  self(): Promise<HandoffSelf>;
  now?(): number;
  /** The view changed. */
  onChange?(view: HandoffView | null): void;
}

export interface GiverPorts extends Common {
  source: HandoffSource;
  /** The profile's password proof verifier; null when it has none (a pull is then refused, a push still works). */
  verifier(): Promise<HandoffVerifier | null>;
  /**
   * Why this device cannot hand over now, or null: money in a wallet, a payment going through, a call on, or wallets
   * not read yet. Said to the person on this device; the other device is told only that it is busy.
   */
  busy(taker?: HandoffTakerFacts): Promise<LocalBusy | BusyReport | null>;
  /** The wallets that stay on this device in a handoff to `taker` (shown on this device's screen). */
  staying?(taker: HandoffTakerFacts): Promise<HandoffStay[]>;
  /**
   * Pass 1 is done: freeze. Stops the engine without a word to any contact, writes `releasing` with `patch`, and
   * reloads into the gate. Only while the engine runs (pass 1). The wallets follow their plan for `taker`.
   */
  quiesce?(patch: DevicePatch, taker?: HandoffTakerFacts): Promise<void>;
  /**
   * Deletes the Breez databases of the wallets that moved (WISP 06 § Wallets), once the release is written. Each is
   * named from its phrase, so a device that took the profile back later would reopen a stale one.
   */
  dropDatabases?(names: string[]): Promise<void>;
  /** Pass 2 failed or was cancelled: the device writes `active` and starts again (device-link-only mode). */
  backToActive?(stopped?: { failure: HandoffFailure; peer: string }): Promise<void>;
  /** A notice on this device: a pull with a wrong password. */
  notice?(kind: "wrong-password", device: string): void;
}

export interface TakerPorts extends Common {
  staging: HandoffStagingHost;
  /** Reload into the gate. */
  reload(): void;
  /** The turn: the take after install (`TurnKeeper.take`). */
  take?(release: TurnRelease, turn: number): Promise<TurnOutcome | null>;
  /** Copies the device signing key under the staged name, and the record under both (`installDeviceRecord`). */
  install(staged: string, patch: DevicePatch): Promise<void>;
  /** After a take that lost: the old name's record goes back to `standby` (the pointer moves back too, see `staging`). */
  standbyUnder(database: string): Promise<void>;
  /** The staged name's record and key go (a take that lost), or the old name's (a take that won). */
  forget(database: string): Promise<void>;
}

const name = (record: DeviceRecord, key: string): string => record.deviceSet.find((slot) => slot?.key === key)?.name ?? "";
const slotOf = (record: DeviceRecord, key: string): number => record.deviceSet.findIndex((slot) => slot?.key === key);

/**
 * The wrong passwords the giver counted, carried with its release (`a`), kept with this device's own: for each device,
 * the higher count and the later lock-out. A value that is no count is left out.
 */
function mergedAttempts(record: DeviceRecord, carried: unknown): DevicePatch {
  if (!carried || typeof carried !== "object" || Array.isArray(carried)) return {};
  const merged: Record<string, DeviceAttempts> = { ...record.handoffAttempts };
  for (const [key, value] of Object.entries(carried as Record<string, unknown>).slice(0, 16)) {
    const a = value as Partial<DeviceAttempts> | null;
    if (!/^[A-Za-z0-9_-]{43}$/.test(key) || !a || !Number.isSafeInteger(a.total) || (a.total as number) < 0 || !Array.isArray(a.recent) || !a.recent.every((at) => Number.isSafeInteger(at) && at >= 0)) continue;
    const mine = merged[key];
    const until = Math.max(mine?.until ?? 0, Number.isSafeInteger(a.until) ? a.until as number : 0);
    merged[key] = { recent: [...new Set([...(mine?.recent ?? []), ...a.recent])].sort((x, y) => x - y).slice(-16), total: Math.min(1_000_000, Math.max(mine?.total ?? 0, a.total as number)), ...(until ? { until } : {}) };
  }
  return Object.keys(merged).length ? { handoffAttempts: Object.fromEntries(Object.entries(merged).slice(0, 16)) } : {};
}

/** One session of a handoff with the other device: its own X25519 key, the other's hello, and the stream key. */
class Session {
  readonly ephemeral = handoffEphemeral();
  sent = false;
  peer: HandoffHello | null = null;
  key: Uint8Array | null = null;
  constructor(readonly transcript: string) {}
}

/** File parts, one per digest (two records of one file are one part). */
function fileParts(files: readonly HandoffFile[]): HandoffPart[] {
  const byDigest = new Map<string, HandoffPart>();
  for (const file of files) if (!byDigest.has(file.sha256)) byDigest.set(file.sha256, [filePartName(file.sha256), file.size, file.sha256]);
  return [...byDigest.values()];
}

/** Which file ids each digest is. */
function idsOf(files: readonly HandoffFile[]): Record<string, string[]> {
  const ids: Record<string, string[]> = {};
  for (const file of files) (ids[file.sha256] ??= []).push(file.id);
  for (const list of Object.values(ids)) list.sort();
  return ids;
}

/** Files over the taker's limit stay behind for later (WISP 06 § User experience, "Bring large files later"). */
const isLater = (file: { size: number }, later: number | undefined): boolean => !!later && later > 0 && file.size > later;

// -- sending and receiving parts ------------------------------------------------------------------------------------

interface OutPart { name: string; size: number; read(offset: number, length: number): Promise<Uint8Array> }

/**
 * Sends parts in sealed pieces, at most `HANDOFF_WINDOW` unconfirmed. `stop()` ends a run (the link dropped, a new
 * plan came): it returns `stopped`, and a new run starts from what the taker said it holds.
 */
class PartSender {
  private run = 0;
  private outstanding: { part: string; end: number }[] = [];
  private wake: (() => void)[] = [];
  confirmed = new Map<string, number>();
  lastProgress = 0;

  constructor(private readonly now: () => number) {}

  async send(parts: OutPart[], from: Record<string, number>, key: Uint8Array, out: (frame: DeviceFrame) => void): Promise<"done" | "stopped"> {
    const run = ++this.run;
    this.outstanding = [];
    this.lastProgress = this.now();
    for (const part of parts) this.confirmed.set(part.name, Math.min(from[part.name] ?? 0, part.size));
    for (const part of parts) {
      let offset = this.confirmed.get(part.name) ?? 0;
      while (offset < part.size) {
        while (this.outstanding.length >= HANDOFF_WINDOW && run === this.run) await new Promise<void>((resolve) => this.wake.push(resolve));
        if (run !== this.run) return "stopped";
        const piece = await part.read(offset, Math.min(HANDOFF_PIECE_BYTES, part.size - offset));
        if (run !== this.run) return "stopped";
        if (!piece.length) throw new Error("A part is shorter than it says");
        try { out(handoffDataFrame(part.name, offset, sealHandoffPiece(key, part.name, offset, piece))); } catch { this.stop(); return "stopped"; }
        offset += piece.length;
        this.outstanding.push({ part: part.name, end: offset });
      }
    }
    while (this.outstanding.length && run === this.run) await new Promise<void>((resolve) => this.wake.push(resolve));
    return run === this.run ? "done" : "stopped";
  }

  /** Pieces are out, and none was confirmed for `ms`. */
  stalled(ms: number): boolean {
    return this.outstanding.length > 0 && this.now() - this.lastProgress > ms;
  }

  ack(part: string, offset: number): void {
    if ((this.confirmed.get(part) ?? 0) < offset) { this.confirmed.set(part, offset); this.lastProgress = this.now(); }
    const before = this.outstanding.length;
    this.outstanding = this.outstanding.filter((o) => !(o.part === part && o.end <= offset));
    if (this.outstanding.length !== before) this.notify();
  }

  stop(): void {
    this.run += 1;
    this.notify();
  }

  private notify(): void {
    for (const resolve of this.wake.splice(0)) resolve();
  }
}

/** A part being received: where its bytes go, how many arrived, and its running digest. */
interface InPart {
  name: string;
  size: number;
  sha256: string;
  got: number;
  hash: ReturnType<typeof sha256.create>;
  /** A file: the id it is written under. Absent for `db/peer`, kept in memory. */
  id?: string;
  chunks?: Uint8Array[];
  retried?: boolean;
  done?: boolean;
}

// -- the giver ------------------------------------------------------------------------------------------------------

type GiverPhase = "idle" | "offered" | "authorizing" | "pass1" | "quiescing" | "pass2" | "released" | "failed";

/**
 * The active device's side (WISP 06 § States and events, "A is"). Made by the engine while A runs; made again by
 * device-link-only mode from the device record after the reload into the gate (`resume`).
 */
export class HandoffGiver {
  private phase: GiverPhase = "idle";
  private peer: string | null = null;
  private id: string | null = null;
  private turn = 0;
  private sessions = new Map<string, Session>();
  private secret: Uint8Array | null = null;
  private pake: PakeGiver | null = null;
  private have: { d: Set<string>; p: Record<string, number> } | null = null;
  private haveBuffer: { d: string[]; p: Record<string, number> } = { d: [], p: {} };
  private sender: PartSender;
  private planned: { total: number; later: number; parts: HandoffPart[] } | null = null;
  private failure: HandoffFailure | undefined;
  /** What a failure about one wallet names. */
  private failed: { wallet?: string; expiresAt?: number } = {};
  private stays: HandoffStay[] = [];
  private retry: number | undefined;
  private newer = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private self: HandoffSelf | null = null;
  private stopped = false;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly ports: GiverPorts) {
    this.now = ports.now ?? Date.now;
    this.sender = new PartSender(this.now);
  }

  /**
   * After the reload into the gate: what the device record says this device is doing. A `releasing` device with a
   * handoff noted goes on with pass 2; one that cannot (the note is gone, or too old) is active again. A `standby`
   * that released keeps the release, to send it again to a taker that asks.
   */
  async resume(): Promise<void> {
    const record = await this.ports.records.read();
    // A standby that released and could not delete the Breez databases of the wallets that moved tries again.
    if (record?.state === "standby" && record.breezDatabases?.length) await this.dropBreez();
    const handoff = record?.handoff;
    // Back to active after pass 2 stopped: the screen says why once, and the note goes.
    if (record?.state === "active" && handoff?.role === "releasing" && handoff.step.startsWith(STOPPED_STEP) && handoff.peer) {
      const failure = handoff.step.slice(STOPPED_STEP.length) as HandoffFailure;
      this.peer = handoff.peer; this.deviceName = name(record, handoff.peer); this.failure = SHOWN_AFTER_RELOAD.has(failure) ? failure : "dropped"; this.phase = "idle";
      await this.ports.records.amend({ handoff: undefined }).catch(() => {});
      this.changed();
      return;
    }
    if (!record || handoff?.role !== "releasing" || !handoff.peer || !handoff.id) return;
    this.peer = handoff.peer; this.id = handoff.id; this.turn = handoff.from ?? record.turn;
    this.secret = handoff.secret ? fromBase64Url(handoff.secret) : null;
    this.newer = handoff.newer === true;
    if (record.state === "standby" && handoff.release) { this.phase = "released"; this.changed(); return; }
    if (record.state !== "releasing") return;
    const fresh = handoff.at !== undefined && this.now() - handoff.at < HANDOFF_TIMINGS.verifiedMs;
    if (!this.secret || !fresh) { await this.backToActive(); return; }
    this.phase = "pass2";
    this.passDone = false;
    this.changed();
    // The taker comes back on the new session; if it does not, this device is the active one again.
    this.arm(HANDOFF_TIMINGS.idleMs * 2, () => this.backToActive());
    this.watchStuck();
    if (this.ports.links.live(this.peer)) this.linkChanged(this.peer, true);
  }

  view(): HandoffView | null {
    if (this.phase === "idle" || !this.peer) return this.failure && this.peer ? { role: "giver", device: this.deviceName, key: this.peer, step: "failed", bytes: 0, total: 0, failure: this.failure, ...(this.retry ? { retry: this.retry } : {}), ...this.failedDetail() } : null;
    const confirmed = [...this.sender.confirmed.values()].reduce((a, b) => a + b, 0);
    const step: HandoffView["step"] = this.phase === "offered" ? "connecting" : this.phase === "authorizing" ? "authorizing" : this.paused ? "paused" : this.phase === "pass1" ? "copying"
      : this.phase === "quiescing" ? "ready" : this.phase === "pass2" ? "rest" : this.phase === "released" ? "switching" : "failed";
    return {
      role: "giver", device: this.deviceName, key: this.peer, step, bytes: confirmed, total: this.planned?.total ?? 0,
      ...(this.phase === "pass1" ? { pass: 1 as const } : this.phase === "pass2" ? { pass: 2 as const } : {}),
      ...(this.planned?.later ? { later: this.planned.later } : {}), ...(this.failure ? { failure: this.failure, ...this.failedDetail() } : {}), ...(this.newer ? { newer: true as const } : {}),
      ...(this.stays.length ? { stays: this.stays } : {}),
    };
  }

  private failedDetail(): Pick<HandoffView, "wallet" | "expiresAt"> {
    return { ...(this.failed.wallet ? { wallet: this.failed.wallet } : {}), ...(this.failed.expiresAt !== undefined ? { expiresAt: this.failed.expiresAt } : {}) };
  }

  /** What the giver knows of the device it would hand the profile to: its key, and its kind and SDK pins once it said hello. */
  private takerFacts(key: string): HandoffTakerFacts {
    const hello = this.sessions.get(key)?.peer;
    return { key, ...(hello ? { kind: hello.kind, pins: hello.pins } : {}) };
  }

  /** The Breez databases noted at quiesce, deleted now that the release is written; the note goes once they are. */
  private async dropBreez(): Promise<void> {
    const record = await this.ports.records.read().catch(() => null);
    const names = record?.breezDatabases;
    if (!record || !names?.length || !this.ports.dropDatabases || record.state !== "standby") return;
    try {
      await this.ports.dropDatabases(names);
      await this.ports.records.amend({ breezDatabases: undefined });
    } catch { /* tried again at the next start, and on handoff-done */ }
  }

  /** The failure a busy report gives, with the wallet it names. */
  private failWith(report: BusyReport): HandoffFailure {
    this.failed = { ...(report.wallet ? { wallet: report.wallet } : {}), ...(report.expiresAt !== undefined ? { expiresAt: report.expiresAt } : {}) };
    return report.why;
  }

  private deviceName = "";

  /** "Move to <device>" (a push): the offer goes out, and the taker answers with a request once the person agrees. */
  push(key: string): Promise<HandoffView | null> {
    return this.exclusive(async () => {
      // A pull that waits for its password proof gives way to the person at this device, who moves the profile now.
      if (this.phase === "authorizing") { this.out(handoffCancelFrame("cancelled")); this.reset("cancelled"); }
      if (this.phase !== "idle" && this.phase !== "failed") throw new Error("handoff-busy: Another move is in progress.");
      const record = await this.ports.records.read();
      if (!record || record.state !== "active") throw new Error("handoff-refused: Only the active device moves the profile.");
      if (slotOf(record, key) < 0) throw new Error("handoff-refused: That device is not one of this profile's.");
      const busy = reportOf(await this.ports.busy(this.takerFacts(key)));
      // The wallet a refusal is about goes in the message, between colons, for the screen to name it.
      if (busy) throw new Error(`handoff-${busy.why}:${busy.wallet ? `${busy.wallet}:` : ""} This device cannot move the profile now.`);
      if (!this.ports.links.live(key)) {
        // A phone that suspended the app: a wake push asks the person to open Ghostly there (WISP 06 § Push and the phone).
        const woken = await this.ports.links.wake?.(key).catch(() => "failed" as const);
        if (woken === "sent" || woken === "skipped") throw new Error("handoff-woken: Open Ghostly on that device and keep it open.");
        throw new Error("handoff-unreachable: That device must be on, with Ghostly open.");
      }
      this.begin(key, newHandoffId(), record);
      this.stays = await this.ports.staying?.(this.takerFacts(key)).catch(() => []) ?? [];
      this.phase = "offered";
      const files = await this.ports.source.files();
      const bytes = fileParts(files).reduce((sum, part) => sum + part[1], 0);
      this.out(handoffOfferFrame(this.turn, this.id!, bytes));
      this.arm(HANDOFF_TIMINGS.idleMs * 5, () => this.fail("cancelled", "timeout"));
      this.changed();
      return this.view();
    });
  }

  /** Cancel: before quiesce nothing changed; in pass 2 the device is active again. Never once the release is signed. */
  cancel(): Promise<void> {
    return this.exclusive(async () => {
      if (this.phase === "idle" || this.phase === "released" || this.phase === "failed") return;
      if (this.peer && this.ports.links.live(this.peer)) this.out(handoffCancelFrame("cancelled"));
      if (this.phase === "pass2") { await this.backToActive(); return; }
      this.reset("cancelled");
    });
  }

  /** "Let <device> try again": the count of wrong passwords of that device starts again. */
  async allowAgain(key: string): Promise<void> {
    const record = await this.ports.records.read();
    if (!record?.handoffAttempts?.[key]) return;
    const { [key]: _, ...rest } = record.handoffAttempts;
    await this.ports.records.amend({ handoffAttempts: rest });
  }

  /** The link to `key` opened (a new session) or closed. */
  linkChanged(key: string, live: boolean): void {
    void this.exclusive(async () => {
      if (key !== this.peer) return;
      if (!live) {
        this.sender.stop();
        // Before quiesce a drop pauses (the taker says what it holds when it is back). In pass 2 this device is frozen:
        // a link that does not come back within a minute makes it the active one again (WISP 06 § States and events).
        if (this.phase === "authorizing") this.reset("dropped");
        if (this.phase === "pass2") this.arm(HANDOFF_TIMINGS.idleMs, () => this.backToActive());
        this.changed();
        return;
      }
      // A session of an ongoing handoff: say hello, with the handoff's id.
      if (this.phase === "pass1" || this.phase === "pass2") {
        const session = this.sessionFor(key);
        if (session) this.sendHello(key, session);
      }
    });
  }

  stop(): void {
    this.stopped = true;
    this.sender.stop();
    if (this.timer) clearTimeout(this.timer);
    clearInterval(this.stallTimer);
    clearInterval(this.stuckTimer);
  }

  /** When the taker last sent anything on this handoff: a frame of any kind, acknowledgements included. */
  private heardAt = 0;
  private stuckTimer: ReturnType<typeof setInterval> | undefined;
  /** Pass 2's parts are all confirmed: from here its own wait (`verifiedMs`) applies. */
  private passDone = false;
  /**
   * The copy may not wait without bound (WISP 06 § States and events): nothing from the taker for `stuckMs` in pass 1,
   * or in pass 2 before its parts are all confirmed, and the handoff fails as `stalled`, the taker told when the link
   * lets it. In pass 1 this device is still the active one; in pass 2 it never signed a release, so it is again.
   */
  private watchStuck(): void {
    clearInterval(this.stuckTimer);
    this.heardAt = this.now();
    this.stuckTimer = setInterval(() => void this.exclusive(async () => {
      const copying = this.phase === "pass1" || (this.phase === "pass2" && !this.passDone);
      if (!copying || this.stopped) { clearInterval(this.stuckTimer); return; }
      if (this.now() - this.heardAt < HANDOFF_TIMINGS.stuckMs) return;
      clearInterval(this.stuckTimer);
      if (this.peer && this.ports.links.live(this.peer)) this.out(handoffCancelFrame("stalled"));
      if (this.phase === "pass2") { this.failure = "stalled"; await this.backToActive(); return; }
      this.reset("stalled");
    }), HANDOFF_TIMINGS.stuckMs / 8);
  }

  receive(from: string, frame: DeviceFrame): Promise<void> {
    return this.exclusive(() => this.handle(from, frame)).catch(() => {});
  }

  private async handle(from: string, frame: DeviceFrame): Promise<void> {
    if (this.stopped) return;
    // Only this handoff's own frames count as the taker being there.
    if (from === this.peer && frame.t.startsWith("handoff-")) this.heardAt = this.now();
    switch (frame.t) {
      case HANDOFF_HELLO: return this.onHello(from, frame);
      case HANDOFF_REQUEST: return this.onRequest(from, frame);
      case HANDOFF_PAKE: return this.onPake(from, frame);
      case HANDOFF_HAVE: return this.onHave(from, frame);
      case HANDOFF_ACK: {
        const ack = readHandoffAck(frame);
        if (ack && from === this.peer) { this.sender.ack(ack.part, ack.offset); this.changedSoon(); }
        return;
      }
      case HANDOFF_VERIFIED: return this.onVerified(from, frame);
      case HANDOFF_DONE: {
        if (from !== this.peer || readHandoffDone(frame) === null || this.phase !== "released") return;
        await this.dropBreez();
        await this.ports.records.amend({ handoff: undefined });
        this.phase = "idle"; this.peer = null;
        this.changed();
        return;
      }
      case HANDOFF_CANCEL: {
        const why = readHandoffCancel(frame);
        if (from !== this.peer || why === null) return;
        // The taker heard nothing from here for too long: both screens say the copy stopped.
        const failure: HandoffFailure = why === "stalled" ? "stalled" : "cancelled";
        if (this.phase === "pass2") { this.failure = failure; await this.backToActive(); return; }
        if (this.phase !== "released") this.reset(failure);
        return;
      }
      default: return;
    }
  }

  private async onHello(from: string, frame: DeviceFrame): Promise<void> {
    const hello = readHandoffHello(frame);
    const session = hello && this.freshFor(from, hello);
    if (!hello || !session) return;
    session.peer = hello;
    this.sendHello(from, session);
    // The same handoff in a new session: its key comes from the first session's.
    if (from === this.peer && hello.id === this.id && this.secret && (this.phase === "pass1" || this.phase === "pass2")) {
      session.key = handoffStreamKey(session.ephemeral.secret, fromBase64Url(hello.e), this.secret, session.transcript);
    }
  }

  private async onRequest(from: string, frame: DeviceFrame): Promise<void> {
    const request = readHandoffTurnFrame(frame);
    if (!request || frame.t !== HANDOFF_REQUEST) return;
    const record = await this.ports.records.read();
    if (!record) return;
    // Released already: the same release again, to the taker it names (WISP 06 § States and events).
    if (this.phase === "released" || (record.state === "standby" && record.handoff?.release)) {
      const release = record.handoff?.release;
      if (release && release.to === from && request.id === record.handoff?.id) this.out({ ...handoffReleaseFrame(release), ...(record.handoffAttempts ? { a: record.handoffAttempts } : {}) }, from);
      return;
    }
    const busy = (why: HandoffBusyReason, retry = 30) => this.out(handoffBusyFrame(why, retry), from);
    // Frozen for a handoff to another device (pass 2): one handoff at a time.
    if (record.state !== "active") { if (this.phase !== "idle" && this.phase !== "failed") busy("handoff"); return; }
    if (slotOf(record, from) < 0) return busy("refused", 0);
    const pushed = this.phase === "offered" && from === this.peer && request.id === this.id;
    if (this.phase !== "idle" && this.phase !== "failed" && !pushed) return busy("handoff");
    const session = this.sessionFor(from);
    if (!session?.peer) return busy("handoff", 5);
    // Why is this device's own business (money, a call): the other device is told it is busy, nothing more.
    const local = reportOf(await this.ports.busy(this.takerFacts(from)));
    if (local) {
      // Said on this device, which a pull may find unattended: the screen there names what keeps the profile here.
      if (!pushed) { this.peer = from; this.deviceName = name(record, from); this.failure = this.failWith(local); this.changed(); }
      return busy("handoff");
    }
    const self = await this.ownSelf();
    const versions = handoffVersions(self, session.peer);
    if (versions.older) return busy("older", 0);
    if (!pushed) {
      const allowed = handoffAttemptAllowed(record.handoffAttempts?.[from], this.now());
      if (allowed !== "ok") return busy(allowed, allowed === "refused" ? 0 : handoffRetryAfter(record.handoffAttempts?.[from], this.now()));
      // A pull is counted as a try when it is asked for, before anything is answered, and taken back only when its
      // proof holds: a device that asks and never proves (holding this device in `authorizing`) spends its tries.
      await this.ports.records.amend({ handoffAttempts: { ...record.handoffAttempts, [from]: handoffAttemptFailed(record.handoffAttempts?.[from], this.now()) } });
      this.begin(from, request.id, record);
      this.stays = await this.ports.staying?.(this.takerFacts(from)).catch(() => []) ?? [];
      this.newer = versions.newerTaker;
      this.phase = "authorizing";
      this.arm(HANDOFF_TIMINGS.idleMs, () => this.reset("dropped"));
      this.changed();
      return;
    }
    // A push the person agreed to on the taker: no password (the person pressed the button here, unlocked).
    this.newer = versions.newerTaker;
    this.authorized(session, new Uint8Array());
  }

  private async onPake(from: string, frame: DeviceFrame): Promise<void> {
    const pake = readHandoffPake(frame);
    if (!pake || from !== this.peer || this.phase !== "authorizing") return;
    const session = this.sessionFor(from);
    if (!session?.peer) return;
    if (pake.n === 1) {
      if (this.pake) return;
      const verifier = await this.ports.verifier();
      if (!verifier) { this.out(handoffBusyFrame("refused", 0), from); this.reset("refused"); return; }
      // The try was counted with the request (`onRequest`).
      try { this.pake = await startPakeGiver(verifier, pake.m!); } catch { this.wrongPassword(from); return; }
      this.out(handoffPakeFrame({ n: 2, m: this.pake.second }), from);
      this.arm(HANDOFF_TIMINGS.idleMs, () => this.reset("dropped"));
      return;
    }
    if (pake.n !== 3 || !this.pake) return;
    const giver = this.pake;
    this.pake = null;
    if (pake.wrong) { this.wrongPassword(from); return; }
    let key: Uint8Array;
    try { key = await giver.finish(pake.m!, pake.c!, handoffContext(this.ports.turnAddress, this.ports.ownKey, fromBase64Url(from), session.transcript)); }
    catch (error) { if (error instanceof HandoffPasswordError) { this.wrongPassword(from); return; } throw error; }
    const record = await this.ports.records.read();
    await this.ports.records.amend({ handoffAttempts: { ...record?.handoffAttempts, [from]: handoffAttemptSucceeded() } });
    this.authorized(session, key);
  }

  private wrongPassword(from: string): void {
    this.out(handoffCancelFrame("password"), from);
    this.ports.notice?.("wrong-password", this.deviceName);
    this.reset("password");
  }

  /** The proof held (a pull) or the person agreed (a push): the first session's key, and pass 1. */
  private authorized(session: Session, k: Uint8Array): void {
    session.key = handoffStreamKey(session.ephemeral.secret, fromBase64Url(session.peer!.e), k, session.transcript);
    this.secret = session.key;
    this.phase = "pass1";
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.watchStuck();
    this.changed();
  }

  private async onHave(from: string, frame: DeviceFrame): Promise<void> {
    const have = readHandoffHave(frame);
    if (!have) return;
    // The handoff this belongs to is over here (this device went back to active): the taker is told, and stops.
    if (this.phase === "idle" || this.phase === "failed") { this.out(handoffCancelFrame("cancelled"), from); return; }
    if (from !== this.peer || (this.phase !== "pass1" && this.phase !== "pass2")) return;
    this.haveBuffer.d.push(...have.d);
    Object.assign(this.haveBuffer.p, have.p);
    if (have.more) return;
    this.have = { d: new Set(this.haveBuffer.d), p: this.haveBuffer.p };
    this.haveBuffer = { d: [], p: {} };
    const session = this.sessionFor(from);
    if (!session?.key || !session.peer) return;
    void this.sendPass(session).catch(() => this.reset("failed"));
  }

  /** The manifest of this pass and its parts, from what the taker said it holds. */
  private async sendPass(session: Session): Promise<void> {
    const pass = this.phase === "pass2" ? 2 : 1;
    this.passDone = false;
    // Pass 2 is under way: its own wait (no `handoff-verified` within ten minutes) replaces the wait for the taker.
    if (pass === 2) this.arm(HANDOFF_TIMINGS.verifiedMs, () => this.backToActive());
    const later = session.peer!.later;
    const files = await this.ports.source.files();
    const held = this.have!.d;
    const behind = fileParts(files.filter((file) => isLater(file, later) && !held.has(file.sha256)));
    const send = fileParts(files.filter((file) => !held.has(file.sha256) && !isLater(file, later)));
    const byDigest = new Map(files.map((file) => [file.sha256, file]));
    const out: OutPart[] = send.map(([partName, size, digest]) => {
      const file = byDigest.get(digest)!;
      return { name: partName, size, read: (offset, length) => this.ports.source.read(file.id, offset, length) };
    });
    const parts = [...send];
    if (pass === 2) {
      const bundle = await this.ports.source.bundle();
      const digest = toBase64Url(sha256(bundle));
      parts.push(["db/peer", bundle.length, digest]);
      out.push({ name: "db/peer", size: bundle.length, read: async (offset, length) => bundle.subarray(offset, offset + length) });
      this.bundlePart = ["db/peer", bundle.length, digest];
    }
    this.planned = { total: parts.reduce((sum, part) => sum + part[1], 0), later: behind.reduce((sum, part) => sum + part[1], 0), parts };
    this.laterParts = behind;
    this.allFiles = files;
    for (const frame of handoffManifestFrames({ pass, parts, later: behind, ids: idsOf(files) })) this.out(frame);
    this.paused = false;
    this.changed();
    // No confirmed bytes for two minutes: paused. The taker says what it holds when it can, and the copy goes on.
    clearInterval(this.stallTimer);
    this.stallTimer = setInterval(() => {
      if (!this.sender.stalled(HANDOFF_TIMINGS.stallMs)) return;
      this.sender.stop();
      this.paused = true;
      this.changed();
    }, Math.min(HANDOFF_TIMINGS.stallMs / 4, 30_000));
    const result = await this.sender.send(out, this.have!.p, session.key!, (frame) => this.out(frame));
    clearInterval(this.stallTimer);
    if (result !== "done" || this.stopped) return;
    this.passDone = pass === 2;
    this.changed();
    if (pass === 1) await this.exclusive(() => this.quiesce());
    else this.arm(HANDOFF_TIMINGS.verifiedMs, () => this.backToActive());
  }
  private bundlePart: HandoffPart | null = null;
  private paused = false;
  private stallTimer: ReturnType<typeof setInterval> | undefined;
  private laterParts: HandoffPart[] = [];
  private allFiles: HandoffFile[] = [];

  /** Pass 1 confirmed: freeze, write `releasing`, reload. The engine does the stopping (`GiverPorts.quiesce`). */
  private async quiesce(): Promise<void> {
    if (this.phase !== "pass1" || !this.ports.quiesce) return;
    const taker = this.takerFacts(this.peer!);
    const why = reportOf(await this.ports.busy(taker));
    if (why?.why === "payment") {
      // A payment is going through: up to 30 seconds, then "A payment is still going through".
      const deadline = this.now() + HANDOFF_TIMINGS.paymentMs;
      while (this.now() < deadline && reportOf(await this.ports.busy(taker))?.why === "payment") await new Promise((resolve) => setTimeout(resolve, 1_000));
      const still = reportOf(await this.ports.busy(taker));
      if (still) { this.out(handoffBusyFrame("handoff", 30)); this.reset(still.why === "payment" ? "payment" : this.failWith(still)); return; }
    } else if (why) { this.out(handoffBusyFrame("handoff", 30)); this.reset(this.failWith(why)); return; }
    this.phase = "quiescing";
    this.changed();
    await this.ports.quiesce({
      handoff: { role: "releasing", step: "pass2", id: this.id!, peer: this.peer!, from: this.turn, secret: toBase64Url(this.secret!), at: this.now(), ...(this.newer ? { newer: true as const } : {}) },
    }, taker);
  }

  private async onVerified(from: string, frame: DeviceFrame): Promise<void> {
    if (from !== this.peer || this.phase !== "pass2" || !this.bundlePart) return;
    const h = readHandoffVerified(frame, this.ports.turnAddress, this.turn + 1, fromBase64Url(from));
    if (!h) return;
    const later = new Set(this.laterParts.map((part) => part[2]));
    const parts = [...fileParts(this.allFiles.filter((file) => !later.has(file.sha256))), this.bundlePart];
    const expected = handoffDigest(this.turn + 1, this.ports.ownKey, fromBase64Url(from), parts);
    if (toBase64Url(expected) !== toBase64Url(h)) { this.out(handoffCancelFrame("damaged")); await this.backToActive(); return; }
    const record = await this.ports.records.read();
    if (!record || record.state !== "releasing") return;
    const fromSlot = record.ownSlot!, toSlot = slotOf(record, from);
    if (toSlot < 0) return;
    const signed = await signTurnRelease(this.ports.turnAddress, this.turn + 1, fromSlot, toSlot, fromBase64Url(from), h, (bytes) => this.ports.sign(bytes));
    const release = { turn: this.turn + 1, to: from, h: toBase64Url(h), s: toBase64Url(signed.signature) };
    const heldFiles: HeldFile[] = this.allFiles.map((file) => ({ sha256: file.sha256, size: file.size, id: file.id }));
    const leftFiles: LeftFile[] = this.allFiles.filter((file) => later.has(file.sha256)).map((file) => ({ sha256: file.sha256, size: file.size, where: file.id }));
    // Standby first, durably: from this write on this device is on standby, whether the frame below arrives or not.
    await this.ports.records.move("standby", {
      // What it gave is still here, frozen: the copy a forced takeover starts from if the taker is lost (WISP 06).
      releasedTurn: this.turn + 1, heldFiles, leftFiles, copy: "frozen",
      // The device it gave the turn to is the active one from here on, as the standby screen and a pull back name it.
      activeSlot: toSlot,
      // The stream key is of no more use: the release is sent again as it is, with no key.
      handoff: { ...record.handoff!, step: "released", release, at: this.now(), secret: undefined },
    });
    if (this.timer) clearTimeout(this.timer);
    this.phase = "released";
    // The wrong passwords counted here go with the profile: a device does not get fresh tries on each new active one.
    this.out({ ...handoffReleaseFrame(release), ...(record.handoffAttempts ? { a: record.handoffAttempts } : {}) });
    this.changed();
    // On standby durably: no Breez SDK runs here (the gate), and none of the wallets that moved opens here again.
    await this.dropBreez();
  }

  /** Pass 2 cannot finish: this device never signed a release, so it is the active one again. */
  private async backToActive(): Promise<void> {
    // Once: the wait for the taker and the wait for a copy that stopped can both end here.
    if (this.phase === "released" || this.phase === "failed") return;
    this.sender.stop();
    clearInterval(this.stuckTimer);
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.phase = "failed";
    this.failure ??= "dropped";
    this.changed();
    await this.ports.backToActive?.(this.peer && SHOWN_AFTER_RELOAD.has(this.failure) ? { failure: this.failure, peer: this.peer } : undefined);
  }

  private begin(key: string, id: string, record: DeviceRecord): void {
    this.peer = key; this.id = id; this.turn = record.turn; this.deviceName = name(record, key);
    this.failure = undefined; this.failed = {}; this.stays = []; this.retry = undefined; this.have = null; this.planned = null; this.pake = null; this.secret = null;
    this.sender = new PartSender(this.now);
  }

  private reset(failure: HandoffFailure): void {
    this.sender.stop();
    clearInterval(this.stallTimer);
    clearInterval(this.stuckTimer);
    this.paused = false;
    if (this.timer) clearTimeout(this.timer);
    this.phase = "idle";
    this.failure = failure;
    this.pake = null; this.have = null; this.planned = null; this.secret = null;
    this.changed();
  }

  private fail(failure: HandoffFailure, why: HandoffCancelReason): void {
    void this.exclusive(async () => {
      if (this.peer && this.ports.links.live(this.peer)) this.out(handoffCancelFrame(why));
      this.reset(failure);
    });
  }

  private arm(ms: number, then: () => void | Promise<void>): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.exclusive(async () => { await then(); }); }, ms);
  }

  private sessionFor(key: string): Session | null {
    const transcript = this.ports.links.transcript(key);
    if (!transcript) return null;
    let session = this.sessions.get(key);
    if (!session || session.transcript !== transcript) { session = new Session(transcript); this.sessions.set(key, session); }
    return session;
  }

  /** A hello with another key than the one this session heard: the other side began again; so does this session. */
  private freshFor(key: string, hello: { e: string }): Session | null {
    const session = this.sessionFor(key);
    if (session?.peer && session.peer.e !== hello.e) { const fresh = new Session(session.transcript); this.sessions.set(key, fresh); return fresh; }
    return session;
  }

  private async ownSelf(): Promise<HandoffSelf> {
    this.self ??= await this.ports.self();
    return this.self;
  }

  private sendHello(key: string, session: Session): void {
    if (session.sent) return;
    session.sent = true;
    void this.ownSelf().then((self) => {
      this.out(handoffHelloFrame({ ...self, v: 1, e: toBase64Url(session.ephemeral.publicKey), ...(key === this.peer && this.id ? { id: this.id } : {}) }), key);
    }).catch(() => { session.sent = false; });
  }

  private out(frame: DeviceFrame, to: string | null = this.peer): void {
    if (!to) return;
    try { this.ports.links.send(to, frame); } catch { /* the link dropped: the taker says what it holds when it is back */ }
  }

  private changedAt = 0;
  private changedSoon(): void {
    if (this.now() - this.changedAt > 250) this.changed();
  }
  private changed(): void {
    this.changedAt = this.now();
    try { this.ports.onChange?.(this.view()); } catch { /* a listener's own trouble */ }
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => {}).then(work);
    this.queue = run.catch(() => {});
    return run;
  }
}

// -- the taker ------------------------------------------------------------------------------------------------------

type TakerPhase = "idle" | "offer" | "connecting" | "authorizing" | "receiving" | "verified" | "installing" | "settling" | "unsettled" | "done" | "failed";

/** The states that take a handoff: a standby, and a replaced device ("Use here", WISP 06 § States and events). */
const takes = (state: DeviceRecord["state"]): boolean => state === "standby" || state === "superseded";

/**
 * The turn a taker hands over from: its own. A replaced device's own is the turn it was replaced at, below the active
 * device's; the turn that replaced it is in its mark (the highest sequence it saw), and a release names that one plus one.
 */
function takerTurn(record: DeviceRecord): number {
  if (record.state !== "superseded") return record.turn;
  const seen = Math.floor((record.seenSequence ?? 0) / 2 ** 20);
  return seen <= TURN_MAX ? Math.max(record.turn, seen) : record.turn;
}

/**
 * The taking device's side (WISP 06 § States and events, "B is"). Runs in device-link-only mode: B is a standby until
 * it holds the release, and `taking` from then until its settle read.
 */
export class HandoffTaker {
  private phase: TakerPhase = "idle";
  private peer: string | null = null;
  private id: string | null = null;
  private turn = 0;
  private sessions = new Map<string, Session>();
  private secret: Uint8Array | null = null;
  private pake: PakeTaker | null = null;
  private staging: HandoffStaging | null = null;
  private later = 0;
  private offerBytes = 0;
  private manifestBuffer: { parts: HandoffPart[]; later: HandoffPart[]; ids: Record<string, string[]> } = { parts: [], later: [], ids: {} };
  private pass: 1 | 2 = 1;
  private incoming = new Map<string, InPart>();
  /** Every file id of the giver, by digest, as the manifests said. */
  private ids: Record<string, string[]> = {};
  private behind = new Map<string, HandoffPart>();
  private failure: HandoffFailure | undefined;
  private retry: number | undefined;
  private deviceName = "";
  private bundle: { part: HandoffPart; bytes: Uint8Array } | null = null;
  private h: Uint8Array | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private self: HandoffSelf | null = null;
  private stopped = false;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private totals = { bytes: 0, total: 0 };

  constructor(private readonly ports: TakerPorts) {
    this.now = ports.now ?? Date.now;
  }

  view(): HandoffView | null {
    if (!this.peer) return null;
    if (this.phase === "idle") return this.failure ? { role: "taker", device: this.deviceName, key: this.peer, step: "failed", bytes: 0, total: 0, failure: this.failure, ...(this.retry ? { retry: this.retry } : {}), ...(this.woken && this.failure === "unreachable" ? { woken: true as const } : {}) } : null;
    const step: HandoffView["step"] = this.phase === "offer" ? "offer" : this.phase === "connecting" ? "connecting" : this.phase === "authorizing" ? "authorizing"
      : this.phase === "receiving" ? (this.pass === 1 ? (this.ports.links.live(this.peer) ? "copying" : "ready") : "rest") : this.phase === "verified" ? "checking"
        : this.phase === "installing" ? "switching" : this.phase === "settling" ? "settling" : this.phase === "done" ? "done" : "failed";
    const later = [...this.behind.values()].reduce((sum, part) => sum + part[1], 0);
    return {
      role: "taker", device: this.deviceName, key: this.peer, step, bytes: this.totals.bytes, total: this.totals.total,
      ...(this.phase === "receiving" ? { pass: this.pass } : {}), ...(later ? { later } : {}), ...(this.phase === "offer" ? { offer: this.offerBytes } : {}),
      ...(this.failure ? { failure: this.failure } : {}), ...(this.retry ? { retry: this.retry } : {}), ...(this.woken && (this.phase === "connecting" || this.failure === "unreachable") ? { woken: true as const } : {}),
    };
  }

  /** A wake push went to the giver while this taker waited for its link. */
  private woken = false;

  /**
   * "Use here" on a standby or on a replaced device (a pull), with the profile's lock password. `later`: leave files over
   * this size behind. A replaced (`superseded`) device keeps what only it holds: its old namespace is the fork, kept
   * after the install (WISP 06 § Installing the staged state).
   */
  pull(password: string, later = 0): Promise<HandoffView | null> {
    return this.exclusive(async () => {
      if (this.phase !== "idle" && this.phase !== "failed" && this.phase !== "offer") throw new Error("handoff-busy: Another move is in progress.");
      const record = await this.ports.records.read();
      if (!record || !takes(record.state)) throw new Error("handoff-refused: This device is not on standby.");
      const active = record.activeSlot === undefined ? null : record.deviceSet[record.activeSlot];
      if (!active || record.activeSlot === record.ownSlot) throw new Error("handoff-refused: No other device is active.");
      await this.start(record, active.key, newHandoffId(), later);
      this.pake = await startPakeTaker(password);
      await this.connect(true);
      return this.view();
    });
  }

  /** "Use here" on an offer the active device sent (a push): no password. */
  accept(later = 0): Promise<HandoffView | null> {
    return this.exclusive(async () => {
      if (this.phase !== "offer" || !this.peer || !this.id) throw new Error("handoff-refused: There is no offer to accept.");
      const record = await this.ports.records.read();
      if (!record) throw new Error("handoff-refused: This device is not on standby.");
      await this.start(record, this.peer, this.id, later);
      await this.connect(false);
      return this.view();
    });
  }

  /** "Not now" on an offer, or Cancel before the release. After the release there is nothing to cancel here. */
  cancel(): Promise<void> {
    return this.exclusive(async () => {
      if (this.phase === "installing" || this.phase === "settling" || this.phase === "unsettled" || this.phase === "done") return;
      if (this.peer && this.ports.links.live(this.peer)) this.out(handoffCancelFrame("cancelled"));
      await this.giveUp("cancelled");
    });
  }

  /**
   * After a reload: what the device record says. A standby that was receiving goes on when the giver is back (its
   * staged files are kept; the parts of pass 2 are not, and come again). A `taking` device installs, or takes the turn.
   */
  async resume(): Promise<void> {
    const record = await this.ports.records.read();
    const handoff = record?.handoff;
    if (!record || handoff?.role !== "taking" || !handoff.peer || !handoff.id) return;
    this.peer = handoff.peer; this.id = handoff.id; this.turn = handoff.from ?? record.turn; this.deviceName = name(record, handoff.peer);
    this.secret = handoff.secret ? fromBase64Url(handoff.secret) : null;
    if (record.state === "taking" && handoff.release && handoff.staging && handoff.old) {
      // Installed under the staged name: the take, which runs on its own (the screens follow it meanwhile). Not yet
      // (the pointer did not move): the install again.
      if (record.profile === handoff.staging) void this.take(record);
      else await this.exclusive(() => this.install(record));
      return;
    }
    if (!takes(record.state) || handoff.step === "stopped") return;
    // Verified before the reload, and no release yet: the staged state is whole. It asks for the release again.
    if (handoff.step === "verified" && handoff.h && handoff.staging && this.secret) {
      this.staging = await this.ports.staging.open(handoff.staging);
      this.h = fromBase64Url(handoff.h);
      this.phase = "verified";
      this.changed();
      if (this.ports.links.live(this.peer)) this.linkChanged(this.peer, true);
      this.arm(HANDOFF_TIMINGS.releaseMs, () => this.askAgain());
      return;
    }
    const fresh = handoff.at !== undefined && this.now() - handoff.at < HANDOFF_TIMINGS.giveUpMs;
    if (!fresh || !this.secret || !handoff.staging) { await this.giveUp("dropped"); return; }
    this.staging = await this.ports.staging.open(handoff.staging);
    // Pass 2 starts over: its parts lived in memory.
    await this.staging.dropRest().catch(() => {});
    this.phase = "receiving";
    this.pass = 1;
    this.watchIdle();
    this.changed();
    if (this.ports.links.live(this.peer)) this.linkChanged(this.peer, true);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    clearInterval(this.idleTimer);
  }

  linkChanged(key: string, live: boolean): void {
    void this.exclusive(async () => {
      if (key !== this.peer || !live) { if (key === this.peer) this.changed(); return; }
      if (this.phase === "connecting" || this.phase === "receiving" || this.phase === "verified") {
        const session = this.sessionFor(key);
        if (session) this.sendHello(key, session);
      }
    });
  }

  receive(from: string, frame: DeviceFrame): Promise<void> {
    return this.exclusive(() => this.handle(from, frame)).catch(() => {});
  }

  private async handle(from: string, frame: DeviceFrame): Promise<void> {
    if (this.stopped) return;
    // Only this handoff's own frames count as the giver being there.
    if (from === this.peer && frame.t.startsWith("handoff-")) this.heardAt = this.now();
    switch (frame.t) {
      case HANDOFF_OFFER: {
        const offer = readHandoffTurnFrame(frame);
        if (!offer || offer.bytes === undefined || (this.phase !== "idle" && this.phase !== "failed" && this.phase !== "offer")) return;
        const record = await this.ports.records.read();
        // Only from the device the record names active.
        if (!record || record.activeSlot === undefined || record.deviceSet[record.activeSlot]?.key !== from || !takes(record.state)) return;
        this.peer = from; this.id = offer.id; this.offerBytes = offer.bytes; this.deviceName = name(record, from); this.failure = undefined;
        this.phase = "offer";
        this.changed();
        return;
      }
      case HANDOFF_HELLO: return this.onHello(from, frame);
      case HANDOFF_BUSY: {
        const busy = readHandoffBusy(frame);
        if (!busy || from !== this.peer || (this.phase !== "connecting" && this.phase !== "authorizing" && this.phase !== "receiving")) return;
        this.retry = busy.retry || undefined;
        const failure: HandoffFailure = busy.why === "handoff" ? "busy" : busy.why;
        await this.giveUp(failure);
        return;
      }
      case HANDOFF_PAKE: return this.onPake(from, frame);
      case HANDOFF_MANIFEST: return this.onManifest(from, frame);
      case HANDOFF_DATA: return this.onData(from, frame);
      case HANDOFF_RELEASE: return this.onRelease(from, frame);
      case HANDOFF_CANCEL: {
        const why = readHandoffCancel(frame);
        if (!why || from !== this.peer) return;
        // A cancel after a release counts only once a turn above the released one is on the network (the take finds out).
        if (this.phase === "installing" || this.phase === "settling" || this.phase === "unsettled" || this.phase === "done") return;
        await this.giveUp(why === "password" ? "password" : why === "damaged" ? "damaged" : why === "stalled" ? "stalled" : "cancelled");
        return;
      }
      default: return;
    }
  }

  private async start(record: DeviceRecord, peer: string, id: string, later: number): Promise<void> {
    this.peer = peer; this.id = id; this.turn = takerTurn(record); this.later = later; this.deviceName = name(record, peer);
    this.failure = undefined; this.retry = undefined; this.secret = null; this.incoming.clear(); this.behind.clear(); this.ids = {}; this.bundle = null; this.h = null;
    // A new handoff says hello anew, with a key of its own, even on a session that carried another one.
    this.sessions.delete(peer);
    this.totals = { bytes: 0, total: 0 };
    // The staging of an earlier try with the same device is used again: the files it holds are not sent twice.
    const earlier = record.handoff?.role === "taking" && record.handoff.peer === peer && record.handoff.staging && record.handoff.at !== undefined && this.now() - record.handoff.at < HANDOFF_TIMINGS.stagingMs ? record.handoff.staging : undefined;
    this.staging = await this.ports.staging.open(earlier);
    await this.staging.dropRest().catch(() => {});
    if (record.handoff?.staging && record.handoff.staging !== this.staging.database) await this.ports.staging.drop(record.handoff.staging).catch(() => {});
    await this.ports.records.amend({ handoff: { role: "taking", step: "requesting", id, peer, from: this.turn, staging: this.staging.database, old: record.profile, at: this.now(), ...(record.state === "superseded" ? { fork: true as const } : {}) } });
  }

  /** Waits for the link (30 seconds), then hello. */
  private async connect(pull: boolean): Promise<void> {
    this.phase = "connecting";
    this.pullWanted = pull;
    this.woken = false;
    this.changed();
    this.arm(HANDOFF_TIMINGS.connectMs, () => this.giveUp("unreachable"));
    if (this.ports.links.live(this.peer!)) {
      const session = this.sessionFor(this.peer!);
      if (session) this.sendHello(this.peer!, session);
      return;
    }
    // The giver's link is down (a phone that suspended the app): a wake push asks the person to open Ghostly there, and
    // the wait is long enough for that (WISP 06 § Push and the phone).
    const peer = this.peer!, id = this.id;
    void this.ports.links.wake?.(peer).then((outcome) => this.exclusive(async () => {
      if (outcome !== "sent" || this.phase !== "connecting" || this.peer !== peer || this.id !== id || this.ports.links.live(peer)) return;
      this.woken = true;
      this.arm(WOKEN_CONNECT_MS, () => this.giveUp("unreachable"));
      this.changed();
    })).catch(() => {});
  }
  private pullWanted = false;

  private async onHello(from: string, frame: DeviceFrame): Promise<void> {
    const hello = readHandoffHello(frame);
    const session = hello && from === this.peer ? this.freshFor(from, hello) : null;
    if (!hello || !session || from !== this.peer) return;
    session.peer = hello;
    this.sendHello(from, session);
    if (this.phase === "connecting") {
      const self = await this.ownSelf();
      if (handoffVersions(hello, self).older) { await this.giveUp("older"); return; }
      this.out(handoffRequestFrame(this.turn, this.id!));
      if (this.pullWanted && this.pake) {
        this.phase = "authorizing";
        this.out(handoffPakeFrame({ n: 1, m: this.pake.first }));
      } else {
        // A push: no password; the stream key needs nothing but this session.
        this.secret = handoffStreamKey(session.ephemeral.secret, fromBase64Url(hello.e), new Uint8Array(), session.transcript);
        session.key = this.secret;
        await this.authorized();
      }
      this.arm(HANDOFF_TIMINGS.idleMs, () => this.giveUp("dropped"));
      this.changed();
      return;
    }
    // A new session of this handoff (the giver reloaded into the gate for pass 2, or the link dropped).
    if ((this.phase === "receiving" || this.phase === "verified") && hello.id === this.id && this.secret) {
      session.key = handoffStreamKey(session.ephemeral.secret, fromBase64Url(hello.e), this.secret, session.transcript);
      if (this.phase === "verified") { this.out(handoffRequestFrame(this.turn, this.id!)); return; }
      await this.sendHave();
      return;
    }
    // The giver says hello without this handoff's id: it holds none, so it never released (a release is written into
    // its record, with the id, before it is sent) and went back to active. Nothing to wait for; staged files stay.
    if ((this.phase === "receiving" || this.phase === "verified") && hello.id !== this.id) await this.giveUp("cancelled");
  }

  private async onPake(from: string, frame: DeviceFrame): Promise<void> {
    const pake = readHandoffPake(frame);
    if (!pake || from !== this.peer || this.phase !== "authorizing" || pake.n !== 2 || !this.pake) return;
    const session = this.sessionFor(from);
    if (!session?.peer) return;
    const taker = this.pake;
    this.pake = null;
    try {
      const done = await taker.finish(pake.m!, handoffContext(this.ports.turnAddress, fromBase64Url(from), this.ports.ownKey, session.transcript));
      this.out(handoffPakeFrame({ n: 3, m: done.third, c: done.proof }));
      session.key = handoffStreamKey(session.ephemeral.secret, fromBase64Url(session.peer.e), done.key, session.transcript);
      this.secret = session.key;
      await this.authorized();
    } catch (error) {
      if (!(error instanceof HandoffPasswordError)) throw error;
      this.out(handoffPakeFrame({ n: 3, wrong: true }));
      await this.giveUp("password");
    }
  }

  /** The first session's key is the handoff's: kept, so a later session of it needs no password. Then: what is here. */
  private async authorized(): Promise<void> {
    const record = await this.ports.records.read();
    await this.ports.records.amend({ handoff: { ...record!.handoff!, step: "receiving", secret: toBase64Url(this.secret!), at: this.now() } });
    this.phase = "receiving";
    this.pass = 1;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.watchIdle();
    await this.sendHave();
  }

  private lastDataAt = 0;
  /** When the giver last sent anything on this handoff. */
  private heardAt = 0;
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * Nothing has arrived for a minute while parts are still to come and the link is open: what is here is said again,
   * so a copy the giver paused (it saw no confirmation for two minutes) goes on.
   */
  private watchIdle(): void {
    clearInterval(this.idleTimer);
    this.lastDataAt = this.now();
    this.heardAt = this.now();
    this.idleTimer = setInterval(() => void this.exclusive(async () => {
      if (this.phase !== "receiving") { clearInterval(this.idleTimer); return; }
      // Nothing from the giver for too long, the link up or not (WISP 06 § States and events): the copy stopped. The
      // giver is told when the link lets it; the staged files stay for Try again.
      if (this.now() - this.heardAt >= HANDOFF_TIMINGS.stuckMs) {
        clearInterval(this.idleTimer);
        if (this.peer && this.ports.links.live(this.peer)) this.out(handoffCancelFrame("stalled"));
        await this.giveUp("stalled");
        return;
      }
      const waiting = [...this.incoming.values()].some((part) => !part.done);
      if (!waiting || !this.peer || !this.ports.links.live(this.peer) || this.now() - this.lastDataAt < HANDOFF_TIMINGS.idleMs) return;
      this.lastDataAt = this.now();
      await this.sendHave();
    }), HANDOFF_TIMINGS.idleMs / 2);
  }

  /** `handoff-have`: the files staged and the files the frozen copy holds, and the parts received in part. */
  private async sendHave(): Promise<void> {
    const record = await this.ports.records.read();
    const staged = await this.staging!.held();
    const digests = [...staged.map((file) => file.sha256), ...(record?.heldFiles ?? []).map((file) => file.sha256)];
    const partial: Record<string, number> = {};
    for (const part of this.incoming.values()) if (!part.done && part.got > 0 && part.id) partial[part.name] = part.got;
    for (const frame of handoffHaveFrames(digests, partial)) this.out(frame);
  }

  private async onManifest(from: string, frame: DeviceFrame): Promise<void> {
    const manifest = readHandoffManifest(frame);
    if (!manifest || from !== this.peer || this.phase !== "receiving") return;
    this.manifestBuffer.parts.push(...manifest.parts);
    this.manifestBuffer.later.push(...manifest.later);
    Object.assign(this.manifestBuffer.ids, manifest.ids);
    if (manifest.more) return;
    const { parts, later, ids } = this.manifestBuffer;
    this.manifestBuffer = { parts: [], later: [], ids: {} };
    this.pass = manifest.pass;
    this.ids = ids;
    for (const part of later) this.behind.set(part[2], part);
    // Room for what is to come, against what this device says it has.
    const total = parts.reduce((sum, part) => sum + part[1], 0);
    const room = await this.staging!.room();
    if (room !== null && room < total) { this.out(handoffCancelFrame("room")); await this.giveUp("room"); return; }
    // What the frozen copy holds is copied in here, not sent.
    const record = await this.ports.records.read();
    const staged = new Map((await this.staging!.held()).map((file) => [file.id, file]));
    for (const held of record?.heldFiles ?? []) {
      for (const id of ids[held.sha256] ?? []) {
        if (staged.has(id)) continue;
        try { await this.staging!.copyHeld(held.id, { id, size: held.size, sha256: held.sha256 }); } catch { /* sent again below on a later pass */ }
      }
    }
    for (const [partName, size, digest] of parts) {
      const known = this.incoming.get(partName);
      if (known && known.size === size && known.sha256 === digest && !known.done) continue;
      const fileDigest = filePartDigest(partName);
      const id = fileDigest ? ids[fileDigest]?.[0] : undefined;
      if (fileDigest && !id) { this.out(handoffCancelFrame("damaged")); await this.giveUp("damaged"); return; }
      const part: InPart = { name: partName, size, sha256: digest, got: 0, hash: sha256.create(), ...(id ? { id } : { chunks: [] }) };
      if (id) await this.staging!.begin(id);
      this.incoming.set(partName, part);
      if (size === 0) await this.partDone(part);
    }
    this.totals = { bytes: 0, total };
    this.changed();
    await this.maybeVerified();
  }

  private async onData(from: string, frame: DeviceFrame): Promise<void> {
    const data = readHandoffData(frame);
    const session = this.sessions.get(from);
    if (!data || from !== this.peer || this.phase !== "receiving" || !session?.key || session.transcript !== this.ports.links.transcript(from)) return;
    const part = this.incoming.get(data.part);
    if (!part || part.done) { if (part?.done) this.out(handoffAckFrame(data.part, part.size)); return; }
    // A piece already written (sent again after a drop) is confirmed again; one past a gap waits for its turn.
    if (data.offset !== part.got) { if (data.offset < part.got) this.out(handoffAckFrame(part.name, part.got)); return; }
    const piece = openHandoffPiece(session.key, data.part, data.offset, data.sealed);
    // Sealed with another session's key (sent as the link changed under it): not taken. What is here is said again,
    // so the giver goes on with this session's key. A piece that opens and is not the part is caught by its digest.
    if (!piece) { await this.sayAgain(); return; }
    if (part.got + piece.length > part.size) { await this.badPart(part); return; }
    this.lastDataAt = this.now();
    // A write that fails (the disk is full, storage was taken away) ends the handoff at once, said to both screens.
    try { if (part.id) await this.staging!.append(part.id, part.got, piece); else part.chunks!.push(piece); }
    catch { await this.noRoom(); return; }
    part.hash.update(piece);
    part.got += piece.length;
    this.totals.bytes += piece.length;
    this.changedSoon();
    // The last piece is confirmed only once the part's digest holds: a giver whose every piece is confirmed knows the
    // taker has the part whole.
    if (part.got < part.size) { this.out(handoffAckFrame(part.name, part.got)); return; }
    let done: boolean;
    try { done = await this.partDone(part); } catch { await this.noRoom(); return; }
    if (done) this.out(handoffAckFrame(part.name, part.size));
  }

  /** Storage refused a write: no room. Nothing changed on either device. */
  private async noRoom(): Promise<void> {
    this.out(handoffCancelFrame("room"));
    await this.giveUp("room");
  }

  private async partDone(part: InPart): Promise<boolean> {
    if (toBase64Url(part.hash.digest()) !== part.sha256) { await this.badPart(part); return false; }
    part.done = true;
    if (part.id) await this.staging!.finish({ id: part.id, size: part.size, sha256: part.sha256 });
    else {
      const bytes = new Uint8Array(part.size);
      let at = 0;
      for (const chunk of part.chunks!) { bytes.set(chunk, at); at += chunk.length; }
      this.bundle = { part: [part.name, part.size, part.sha256], bytes };
    }
    await this.maybeVerified();
    return true;
  }

  private saidAgainAt = 0;
  /** `handoff-have` again, at most every two seconds. */
  private async sayAgain(): Promise<void> {
    if (this.now() - this.saidAgainAt < 2_000) return;
    this.saidAgainAt = this.now();
    await this.sendHave();
  }

  /** A part that failed its check is asked for once more (the taker says again what it holds); twice, the handoff fails. */
  private async badPart(part: InPart): Promise<void> {
    if (part.retried) { this.out(handoffCancelFrame("damaged")); await this.giveUp("damaged"); return; }
    if (part.id) await this.staging!.discard(part.id).catch(() => {});
    this.incoming.set(part.name, { ...part, got: 0, hash: sha256.create(), retried: true, done: false, ...(part.id ? {} : { chunks: [] }) });
    if (part.id) await this.staging!.begin(part.id);
    this.totals.bytes -= part.got;
    await this.sendHave();
  }

  /** Every part of pass 2 here and checked: the rest restored into the staging namespace, then `handoff-verified`. */
  private async maybeVerified(): Promise<void> {
    if (this.pass !== 2 || !this.bundle || [...this.incoming.values()].some((part) => !part.done)) return;
    const staged = await this.staging!.held();
    const byId = new Map(staged.map((file) => [file.id, file]));
    // Two records of one file: the bytes went once, under the first id; the others get their copy here.
    for (const [digest, list] of Object.entries(this.ids)) {
      if (this.behind.has(digest)) continue;
      const first = list.map((id) => byId.get(id)).find(Boolean);
      if (!first) { this.out(handoffCancelFrame("damaged")); await this.giveUp("damaged"); return; }
      for (const id of list) if (!byId.has(id)) { const copy = { id, size: first.size, sha256: digest }; await this.staging!.copyStaged(first.id, copy); byId.set(id, copy); }
    }
    const files = [...byId.values()].filter((file) => this.ids[file.sha256]?.includes(file.id));
    const parts = [...fileParts(files), this.bundle.part];
    const h = handoffDigest(this.turn + 1, fromBase64Url(this.peer!), this.ports.ownKey, parts);
    // Written into the staging namespace before anything is said: a crash after `handoff-verified` loses nothing.
    await this.staging!.restore(this.bundle.bytes, files);
    this.h = h;
    const record = await this.ports.records.read();
    await this.ports.records.amend({ handoff: { ...record!.handoff!, step: "verified", h: toBase64Url(h), at: this.now() } });
    this.phase = "verified";
    this.out(await handoffVerifiedFrame(this.ports.turnAddress, this.turn + 1, h, { publicKey: this.ports.ownKey, sign: (bytes) => this.ports.sign(bytes) }));
    this.arm(HANDOFF_TIMINGS.releaseMs, () => this.askAgain());
    this.changed();
  }

  /** No release yet: the request again, and again each time the link is back. Never a start without a release. */
  private askAgain(): void {
    if (this.phase !== "verified") return;
    if (this.peer && this.ports.links.live(this.peer)) this.out(handoffRequestFrame(this.turn, this.id!));
    this.arm(HANDOFF_TIMINGS.releaseMs, () => this.askAgain());
  }

  private async onRelease(from: string, frame: DeviceFrame): Promise<void> {
    const release = readHandoffRelease(frame);
    if (!release || from !== this.peer || this.phase !== "verified" || !this.h) return;
    const own = toBase64Url(this.ports.ownKey);
    if (release.to !== own || release.turn !== this.turn + 1 || release.h !== toBase64Url(this.h)) return;
    if (!verify(fromBase64Url(release.s), turnReleaseMessage(this.ports.turnAddress, release.turn, this.ports.ownKey, this.h), fromBase64Url(from))) return;
    if (this.timer) clearTimeout(this.timer);
    const record = await this.ports.records.read();
    if (!record || !takes(record.state)) return;
    const taking = await this.ports.records.move("taking", { handoff: { ...record.handoff!, step: "install", release, at: this.now() }, ...mergedAttempts(record, frame.a) });
    this.phase = "installing";
    this.changed();
    await this.install(taking);
  }

  /** The record under both names, the signing key under the new one, then the one pointer; then the reload. */
  private async install(record: DeviceRecord): Promise<void> {
    const handoff = record.handoff!;
    this.phase = "installing";
    this.changed();
    await this.ports.install(handoff.staging!, { handoff: { ...handoff, step: "installed", at: this.now() } });
    await this.ports.staging.install(handoff.old!, handoff.staging!);
    this.ports.reload();
  }

  /** The take the turn keeper is working on: one at a time, and a Try again waits for it rather than asking again. */
  private taking: Promise<TurnOutcome | null> | null = null;

  /**
   * Under the staged name, `taking`: the turn record of `N + 1`, the settle wait, and `active` only on `mine`. On
   * anything else the device steps back: the pointer goes back to its old namespace, the staged one is dropped.
   *
   * Bounded (WISP 06 § States and events): no settled turn within `HANDOFF_TIMINGS.settleMs` and it stops, "Can't check
   * which device is active", with Try again (`settle`). It stays `taking`, as the release is still its own; a take the
   * keeper was still working on is not dropped, and settles the device if it answers later.
   */
  private async take(record: DeviceRecord): Promise<void> {
    const handoff = record.handoff!, release = handoff.release!;
    if (!this.ports.take) return;
    this.phase = "settling"; this.failure = undefined;
    this.changed();
    const fromSlot = slotOf(record, handoff.peer!), toSlot = record.ownSlot!;
    const turnRelease: TurnRelease = { from: fromSlot, to: toSlot, h: fromBase64Url(release.h), signature: fromBase64Url(release.s) };
    const deadline = this.now() + HANDOFF_TIMINGS.settleMs;
    for (;;) {
      if (this.stopped) return;
      if (this.now() >= deadline) { this.unsettled(); return; }
      // A take that throws (a store or network error) is a take with no answer: tried again, never the end of it.
      const call = this.taking ??= this.ports.take(turnRelease, release.turn).catch(() => null).finally(() => { this.taking = null; });
      const outcome = await Promise.race([call, this.sleep(deadline - this.now()).then((): typeof NO_ANSWER => NO_ANSWER)]);
      if (outcome === NO_ANSWER) {
        this.unsettled();
        // Still the keeper's: an answer that comes later is acted on, unless a Try again already waits for it.
        void call.then((late) => (this.phase === "unsettled" ? this.settled(late, record) : false));
        return;
      }
      if (await this.settled(outcome, record)) return;
      // No good read, or a settle read a source did not answer: "Finishing: waiting for the network".
      this.phase = "settling";
      this.changed();
      await this.sleep(Math.min(5_000, Math.max(0, deadline - this.now())));
    }
  }

  /** What a take's outcome ends in: the device active (`start`), back on standby (`gated`), or nothing yet (false). */
  private async settled(given: TurnOutcome | null, record: DeviceRecord): Promise<boolean> {
    if (this.stopped || this.phase === "done") return true;
    const handoff = record.handoff!;
    // No outcome (the take threw): the record says whether the keeper got as far as a new state before it did.
    const now = given ? null : await this.ports.records.read().catch(() => null);
    const kind = given?.kind ?? (now?.state === "active" ? "start" : now && now.state !== "taking" ? "gated" : null);
    if (kind === "start") {
      this.phase = "done";
      this.changed();
      const sequence = given?.kind === "start" ? Number(given.read.record?.sequence ?? 0) : 0;
      try { this.ports.links.send(handoff.peer!, handoffDoneFrame(sequence)); } catch { /* it learns from the turn record */ }
      await this.ports.forget(handoff.old!).catch(() => {});
      // A replaced device's old namespace is the fork: what only it held stays, as "Only on this device", until the
      // person discards it (WISP 06 § Installing the staged state). Any other old namespace goes.
      if (handoff.fork) await this.ports.records.amend({ handoff: undefined, forks: [...new Set([...(record.forks ?? []), handoff.old!])] }).catch(() => {});
      else {
        await this.ports.staging.drop(handoff.old!).catch(() => {});
        await this.ports.records.amend({ handoff: undefined }).catch(() => {});
      }
      this.ports.reload();
      return true;
    }
    if (kind === "gated") {
      // It lost: the record under the staged name says so; the pointer is back (`stepBack`). The staged namespace goes.
      this.phase = "failed"; this.failure = "turn";
      this.changed();
      await this.ports.forget(handoff.staging!).catch(() => {});
      await this.ports.staging.drop(handoff.staging!).catch(() => {});
      this.ports.reload();
      return true;
    }
    return false;
  }

  /** The settle wait ran out: "Can't check which device is active", with Try again. */
  private unsettled(): void {
    this.phase = "unsettled"; this.failure = "settle";
    this.changed();
  }

  /** Try again after the settle wait ran out: the take again, for as long once more. */
  settle(): Promise<HandoffView | null> {
    return this.exclusive(async () => {
      if (this.phase !== "unsettled") return this.view();
      const record = await this.ports.records.read();
      if (record?.state !== "taking" || !record.handoff?.release) throw new Error("handoff-refused: This device is not taking the profile.");
      void this.take(record);
      return this.view();
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** What `undoStaging` does for a taker that lost (the keeper calls it before it writes `standby` under the staged name). */
  static async stepBack(ports: Pick<TakerPorts, "standbyUnder" | "staging">, record: DeviceRecord): Promise<void> {
    const handoff = record.handoff;
    if (!handoff?.old || !handoff.staging) return;
    await ports.standbyUnder(handoff.old);
    await ports.staging.revert(handoff.old, handoff.staging);
  }

  /** The handoff ended without a release: the staged parts of pass 2 go, the staged files stay for a later try. */
  private async giveUp(failure: HandoffFailure): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    clearInterval(this.idleTimer);
    this.phase = "idle";
    this.failure = failure;
    this.pake = null; this.bundle = null; this.incoming.clear();
    await this.staging?.dropRest().catch(() => {});
    const record = await this.ports.records.read().catch(() => null);
    if (record?.handoff?.role === "taking" && takes(record.state)) await this.ports.records.amend({ handoff: { ...record.handoff, step: "stopped", secret: undefined } }).catch(() => {});
    this.changed();
  }

  private arm(ms: number, then: () => void | Promise<void>): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.exclusive(async () => { await then(); }); }, ms);
  }

  private sessionFor(key: string): Session | null {
    const transcript = this.ports.links.transcript(key);
    if (!transcript) return null;
    let session = this.sessions.get(key);
    if (!session || session.transcript !== transcript) { session = new Session(transcript); this.sessions.set(key, session); }
    return session;
  }

  /** A hello with another key than the one this session heard: the other side began again; so does this session. */
  private freshFor(key: string, hello: { e: string }): Session | null {
    const session = this.sessionFor(key);
    if (session?.peer && session.peer.e !== hello.e) { const fresh = new Session(session.transcript); this.sessions.set(key, fresh); return fresh; }
    return session;
  }

  private async ownSelf(): Promise<HandoffSelf> {
    this.self ??= await this.ports.self();
    return this.self;
  }

  private sendHello(key: string, session: Session): void {
    if (session.sent) return;
    session.sent = true;
    void this.ownSelf().then((self) => {
      this.out(handoffHelloFrame({ ...self, v: 1, e: toBase64Url(session.ephemeral.publicKey), ...(this.later ? { later: this.later } : {}), ...(this.id ? { id: this.id } : {}) }), key);
    }).catch(() => { session.sent = false; });
  }

  private out(frame: DeviceFrame, to: string | null = this.peer): void {
    if (!to) return;
    try { this.ports.links.send(to, frame); } catch { /* the link dropped: what is here is said again when it is back */ }
  }

  private changedAt = 0;
  private changedSoon(): void {
    if (this.now() - this.changedAt > 250) this.changed();
  }
  private changed(): void {
    this.changedAt = this.now();
    try { this.ports.onChange?.(this.view()); } catch { /* a listener's own trouble */ }
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => {}).then(work);
    this.queue = run.catch(() => {});
    return run;
  }
}
