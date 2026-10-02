/*
 * One profile on several devices (WISP 06 § Model): what this device is for a profile, and which changes of that are
 * legal. Nothing here touches storage or the network; `store.ts` keeps the record and `gate.ts` reads it before the
 * engine starts.
 *
 * A profile that never enrolled a device has no record: it is `single` and runs exactly as before this WISP.
 */

/** WISP 06 § States of a device. */
export const DEVICE_STATES = ["single", "active", "standby", "releasing", "taking", "superseded", "moving", "removed"] as const;
export type DeviceState = (typeof DEVICE_STATES)[number];
/** What a record holds: `single` is the absence of a record. */
export type StoredDeviceState = Exclude<DeviceState, "single">;

/** The device set holds four devices at most (WISP 06 § Terms), and a device keeps its slot for life. */
export const MAX_DEVICES = 4;
/** Earlier device sets kept beside the state, the oldest dropped (WISP 06 § Removing a device). */
export const MAX_EARLIER_SETS = 8;

/** One slot of the device set. Bytes are base64url everywhere in the record, so it is the same in IndexedDB and in Desktop's file. */
export interface DeviceSlot {
  /** The device signing key (Ed25519 public key). */
  key: string;
  /** At most 16 bytes of UTF-8. */
  name: string;
}

/** A release as the turn record carries it (WISP 06 § Record). */
export interface DeviceRelease {
  turn: number;
  /** The key of the device the turn was given to. */
  to: string;
  /** `H`, the digest of the state handed over. */
  h: string;
  /** The releaser's signature. */
  s: string;
}

/** The handoff in progress (WISP 06 § The handoff). */
export interface DeviceHandoff {
  /** `releasing`: this device gives the turn up. `taking`: it receives it. */
  role: "releasing" | "taking";
  /** Where the handoff's own state machine stands; the handoff (a later pull request) names its steps. */
  step: string;
  /** The staging namespace the incoming state is written to. */
  staging?: string;
  release?: DeviceRelease;
}

/** A file left for later, served over a device link without opening the profile database (written at quiesce). */
export interface LeftFile {
  sha256: string;
  size: number;
  /** Where the bytes are, as the platform's file storage names them. */
  where: string;
}

/** What is kept of a device set this profile left when a device was removed. */
export interface EarlierDeviceSet {
  /** The old device-set secret. */
  d: string;
  /** The tombstone packet put at the old turn address. */
  tombstone: string;
  /** The signed `set-update` frame, as it is sent and forwarded. */
  setUpdate: string;
  /** Signing keys of the staying devices that have not acknowledged it yet. */
  pending: string[];
}

/**
 * The durable device state of one profile on this device (WISP 06 § Durable device state). Most fields are filled by
 * later parts of the WISP (the turn record, enrollment, the handoff, removal); this record is where they live.
 */
export interface DeviceRecord {
  /** The record's own format. */
  v: 1;
  /** The profile's peer database name (`ghostly`, `ghostly_<namespace>`): what the gate and profile peek already know. */
  profile: string;
  state: StoredDeviceState;
  /** How many times this record was written on this device. It decides between Desktop's two copies; it is never sent. */
  saved: number;
  turn: number;
  rev: number;
  /** The stored signed turn packet, put byte for byte. */
  turnPacket?: string;
  /** The device set, by slot. An unused slot is null. */
  deviceSet: (DeviceSlot | null)[];
  /** The slot the last accepted turn record names active. */
  activeSlot?: number;
  /** This device's own slot. */
  ownSlot?: number;
  /** The device-set secret `D`. */
  d?: string;
  /** Which copy of the state this device holds, for the incremental handoff (WISP 06 § Later phases). */
  lineage?: string;
  /** Forced takeovers in the life of the profile: the floor of the group counters. */
  takeovers: number;
  handoff?: DeviceHandoff;
  /** The highest turn this device ever signed a release for. */
  releasedTurn?: number;
  /** The mark: the highest sequence ever seen at the turn address in a packet that verified under the turn key, at most the last an ordinary record can have. */
  seenSequence?: number;
  /**
   * A raised turn that is settling (WISP 06 § Settle): when this device's put ended (ms; null while the put is out,
   * or when it never ended: the wait then counts from the next start), and the sources that took it (while the put
   * is out: the sources it was sent to). The settle read counts only if every one of them answers. Stored, so a
   * reload while settling loses neither.
   */
  settle?: { at: number | null; sources: string[] };
  /** Written at quiesce: the files left for later. */
  leftFiles?: LeftFile[];
  /** Written at quiesce: the Breez database to delete once the handoff is done. */
  breezDatabase?: string;
  earlierSets: EarlierDeviceSet[];
}

/** The states in which the whole engine runs. In every other one the client opens no peer database (WISP 06 § The gate). */
export const runsEngine = (state: DeviceState): boolean => state === "single" || state === "active";

/**
 * Every legal change of state, read off WISP 06 (§ Device state by turn read, § States and events, § Adding a device,
 * § Removing a device, § Forced takeover). A change that is not here is a bug, and `transition` refuses it.
 *
 * - `single`: a first device enrolled makes this one `active`; a new device is granted the set as `standby`; a restored
 *   copy that takes over becomes `active`.
 * - `active`: quiesce for a handoff (`releasing`); a higher turn it did not release (`superseded`); a tombstone.
 * - `releasing`: cancel or a failure (`active`); the release (`standby`); a higher turn; a tombstone.
 * - `standby`: a release it holds (`taking`); a forced takeover (`active`); a tombstone.
 * - `taking`: its own turn at its settle read (`active`); another record at its turn (`standby`, or `superseded` for a
 *   device that was forcing a takeover from that state: it goes back to the state it had); a tombstone.
 * - `superseded`: "Use here" (`taking`); "It wasn't me" (`active`); a tombstone.
 * - `moving`: an accepted `set-update` or a new enrollment (`standby`); a device set of its own (`active`); no longer listed (`removed`).
 * - `removed`: a new enrollment (`standby`).
 */
const LEGAL: Record<DeviceState, readonly StoredDeviceState[]> = {
  single: ["active", "standby"],
  active: ["releasing", "superseded", "moving", "removed"],
  releasing: ["active", "standby", "superseded", "moving", "removed"],
  standby: ["taking", "active", "moving", "removed"],
  taking: ["active", "standby", "superseded", "moving", "removed"],
  superseded: ["taking", "active", "moving", "removed"],
  moving: ["standby", "active", "removed"],
  removed: ["standby"],
};

export const canTransition = (from: DeviceState, to: DeviceState): boolean => (LEGAL[from] as readonly DeviceState[]).includes(to);

/** A change of device state that WISP 06 does not allow. Nothing was written. */
export class DeviceTransitionError extends Error {
  constructor(readonly from: DeviceState, readonly to: DeviceState) {
    super(`A device cannot go from ${from} to ${to}`);
    this.name = "DeviceTransitionError";
  }
}

/** The fields a caller may set with a change of state, or without one. The state, the profile and the write counter are not among them. */
export type DevicePatch = Partial<Omit<DeviceRecord, "v" | "profile" | "state" | "saved">>;

/** The first record of a profile, for a `single` one that gets a device set. */
export function firstRecord(profile: string, state: "active" | "standby", patch: DevicePatch = {}): DeviceRecord {
  return checked({ v: 1, profile, state, saved: 0, turn: 0, rev: 0, deviceSet: [], takeovers: 0, earlierSets: [], ...clean(patch) });
}

/**
 * The record after a legal change of state. `from` null is a `single` profile. Throws `DeviceTransitionError` for any
 * other change, and for a record that would not be valid.
 */
export function transition(from: DeviceRecord | null, profile: string, to: StoredDeviceState, patch: DevicePatch = {}): DeviceRecord {
  const state = from?.state ?? "single";
  if (!canTransition(state, to)) throw new DeviceTransitionError(state, to);
  if (!from) {
    if (to !== "active" && to !== "standby") throw new DeviceTransitionError(state, to);
    return firstRecord(profile, to, patch);
  }
  return checked(rising(from, { ...from, ...clean(patch), state: to }));
}

/** The record with some fields changed and its state kept. */
export function amend(from: DeviceRecord, patch: DevicePatch): DeviceRecord {
  return checked(rising(from, { ...from, ...clean(patch) }));
}

/** The "highest ever" fields and the takeover count only rise: a change that would lower or drop one is refused. */
function rising(from: DeviceRecord, next: DeviceRecord): DeviceRecord {
  for (const field of ["releasedTurn", "seenSequence", "takeovers"] as const) {
    const was = from[field];
    if (was !== undefined && (next[field] === undefined || next[field] < was)) throw new DeviceRecordError(`${field} may only rise`);
  }
  return next;
}

/** A patch without what it may not set, whatever its type says. */
function clean(patch: DevicePatch): DevicePatch {
  const { v: _v, profile: _profile, state: _state, saved: _saved, ...rest } = patch as DevicePatch & Partial<Pick<DeviceRecord, "v" | "profile" | "state" | "saved">>;
  return rest;
}

const B64URL = /^[A-Za-z0-9_-]*$/;
const count = (value: unknown, max: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
const text = (value: unknown): value is string => typeof value === "string";
const bytes = (value: unknown): value is string => text(value) && B64URL.test(value);
const optional = <T>(value: unknown, is: (v: unknown) => v is T): boolean => value === undefined || is(value);
const slotIndex = (value: unknown): value is number => count(value, MAX_DEVICES - 1);

/** Why a stored record cannot be trusted. The gate then starts nothing (see `gate.ts`). */
export class DeviceRecordError extends Error {
  constructor(what: string) {
    super(`The device state is not valid: ${what}`);
    this.name = "DeviceRecordError";
  }
}

/**
 * A stored value as a record, or a `DeviceRecordError`. Read from IndexedDB or from Desktop's file, it is checked before
 * anything decides on it: a record this build cannot read must stop the start, never be taken for `single`.
 */
export function parseDeviceRecord(value: unknown): DeviceRecord {
  const bad = (what: string): never => { throw new DeviceRecordError(what); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad("not a record");
  const r = value as Record<string, unknown>;
  if (r.v !== 1) return bad("an unknown version");
  if (!text(r.profile) || !r.profile) return bad("no profile");
  if (!text(r.state) || r.state === "single" || !(DEVICE_STATES as readonly string[]).includes(r.state)) return bad("an unknown state");
  if (!count(r.saved, Number.MAX_SAFE_INTEGER)) return bad("saved");
  if (!count(r.turn, 2 ** 32 - 1)) return bad("turn");
  if (!count(r.rev, 2 ** 18 - 1)) return bad("rev");
  if (!count(r.takeovers, 2 ** 32 - 1)) return bad("takeovers");
  if (!Array.isArray(r.deviceSet) || r.deviceSet.length > MAX_DEVICES) return bad("the device set");
  for (const slot of r.deviceSet as unknown[]) {
    if (slot === null) continue;
    const s = slot as Partial<DeviceSlot> | undefined;
    if (!s || typeof s !== "object" || !bytes(s.key) || !text(s.name)) return bad("a device slot");
  }
  if (!optional(r.activeSlot, slotIndex) || !optional(r.ownSlot, slotIndex)) return bad("a slot index");
  for (const field of ["turnPacket", "d", "lineage"] as const) if (!optional(r[field], bytes)) return bad(field);
  if (!optional(r.breezDatabase, text)) return bad("breezDatabase");
  if (!optional(r.releasedTurn, (v): v is number => count(v, 2 ** 32 - 1))) return bad("releasedTurn");
  if (!optional(r.seenSequence, (v): v is number => count(v, Number.MAX_SAFE_INTEGER))) return bad("seenSequence");
  if (r.settle !== undefined) {
    const settle = r.settle as { at?: unknown; sources?: unknown } | null;
    if (!settle || typeof settle !== "object" || !(settle.at === null || count(settle.at, Number.MAX_SAFE_INTEGER)) || !Array.isArray(settle.sources) || settle.sources.length > 16 || !settle.sources.every(text)) return bad("settle");
  }
  if (r.handoff !== undefined) {
    const h = r.handoff as Partial<DeviceHandoff> | null;
    if (!h || typeof h !== "object" || (h.role !== "releasing" && h.role !== "taking") || !text(h.step) || !optional(h.staging, text)) return bad("the handoff");
    if (h.release !== undefined) {
      const release = h.release as Partial<DeviceRelease> | null;
      if (!release || typeof release !== "object" || !count(release.turn, 2 ** 32 - 1) || !bytes(release.to) || !bytes(release.h) || !bytes(release.s)) return bad("the release");
    }
  }
  if (r.leftFiles !== undefined) {
    if (!Array.isArray(r.leftFiles)) return bad("leftFiles");
    for (const file of r.leftFiles as Partial<LeftFile>[]) if (!file || !bytes(file.sha256) || !count(file.size, Number.MAX_SAFE_INTEGER) || !text(file.where)) return bad("a file left for later");
  }
  if (!Array.isArray(r.earlierSets) || r.earlierSets.length > MAX_EARLIER_SETS) return bad("the earlier device sets");
  for (const set of r.earlierSets as Partial<EarlierDeviceSet>[]) {
    if (!set || !bytes(set.d) || !bytes(set.tombstone) || !text(set.setUpdate) || !Array.isArray(set.pending) || !set.pending.every(bytes)) return bad("an earlier device set");
  }
  return value as DeviceRecord;
}

function checked(record: DeviceRecord): DeviceRecord {
  return parseDeviceRecord(record);
}

/**
 * Of Desktop's two copies of a record (IndexedDB and the fsynced file), the one to believe at start: "the stricter of
 * the two (a state other than `active` wins)". Where that does not decide (both run the engine, or neither does), the
 * one written last does; a record that exists wins over none.
 */
export function stricter(a: DeviceRecord | null, b: DeviceRecord | null): DeviceRecord | null {
  if (!a || !b) return a ?? b;
  const gatedA = !runsEngine(a.state), gatedB = !runsEngine(b.state);
  if (gatedA !== gatedB) return gatedA ? a : b;
  return b.saved > a.saved ? b : a;
}
