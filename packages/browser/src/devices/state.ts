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

/** The two forms of a device signing key (WISP 06 § Terms). */
export const DEVICE_SIGNING_KEY_KINDS = ["webcrypto", "seed"] as const;
export type DeviceSigningKeyKind = (typeof DEVICE_SIGNING_KEY_KINDS)[number];

/** A copy of the person's network settings, for a standby (`network.ts`). Absent fields are the app's defaults. */
export interface DeviceNetwork {
  /** The network is off: a standby asks nothing of anyone. */
  off?: boolean;
  /** The Pkarr relays. */
  relays?: string[];
  /** Where the DHT is reached directly (Desktop): reads use the relays too. */
  readRelays?: boolean;
  /** The Iroh relays a browser homes on. */
  irohRelays?: string[];
  /** ICE servers (TURN) beside the app's own. */
  iceServers?: { urls: string; username?: string; credential?: string }[];
  /** The push relay a browser page hands a wake-up to (Settings, Network): how a standby web app wakes another device. */
  pushRelay?: string;
}

/** A push target as the device record keeps it: a subscription, the VAPID pair it was made with, base64url throughout. */
export interface DevicePushTarget {
  /** The push service's endpoint (https). */
  e: string;
  p: string;
  a: string;
  /** The VAPID public and private keys. */
  vp: string;
  vk: string;
}

/**
 * Push between the person's devices (WISP 06 § Push and the phone), kept beside the device state so that a standby,
 * which never opens the profile's database, still has it. Device-local: the record is never copied to another device.
 */
export interface DevicePush {
  /**
   * This device's own push subscription for this profile, and the token it gave each other device (by signing key):
   * what it shares in `device-wake`, and how its push worker knows which device asked for it.
   */
  own?: DevicePushTarget & { tokens: Record<string, string> };
  /** Each other device's target, by signing key, with the token that device gave this one. */
  others?: Record<string, DevicePushTarget & { k: string }>;
  /**
   * This device's own subscription must be replaced by a new one (a new endpoint and key pair): someone who should no
   * longer reach it may hold it (a device was removed, or a contact that held it was deleted or muted on the active
   * device). The page of a standby acts on it (`useStandbyPush`); a new subscription clears it.
   */
  renew?: true;
  /**
   * The chats' tokens the active device still hands out under this device's subscription (`device-tokens`): on a device
   * that is not the active one the push worker shows a notice only for these, so a chat deleted or muted on the active
   * device stays quiet here too. Absent until the active device said: every well-formed wake-up shows.
   */
  allowed?: string[];
}

/** At most this many chat tokens are kept for the push worker of a standby. */
export const MAX_ALLOWED_TOKENS = 2_000;

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
  /** Where the handoff's own state machine stands (`devices/handoff.ts` names its steps). */
  step: string;
  /** The staging namespace the incoming state is written to. */
  staging?: string;
  release?: DeviceRelease;
  /** The handoff's id, as its frames name it. */
  id?: string;
  /** The other device's signing key, base64url. */
  peer?: string;
  /** The turn the handoff started at (`N`): the release is for `N + 1`. */
  from?: number;
  /**
   * The handoff's first stream key, base64url: every later session of the same handoff derives its own from it
   * (`handoffStreamKey`). Secret, as `D` beside it is.
   */
  secret?: string;
  /** When the step began (ms). */
  at?: number;
  /** The taker: the namespace it ran before (its frozen copy, or the new profile it enrolled from), to go back to. */
  old?: string;
  /** The giver: the taker runs a newer database, so this device must update before it takes the profile back. */
  newer?: true;
  /** The taker: `H` of what it verified, base64url, until the release arrives. */
  h?: string;
}

/** A file this device holds in its frozen copy, by digest: what a later pull says it has, and copies instead of fetching. */
export interface HeldFile {
  sha256: string;
  size: number;
  /** The file's id in the copy's file storage. */
  id: string;
}

/** What a giver keeps of a taking device's wrong passwords (`@ghostly/core` `HandoffAttempts`). */
export interface DeviceAttempts {
  recent: number[];
  total: number;
  until?: number;
}

/** A file left for later, served over a device link without opening the profile database (written at quiesce). */
export interface LeftFile {
  sha256: string;
  size: number;
  /** Where the bytes are, as the platform's file storage names them. */
  where: string;
}

/**
 * A grant this device sent while adding a device whose `enroll-done` never came back (WISP 06 § Adding a device): that
 * device holds `D` and is in no record. It is noted before the grant leaves, and dropped in the write that adds the
 * device; one that stays is shown as "Not finished", and is what moving the set to a new `D` (removal) has to cover.
 */
export interface UnfinishedGrant {
  /** The new device's signing key, base64url. */
  key: string;
  /** The name it gave itself. */
  name: string;
  /** When the grant went out (ms). */
  at: number;
}
/** At most this many are kept, the oldest dropped. */
export const MAX_UNFINISHED_GRANTS = 8;

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
  /**
   * Another valid tombstone stands at the old address in place of this one (a device that was left behind started a
   * set of its own, or something else closed it): it is not put any more, and the person is told (WISP 06 § Removing a
   * device, "When the remover is gone for good"). The frame is still delivered.
   */
  foreign?: true;
}

/**
 * After this device accepted a `set-update` (WISP 06 § Removing a device): the new device list, shown once ("Your
 * devices are now: ..."), with "This is wrong". `seen` once the person answered OK. While it is here the device is not
 * an enrollment that did not finish, though it holds no turn packet of the new set until it reads one.
 */
export interface SetNotice {
  names: string[];
  at: number;
  seen?: true;
}

/** After a forced takeover: "New device secret" is offered, since the device that stopped still holds `D`. */
export interface SecretOffer {
  why: "takeover";
  at: number;
  /** The device that stopped, as the takeover named it. */
  device?: string;
  /** The person said it was lost or stolen: the money checklist comes first. */
  lost?: true;
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
  /**
   * Which form this device's signing key has (WISP 06 § Terms): `webcrypto`, a non-extractable key the app cannot
   * export, or `seed`, a stored seed. The key itself is never here: it is kept apart (`signingKey.ts`), so nothing
   * that copies this record (Desktop's file, a backup, a handoff) carries it.
   */
  signingKey?: DeviceSigningKeyKind;
  /**
   * The person's network settings, as the active device last had them (`network.ts`): what device-link-only mode uses,
   * since the profile's own database, where the settings live, stays shut on a standby.
   */
  network?: DeviceNetwork;
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
  /**
   * Written at quiesce: every file the frozen copy holds, by digest. A pull says these are here (`handoff-have`) and
   * copies them into the staged state, without opening the frozen copy's database.
   */
  heldFiles?: HeldFile[];
  /** Wrong passwords of a pull, per taking device's signing key (WISP 06 § Authorizing a handoff). They do not move. */
  handoffAttempts?: Record<string, DeviceAttempts>;
  /**
   * Written at quiesce: the Breez databases of the Spark wallets and Breez Lightning cards that move, deleted once this
   * device released the turn (WISP 06 § Wallets): named from the phrase, a device that took the profile back would
   * otherwise reopen a stale one. Cleared once they are gone.
   */
  breezDatabases?: string[];
  earlierSets: EarlierDeviceSet[];
  /** Grants sent whose `enroll-done` never came back: devices that hold `D` and are in no record. */
  unfinishedGrants?: UnfinishedGrant[];
  /**
   * Which copy of the profile this device holds while it is not the active one (WISP 06 § Forced takeover: "Only a
   * device with a frozen copy, or a copy restored from a backup, can do it"). `frozen`: it was the active device and
   * released or was replaced; `restored`: a backup was restored here and has not run yet. Absent: no copy (a device
   * enrolled that never held the profile), and such a device never takes over: it would start an empty profile and
   * stop the real one.
   */
  copy?: "frozen" | "restored";
  /**
   * The profile's password proof verifier (`handoffPake.ts`), copied here by the active device whenever it changes and
   * at quiesce, so that a standby checks the lock password of a forced takeover without opening its frozen copy.
   */
  verifier?: { v: 1; setup: string; record: string };
  /** Wrong lock passwords typed for a forced takeover on this device. They only grow until one is right. */
  takeoverAttempts?: DeviceAttempts;
  /**
   * The counters to raise before the engine starts (WISP 06 § Raised counters), written with `active` by a forced
   * takeover that settled, and taken off once the engine raised them. See `raise.ts`.
   */
  raise?: { id: string; why: "takeover" | "restore"; takeovers: number; at: number };
  /** The device list to show once after an accepted `set-update` (`setUpdate.ts`). */
  setNotice?: SetNotice;
  /**
   * `moving` or `removed`: nothing this device can accept will bring it back into the set (its stored active device
   * is not listed in the tombstone, a `set-update` was refused, or the person said the new list is wrong). It shows
   * "Add this device again" (WISP 06 § Removing a device). A `moving` device still takes a valid `set-update`.
   */
  reenroll?: true;
  /** `moving`: the tombstone that closed the old address, as read. What a `set-update` is checked against. */
  tombstone?: string;
  /** "New device secret" is offered (`rotate.ts`). */
  secretOffer?: SecretOffer;
  /** Push between this profile's devices (`push.ts`). */
  push?: DevicePush;
  /**
   * `moving`: "My other device is lost or broken" made a device set of its own (`ownSet.ts`), which settles before it
   * counts. Stored before its tombstone leaves the device, so a reload while it settles resumes it.
   */
  ownSet?: OwnSetPlan;
  /**
   * The peer database name of the profile this namespace holds, on a record a handoff installed under a staged name
   * (`installDeviceRecord`): the profile's own name before the registry pointed it here. Kept for the life of the
   * record, and carried to the next staged name, so an app that finds the profile with no pointer and no record under
   * its own name points it here again (WISP 06 § Installing the staged state). Never in a backup or a handoff.
   */
  home?: string;
}

/** A device set of its own, made by a `moving` device whose remover is gone (WISP 06 § Removing a device). */
export interface OwnSetPlan {
  /** The new device-set secret. */
  d: string;
  /** The tombstone put at the old address: this device the only one listed. */
  tombstone: string;
  /** The first record at the new address. */
  packet: string;
  /** When the tombstone's put ended (ms), null while it is out; and the sources that took it. */
  at: number | null;
  sources: string[];
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

/**
 * The "highest ever" fields and the takeover count only rise: a change that would lower or drop one is refused. The
 * mark (`seenSequence`) is the highest sequence seen at one turn address, so it starts again with a new device-set
 * secret: a new `D` is a new address (WISP 06 § Removing a device).
 */
function rising(from: DeviceRecord, next: DeviceRecord): DeviceRecord {
  const moved = !!next.d && next.d !== from.d;
  for (const field of ["releasedTurn", "seenSequence", "takeovers"] as const) {
    if (field === "seenSequence" && moved) continue;
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

const texts = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length <= max && value.every((v) => typeof v === "string" && v.length <= 2048);
function isNetwork(value: unknown): value is DeviceNetwork {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const n = value as Record<string, unknown>;
  if (n.off !== undefined && typeof n.off !== "boolean") return false;
  if (n.readRelays !== undefined && typeof n.readRelays !== "boolean") return false;
  if (n.pushRelay !== undefined && (typeof n.pushRelay !== "string" || n.pushRelay.length > 2048)) return false;
  if (n.relays !== undefined && !texts(n.relays, 16)) return false;
  if (n.irohRelays !== undefined && !texts(n.irohRelays, 4)) return false;
  if (n.iceServers !== undefined) {
    if (!Array.isArray(n.iceServers) || n.iceServers.length > 8) return false;
    for (const server of n.iceServers as Record<string, unknown>[]) {
      if (!server || typeof server !== "object" || typeof server.urls !== "string" || !optional(server.username, text) || !optional(server.credential, text)) return false;
    }
  }
  return true;
}

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const pushKey = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(v);
function isPushTarget(value: unknown): value is DevicePushTarget {
  const t = value as Partial<DevicePushTarget> | null;
  return !!t && typeof t === "object" && typeof t.e === "string" && t.e.length <= 2048 && [t.p, t.a, t.vp, t.vk].every(pushKey);
}
function isPush(value: unknown): value is DevicePush {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as { own?: unknown; others?: unknown; renew?: unknown; allowed?: unknown };
  if (p.renew !== undefined && p.renew !== true) return false;
  if (p.allowed !== undefined && (!Array.isArray(p.allowed) || p.allowed.length > MAX_ALLOWED_TOKENS || !p.allowed.every((token) => typeof token === "string" && TOKEN.test(token)))) return false;
  if (p.own !== undefined) {
    const own = p.own as { tokens?: unknown };
    if (!isPushTarget(own) || !own.tokens || typeof own.tokens !== "object" || Array.isArray(own.tokens)) return false;
    const tokens = Object.entries(own.tokens as Record<string, unknown>);
    if (tokens.length > MAX_DEVICES * 4 || !tokens.every(([key, token]) => bytes(key) && typeof token === "string" && TOKEN.test(token))) return false;
  }
  if (p.others !== undefined) {
    if (!p.others || typeof p.others !== "object" || Array.isArray(p.others)) return false;
    const others = Object.entries(p.others as Record<string, unknown>);
    const token = (target: unknown) => { const k = (target as { k?: unknown }).k; return typeof k === "string" && TOKEN.test(k); };
    if (others.length > MAX_DEVICES * 4 || !others.every(([key, target]) => bytes(key) && isPushTarget(target) && token(target))) return false;
  }
  return true;
}

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
  if (!optional(r.signingKey, (v): v is DeviceSigningKeyKind => (DEVICE_SIGNING_KEY_KINDS as readonly unknown[]).includes(v))) return bad("signingKey");
  if (r.network !== undefined && !isNetwork(r.network)) return bad("network");
  if (!optional(r.breezDatabases, (v): v is string[] => Array.isArray(v) && v.length <= 8 && v.every((name) => text(name) && /^ghostly-breez-/.test(name)))) return bad("breezDatabases");
  if (!optional(r.releasedTurn, (v): v is number => count(v, 2 ** 32 - 1))) return bad("releasedTurn");
  if (!optional(r.seenSequence, (v): v is number => count(v, Number.MAX_SAFE_INTEGER))) return bad("seenSequence");
  if (r.settle !== undefined) {
    const settle = r.settle as { at?: unknown; sources?: unknown } | null;
    if (!settle || typeof settle !== "object" || !(settle.at === null || count(settle.at, Number.MAX_SAFE_INTEGER)) || !Array.isArray(settle.sources) || settle.sources.length > 16 || !settle.sources.every(text)) return bad("settle");
  }
  if (r.handoff !== undefined) {
    const h = r.handoff as Partial<DeviceHandoff> | null;
    if (!h || typeof h !== "object" || (h.role !== "releasing" && h.role !== "taking") || !text(h.step) || !optional(h.staging, text)) return bad("the handoff");
    if (!optional(h.id, bytes) || !optional(h.peer, bytes) || !optional(h.secret, bytes) || !optional(h.old, text) || !optional(h.h, bytes)) return bad("the handoff");
    if (!optional(h.from, (v): v is number => count(v, 2 ** 32 - 1)) || !optional(h.at, (v): v is number => count(v, Number.MAX_SAFE_INTEGER))) return bad("the handoff");
    if (h.newer !== undefined && h.newer !== true) return bad("the handoff");
    if (h.release !== undefined) {
      const release = h.release as Partial<DeviceRelease> | null;
      if (!release || typeof release !== "object" || !count(release.turn, 2 ** 32 - 1) || !bytes(release.to) || !bytes(release.h) || !bytes(release.s)) return bad("the release");
    }
  }
  if (r.leftFiles !== undefined) {
    if (!Array.isArray(r.leftFiles)) return bad("leftFiles");
    for (const file of r.leftFiles as Partial<LeftFile>[]) if (!file || !bytes(file.sha256) || !count(file.size, Number.MAX_SAFE_INTEGER) || !text(file.where)) return bad("a file left for later");
  }
  if (r.heldFiles !== undefined) {
    if (!Array.isArray(r.heldFiles)) return bad("heldFiles");
    for (const file of r.heldFiles as Partial<HeldFile>[]) if (!file || !bytes(file.sha256) || !count(file.size, Number.MAX_SAFE_INTEGER) || !text(file.id)) return bad("a held file");
  }
  if (r.handoffAttempts !== undefined) {
    const attempts = r.handoffAttempts as Record<string, Partial<DeviceAttempts>> | null;
    if (!attempts || typeof attempts !== "object" || Array.isArray(attempts) || Object.keys(attempts).length > 16) return bad("handoffAttempts");
    for (const [key, a] of Object.entries(attempts)) {
      if (!bytes(key) || !a || typeof a !== "object" || !Array.isArray(a.recent) || a.recent.length > 16 || !a.recent.every((at) => count(at, Number.MAX_SAFE_INTEGER))) return bad("handoffAttempts");
      if (!count(a.total, 1_000_000) || !optional(a.until, (v): v is number => count(v, Number.MAX_SAFE_INTEGER))) return bad("handoffAttempts");
    }
  }
  if (r.unfinishedGrants !== undefined) {
    if (!Array.isArray(r.unfinishedGrants) || r.unfinishedGrants.length > MAX_UNFINISHED_GRANTS) return bad("the unfinished grants");
    for (const grant of r.unfinishedGrants as Partial<UnfinishedGrant>[]) if (!grant || !bytes(grant.key) || !text(grant.name) || !count(grant.at, Number.MAX_SAFE_INTEGER)) return bad("an unfinished grant");
  }
  if (r.copy !== undefined && r.copy !== "frozen" && r.copy !== "restored") return bad("copy");
  if (!optional(r.home, (v): v is string => text(v) && /^ghostly(?:_[A-Za-z0-9_.-]{1,100})?$/.test(v))) return bad("home");
  if (r.verifier !== undefined) {
    const v = r.verifier as { v?: unknown; setup?: unknown; record?: unknown } | null;
    if (!v || typeof v !== "object" || v.v !== 1 || !bytes(v.setup) || !bytes(v.record)) return bad("verifier");
  }
  if (r.takeoverAttempts !== undefined) {
    const a = r.takeoverAttempts as Partial<DeviceAttempts> | null;
    if (!a || typeof a !== "object" || !Array.isArray(a.recent) || a.recent.length > 16 || !a.recent.every((at) => count(at, Number.MAX_SAFE_INTEGER))) return bad("takeoverAttempts");
    if (!count(a.total, 1_000_000) || !optional(a.until, (v): v is number => count(v, Number.MAX_SAFE_INTEGER))) return bad("takeoverAttempts");
  }
  if (r.raise !== undefined) {
    const raise = r.raise as { id?: unknown; why?: unknown; takeovers?: unknown; at?: unknown } | null;
    if (!raise || typeof raise !== "object" || !bytes(raise.id) || (raise.why !== "takeover" && raise.why !== "restore") || !count(raise.takeovers, 2 ** 32 - 1) || !count(raise.at, Number.MAX_SAFE_INTEGER)) return bad("raise");
  }
  if (!Array.isArray(r.earlierSets) || r.earlierSets.length > MAX_EARLIER_SETS) return bad("the earlier device sets");
  for (const set of r.earlierSets as Partial<EarlierDeviceSet>[]) {
    if (!set || !bytes(set.d) || !bytes(set.tombstone) || !text(set.setUpdate) || !Array.isArray(set.pending) || !set.pending.every(bytes)) return bad("an earlier device set");
    if (set.pending.length > MAX_DEVICES || (set.foreign !== undefined && set.foreign !== true)) return bad("an earlier device set");
  }
  if (r.setNotice !== undefined) {
    const n = r.setNotice as Partial<SetNotice> | null;
    if (!n || typeof n !== "object" || !texts(n.names, MAX_DEVICES) || !count(n.at, Number.MAX_SAFE_INTEGER) || (n.seen !== undefined && n.seen !== true)) return bad("setNotice");
  }
  if (r.reenroll !== undefined && r.reenroll !== true) return bad("reenroll");
  if (!optional(r.tombstone, bytes)) return bad("tombstone");
  if (r.secretOffer !== undefined) {
    const o = r.secretOffer as Partial<SecretOffer> | null;
    if (!o || typeof o !== "object" || o.why !== "takeover" || !count(o.at, Number.MAX_SAFE_INTEGER) || !optional(o.device, text) || (o.lost !== undefined && o.lost !== true)) return bad("secretOffer");
  }
  if (r.push !== undefined && !isPush(r.push)) return bad("push");
  if (r.ownSet !== undefined) {
    const o = r.ownSet as Partial<OwnSetPlan> | null;
    if (!o || typeof o !== "object" || !bytes(o.d) || !bytes(o.tombstone) || !bytes(o.packet) || !(o.at === null || count(o.at, Number.MAX_SAFE_INTEGER))) return bad("ownSet");
    if (!Array.isArray(o.sources) || o.sources.length > 16 || !o.sources.every(text)) return bad("ownSet");
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
