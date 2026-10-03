import {
  classifyTurnRead, fromBase64Url, nextTurnPosition, randomBytes, readTurnPacket, signTurnPacket, signTurnRelease, toBase64Url, turnKeys, turnPutSummary,
  TURN_LAST_SEQUENCE, TURN_MAX, TURN_PUT_WINDOW_MS, TURN_RAISE_READ_TIMEOUT_MS, TURN_SETTLE_MS,
  type TurnConditions, type TurnFields, type TurnKeys, type TurnNetwork, type TurnRead, type TurnRecord, type TurnRelease, type TurnSigner, type TurnSourcePut,
} from "@ghostly/core";
import { MAX_DEVICES, type DevicePatch, type DeviceRecord, type DeviceSlot, type DeviceState, type StoredDeviceState } from "./state";
import { amendDevice, moveDevice, readDeviceRecord } from "./store";
import { BEHIND_ROUNDS, turnAction, turnRow, type TurnAction, type TurnRow } from "./turnAction";
import { pendingRaise } from "./raise";

/*
 * The turn keeper (WISP 06 § The turn): one profile's turn record on this device. It reads every source, compares
 * the answers with the packet this device stored, writes the next record above everything it ever saw verified, and
 * carries out what the table says for the device's state (`turnAction.ts`), as far as that is the turn's own
 * business: the record, its puts, and the durable change of state. Starting the engine, reloading into the gate, the
 * screens and the staged state of a handoff are the host's, which gets them back as a `TurnOutcome`.
 *
 * The rules it keeps:
 * - a packet is stored durably before it is put, and put byte for byte ever after;
 * - a put goes to each source on that source's own condition; a refusal is an answer: it is never tried again
 *   without the condition, and that packet is never sent to that source again;
 * - only a packet whose signature verified moves the mark of the highest sequence seen, and a record it writes is
 *   above that mark;
 * - settle (WISP 06 § Settle): a device that raises the turn puts within `P` of the start of its read, is `taking`,
 *   waits `T` from the end of its put, reads every source again, and is active only if that read says `mine`. No
 *   relay refuses the second of two puts, so nothing else tells two devices that both raised the turn apart;
 * - an active device starts only once a source returned the record it wrote;
 * - a `single` profile has no turn: nothing is read and nothing is put.
 *
 * The device signing key is not this part's: it comes in as `signer`.
 */

/** The read a raising put would act on started more than `P` ago (or there was none): start over with a read. */
export class TurnStaleReadError extends Error {
  constructor() {
    super("The turn was read too long ago to raise it: read again");
    this.name = "TurnStaleReadError";
  }
}

/** The device state store, as the keeper uses it (tests give their own). */
export interface TurnStore {
  read(profile: string): Promise<DeviceRecord | null>;
  amend(profile: string, patch: DevicePatch): Promise<DeviceRecord>;
  move(profile: string, to: StoredDeviceState, patch?: DevicePatch): Promise<DeviceRecord>;
}
const realStore: TurnStore = { read: readDeviceRecord, amend: amendDevice, move: moveDevice };

export interface TurnKeeperOptions {
  /** The profile's peer database name. */
  profile: string;
  /** Every source of the turn record: the relays, and on Desktop the DHT itself. */
  network: TurnNetwork;
  /** Signs with this device's signing key. */
  signer: TurnSigner;
  store?: TurnStore;
  now?: () => number;
  /** 8 random bytes for a record's `instance`. */
  instance?: () => Uint8Array;
  /** Waits this long (tests move a clock of their own). */
  sleep?: (ms: number) => Promise<void>;
  /** A taking device that lost: moves the registry pointer back and drops the staged state, before `standby` is written. */
  undoStaging?: () => Promise<void>;
}

/**
 * What the host does next. Every state change named here is already written durably. `exhausted`: nothing can be
 * written above what this device saw at the address (the last ordinary turn is spent); the device did what it does
 * when it cannot read the turn, and the host says "Something else closed your device set".
 */
export type TurnOutcome = TurnStep & { exhausted?: true };
type TurnStep =
  /** The profile has no device set. Nothing was read or put. */
  | { kind: "single" }
  /** Start the engine: this device is the active one and a source returned its record. */
  | { kind: "start"; read: TurnRead }
  /** The engine goes on. `restricted`: no wallet opened, no spend, no admin work until a good read. */
  | { kind: "go-on"; restricted: boolean; read: TurnRead }
  /**
   * Do not start: "Can't check which device is active" (or, when `read.result` is `closed`, "Something else closed
   * your device set"), with Try again or Start anyway (limited mode).
   */
  | { kind: "ask"; read: TurnRead }
  /** The device is no longer (or not) the active one. `reload`: into the gate, at once. */
  | { kind: "gated"; state: StoredDeviceState; reload: boolean; notice?: "another-copy"; read: TurnRead }
  /** A standby's screen. `device`: the name of the active device, or the one the turn moves to. */
  | { kind: "show"; screen: "moving-to" | "active-on" | "last-known" | "cannot-check"; device?: string; forced?: boolean; read: TurnRead }
  /** Nothing to do now: check again later. Also a `taking` device whose settle read was not answered by every source that took its put. */
  | { kind: "wait"; read: TurnRead }
  | { kind: "stay"; offers: ("use-here" | "it-wasnt-me" | "add-again")[]; awaits?: "set-update"; read: TurnRead }
  | { kind: "impossible"; row: TurnRow; read: TurnRead };

/** A put of the turn record, every source's answer included. */
export interface TurnPutReport {
  payload: Uint8Array;
  puts: TurnSourcePut[];
  /** A source refused: someone else wrote. The next thing to do is a read. */
  refused: boolean;
}

/** Nothing can be written above what this device saw at the address (the last ordinary turn is spent). */
export class TurnClosedError extends Error {
  constructor() {
    super("The turn address takes no further record");
    this.name = "TurnClosedError";
  }
}

/** A forced takeover's mark in the device record, with the state the device had before: where it goes back to when it loses. */
const TAKEOVER = "takeover:";

/**
 * The conditions of a put after a read. Each source is compared with what that source held, so one that held no
 * record gets none by itself, and one that holds anything, valid or not, is put to on that sequence. Only a writer
 * that read `behind` to the end puts with no condition at all (WISP 06 § Publishing and reading, `behind`).
 */
const conditionsAfter = (read: TurnRead, condition: "seen" | "none"): TurnConditions =>
  (condition === "none" && read.result === "behind" ? Object.fromEntries(Object.keys(read.conditions).map((source) => [source, null])) : read.conditions);

/**
 * The turn of a forced takeover (WISP 06 § Forced takeover, § Who may raise the turn): one above the highest of the
 * turn read, the turn stored and the highest turn this device signed a release for. A releaser that released `N + 1`
 * takes over at `N + 2`, so the release its taker holds can never outrank it.
 */
export function takeoverTurn(record: Pick<DeviceRecord, "turn" | "releasedTurn">, read: Pick<TurnRead, "record">): number {
  const highest = Math.max(read.record?.turn ?? 0, record.turn, record.releasedTurn ?? 0);
  if (highest + 1 > TURN_MAX) throw new TurnClosedError();
  return highest + 1;
}

/** The record's slots as the device state keeps them. */
export function deviceSetOf(record: TurnRecord): (DeviceSlot | null)[] {
  return record.slots.map((slot) => slot && { key: toBase64Url(slot.key), name: slot.name });
}

interface Held {
  record: DeviceRecord; keys: TurnKeys; ownSlot: number; ownKey: Uint8Array; stored: Uint8Array | null; storedRecord: TurnRecord | null;
  /** This device wrote the packet it stored. */
  wrote: boolean;
  /** A record was written since this was read from the store (in this check). */
  wroteNow?: boolean;
  /** That record took the next turn by a release from this device to itself: it reads again after `T`. */
  selfRaised?: boolean;
}

/** `patch`: other fields of the device record, written in the same write as the record (enrollment drops its note there). */
type WriteOptions = { turn?: number; release?: TurnRelease; slots?: (DeviceSlot | null)[]; patch?: DevicePatch };

export class TurnKeeper {
  private readonly store: TurnStore;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastGoodAt: number | null = null;
  /** When the last read was started: a raising put is sent within `P` of it. */
  private readStartedAt: number | null = null;
  /** The packet a source refused, and the sources that refused it: it is never sent to them again. */
  private refused: { packet: string; sources: Set<string> } | null = null;
  private warmed = false;
  /** Reads and puts are made one after the other: two checks at once would race each other's writes. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: TurnKeeperOptions) {
    this.store = options.store ?? realStore;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Whether the last good read is at most `maxAgeMs` old (WISP 06 § When a device checks: a Mainnet spend, opening
   * a single-writer wallet, a group commit and door duty need one under 60 seconds old).
   */
  goodWithin(maxAgeMs = 60_000): boolean {
    return this.lastGoodAt !== null && this.now() - this.lastGoodAt <= maxAgeMs;
  }

  /** What this device holds for the profile, or null for a `single` profile. Throws when the record cannot carry a turn. */
  private async held(): Promise<Held | null> {
    const record = await this.store.read(this.options.profile);
    if (!record) return null;
    // The profile has a device set: the sources are made ready for the first read (the Desktop's DHT node joins).
    if (!this.warmed) { this.warmed = true; void this.options.network.turnWarm?.().catch(() => {}); }
    if (!record.d) throw new Error("The device state has no device-set secret");
    const ownSlot = record.ownSlot;
    const own = ownSlot === undefined ? undefined : record.deviceSet[ownSlot];
    if (ownSlot === undefined || !own) throw new Error("The device state does not say which slot is this device's");
    const keys = turnKeys(fromBase64Url(record.d));
    const ownKey = fromBase64Url(own.key);
    const stored = record.turnPacket ? fromBase64Url(record.turnPacket) : null;
    const read = stored ? readTurnPacket(keys, stored) : null;
    if (read && read.kind !== "valid") throw new Error("The stored turn packet is not a valid record");
    const storedRecord = read?.record ?? null;
    const author = storedRecord?.slots[storedRecord.author];
    const wrote = !!storedRecord && storedRecord.author === ownSlot && !!author && toBase64Url(author.key) === own.key;
    return { record, keys, ownSlot, ownKey, stored, storedRecord, wrote };
  }

  /**
   * One read of every source, compared with the stored packet and the mark. The mark (the highest sequence seen in
   * a packet that verified under the turn key) is kept durably, up to the last sequence an ordinary record can have:
   * a packet above that closes the address while it is there and is never kept, so when it expires the next read is
   * an ordinary one. `raising`: the read a raising put acts on, with less time for each source.
   */
  private async readWith(held: Held, raising = false): Promise<TurnRead> {
    const startedAt = this.now();
    const answers = await this.options.network.turnRead(held.keys.identity.pubKeyZ32, raising ? { timeoutMs: TURN_RAISE_READ_TIMEOUT_MS } : undefined);
    this.readStartedAt = startedAt;
    const read = classifyTurnRead({
      keys: held.keys, ownKey: held.ownKey, stored: held.stored, ownSlot: held.ownSlot, seen: BigInt(held.record.seenSequence ?? 0),
      ...(held.record.state === "taking" ? { taking: held.record.turn } : {}),
    }, answers);
    if (read.good) this.lastGoodAt = this.now();
    const mark = read.seen > BigInt(TURN_LAST_SEQUENCE) ? TURN_LAST_SEQUENCE : Number(read.seen);
    // Above the last ordinary sequence only a valid tombstone is remembered (it is the whole of the mark then).
    const kept = read.result === "tombstone" ? Number(read.record!.sequence) : read.result === "closed" ? 0 : mark;
    if (kept > (held.record.seenSequence ?? 0)) held.record = await this.store.amend(this.options.profile, { seenSequence: kept });
    return read;
  }

  /**
   * One read. Null for a `single` profile, which has no turn: no source is asked. `raising`: the read a taker's put
   * acts on (`write` within `P` of it): each source gets less time, so that time is left to sign, store and send.
   */
  read(options: { raising?: boolean } = {}): Promise<TurnRead | null> {
    return this.exclusive(async () => {
      const held = await this.held();
      return held ? this.readWith(held, options.raising === true) : null;
    });
  }

  /** Puts the stored packet again, unchanged, on the conditions given (the last read's). */
  putStored(conditions: TurnConditions): Promise<TurnPutReport | null> {
    return this.exclusive(async () => {
      const held = await this.held();
      return held?.stored ? this.put(held, held.stored, conditions) : null;
    });
  }

  /** Whether a put now would be sent within `P` of the start of the read it acts on. */
  private readIsFresh(): boolean {
    return this.readStartedAt !== null && this.now() - this.readStartedAt <= TURN_PUT_WINDOW_MS;
  }

  private async put(held: Held, payload: Uint8Array, conditions: TurnConditions, raising = held.record.state === "taking"): Promise<TurnPutReport> {
    // A put that raises the turn is sent within P of the start of its read. Sent later, it could land after another
    // device's settle read. So it is not sent at all, and the caller starts over with a read.
    if (raising && !this.readIsFresh()) throw new TurnStaleReadError();
    // A source that refused this packet is not sent it again.
    const packet = toBase64Url(payload);
    if (this.refused?.packet !== packet) this.refused = null;
    const sent = Object.fromEntries(Object.entries(conditions).filter(([source]) => !this.refused?.sources.has(source)));
    // Settling is stored, not remembered: a reload while it waits must still know which sources took the put and
    // when it ended. Before the put, the sources it goes to and no time; after it, the ones that took it and the end.
    const settling = raising || !!held.selfRaised;
    if (settling) held.record = await this.store.amend(this.options.profile, { settle: { at: null, sources: Object.keys(sent) } });
    const puts = await this.options.network.turnPut(held.keys.identity.pubKeyZ32, payload, sent);
    const refusedBy = puts.filter((p) => p.outcome === "refused").map((p) => p.source);
    if (refusedBy.length) this.refused = { packet, sources: new Set([...(this.refused?.sources ?? []), ...refusedBy]) };
    // T counts from the end of the put: every answer in, or timed out.
    if (settling) held.record = await this.store.amend(this.options.profile, { settle: { at: this.now(), sources: puts.filter((p) => p.outcome === "stored").map((p) => p.source) } });
    return { payload, puts, refused: turnPutSummary(puts).refused > 0 };
  }

  /**
   * The settle read (WISP 06 § Settle, steps 3 and 4): made `T` after the end of this device's put, of every source.
   * It counts only if every source that took the put answers; with fewer it is no read at all (null: wait, and read
   * again). Both come from the device record, so a keeper made after a reload asks the same sources. A device whose
   * put never ended (it crashed with the put out) waits the whole of `T` from now, and needs every source the put
   * was sent to.
   */
  private async settledRead(held: Held): Promise<TurnRead | null> {
    let settle = held.record.settle;
    if (!settle || settle.at === null) {
      settle = { at: this.now(), sources: settle?.sources ?? [] };
      held.record = await this.store.amend(this.options.profile, { settle });
    }
    const due = settle.at! + TURN_SETTLE_MS;
    if (this.now() < due) await this.sleep(due - this.now());
    const read = await this.readWith(held);
    return settle.sources.every((source) => read.conditions[source] !== undefined) ? read : null;
  }

  /**
   * Writes this device's next record as the active one: signed, sealed, stored durably, and only then put. In its own
   * turn that is `rev` plus one with a new `instance`; `turn` and `release` are for a `taking` device (a handoff's
   * taker, with the release it holds). The sequence is above the mark. When `rev` runs out, or a packet with no valid
   * record stands at or above the last sequence of the turn, the record is the next turn's with a release from this
   * device to itself. Throws `TurnStaleReadError` when a `taking` device's read is older than `P`, and
   * `TurnClosedError` when nothing can be written above the mark.
   */
  write(conditions: TurnConditions, options: WriteOptions = {}): Promise<TurnPutReport | null> {
    return this.exclusive(async () => {
      const held = await this.held();
      return held ? this.writeWith(held, conditions, options) : null;
    });
  }

  private async writeWith(held: Held, conditions: TurnConditions, options: WriteOptions = {}, raising = held.record.state === "taking"): Promise<TurnPutReport> {
    // Checked before anything is signed or stored: a raise on a read too old is not begun.
    if (raising && !this.readIsFresh()) throw new TurnStaleReadError();
    const { record, keys, ownSlot, ownKey, storedRecord, wrote } = held;
    const turn = options.turn ?? record.turn;
    const lastRev = wrote && storedRecord!.turn === turn ? storedRecord!.rev : null;
    const place = nextTurnPosition(turn, lastRev, ownSlot, record.seenSequence ?? 0);
    if (!place) throw new TurnClosedError();
    const set = options.slots ?? record.deviceSet;
    const slots = Array.from({ length: MAX_DEVICES }, (_, i) => { const slot = set[i]; return slot ? { key: fromBase64Url(slot.key), name: slot.name } : null; });
    // Every later record of a turn carries the turn's release unchanged. A turn this device had to take by itself
    // carries its release to itself, whose `H` is zero.
    let release = options.release ?? (wrote && storedRecord!.turn === place.turn ? storedRecord!.release : undefined);
    // A release names its turn: one given for a turn that can no longer be written is of no use.
    if (place.raised && options.release) throw new Error("Something was seen above the turn this release names");
    if (place.raised) release = await signTurnRelease(keys.address, place.turn, ownSlot, ownSlot, ownKey, new Uint8Array(32), this.options.signer);
    const fields: TurnFields = { turn: place.turn, rev: place.rev, author: ownSlot, active: ownSlot, slots, instance: (this.options.instance ?? (() => randomBytes(8)))(), ...(release ? { release } : {}) };
    const payload = await signTurnPacket(keys, fields, this.options.signer);
    // Stored before it is put: what this device finds on the network after a crash is never newer than what it holds.
    held.record = await this.store.amend(this.options.profile, { ...options.patch, turn: place.turn, rev: place.rev, turnPacket: toBase64Url(payload), activeSlot: ownSlot, ...(options.slots ? { deviceSet: options.slots } : {}) });
    held.stored = payload;
    const read = readTurnPacket(keys, payload);
    held.storedRecord = read.kind === "valid" ? read.record : null;
    held.wrote = true;
    held.wroteNow = true;
    // A release to itself moves the number, never the active device: it puts, and reads again after T.
    if (place.raised && !raising) held.selfRaised = true;
    return this.put(held, payload, conditions, raising);
  }

  /**
   * A forced takeover (WISP 06 § Settle): reads the turn, makes the device `taking` (with the state it had, to go
   * back to), writes the record of `turn` with no release within `P` of that read, and settles as every device that
   * raises the turn does. `start` says it is the active device now; `gated` that it lost and is what it was before.
   * With no good read, or at a closed or tombstoned address, nothing is written. Null for a `single` profile.
   */
  raise(options: { turn?: number; slots?: (DeviceSlot | null)[] } = {}): Promise<TurnOutcome | null> {
    return this.exclusive(async () => {
      const held = await this.held();
      if (!held) return null;
      const prior = held.record.state;
      if (prior !== "standby" && prior !== "superseded") throw new Error(`A ${prior} device does not force a takeover`);
      const read = await this.readWith(held, true);
      if (!read.good || read.result === "tombstone") return this.settle(held, read, true);
      // One above the highest turn this device knows (WISP 06 § Forced takeover): the one it read, the one it stored,
      // and any it signed a release for, so a releaser that takes the profile back goes above its taker's release.
      const turn = options.turn ?? takeoverTurn(held.record, read);
      held.record = await this.store.move(this.options.profile, "taking", { handoff: { role: "taking", step: `${TAKEOVER}${prior}` } });
      try { await this.writeWith(held, read.conditions, { ...options, turn }, true); } catch (error) {
        // Nothing was put: the device is what it was.
        if (!held.wroteNow) held.record = await this.store.move(this.options.profile, prior, { handoff: undefined, settle: undefined });
        // No record can be written above what it saw: it stays what it was, and the host is told.
        if (error instanceof TurnClosedError) return this.exhausted(held, turnRow(prior, true), read);
        throw error;
      }
      return this.settle(held, await this.readWith(held), true);
    });
  }

  /**
   * The last step of a handoff (WISP 06 § Shape, step 8): the device is `taking`, holds the release of `turn` (`N + 1`)
   * and has installed the staged state. It reads the turn, writes the record of `turn` with that release within `P` of
   * the read, and settles as every device that raises the turn does. Before it wrote, the record it reads at `N` is the
   * releaser's own, which it already holds: that is no rival. Anything above it (the releaser took the turn back at
   * `N + 2`, a third device forced it) is, and the table makes it yield (`undoStaging`, then `standby`).
   *
   * A device that wrote already (the app stopped while it settled) reads, puts the same stored bytes again, and waits
   * the whole of `T` from that put. Null for a `single` profile.
   */
  take(release: TurnRelease, turn: number): Promise<TurnOutcome | null> {
    return this.exclusive(async () => {
      const held = await this.held();
      if (!held) return null;
      if (held.record.state !== "taking") throw new Error("Only a device that holds a release takes the turn");
      const read = await this.readWith(held, true);
      if (!read.good) return { kind: "wait", read };
      // A record below the turn the release names is the releaser's (its last, or a later `rev` of it this device never
      // stored): a release is for the turn above it by construction. One at or above that turn is a rival.
      const below = (read.result === "other" || read.result === "behind") && !!read.record && read.record.turn < turn;
      const fresh = read.result === "none" || read.result === "behind" || below;
      if (held.wrote && held.storedRecord?.turn === turn) {
        if (read.result !== "mine" && !fresh) return this.settle(held, read, true);
        held.record = await this.store.amend(this.options.profile, { settle: undefined });
        await this.put(held, held.stored!, conditionsAfter(read, read.result === "none" ? "none" : "seen"), true);
        return this.settle(held, await this.readWith(held), true);
      }
      // Something other than the releaser's record it already holds: the table says what (yield, a tombstone, wait).
      if (!fresh) return this.settle(held, read, true);
      try { await this.writeWith(held, read.conditions, { turn, release }, true); } catch (error) {
        if (error instanceof TurnClosedError) return this.exhausted(held, "taking", read);
        if (error instanceof TurnStaleReadError) return { kind: "wait", read };
        throw error;
      }
      return this.settle(held, await this.readWith(held), true);
    });
  }

  /**
   * Reads the turn and does what the device's state asks for on the result (`turnAction`), until there is something
   * for the host to do. `atStart`: the read an `active` device makes as a condition of starting. A `single` profile
   * comes back at once, with no read and no put.
   */
  check(atStart: boolean): Promise<TurnOutcome> {
    return this.exclusive(async () => {
      const held = await this.held();
      if (!held) return { kind: "single" };
      return this.settle(held, await this.readWith(held), atStart);
    });
  }

  /** From a read to an outcome: every round ends in an outcome or in one more read. */
  private async settle(held: Held, first: TurnRead, atStart: boolean): Promise<TurnOutcome> {
    let read = first;
    let behind = 0, unconfirmed = 0, settled = false;
    // The rounds are bounded by the `behind` rule, by refusals and by the settle read.
    for (let round = 0; round < 12; round++) {
      behind = read.result === "behind" ? behind + 1 : 0;
      const row = turnRow(held.record.state, atStart);
      const active = row === "active-start" || row === "active-running";
      if (held.wroteNow && active) {
        if (read.result === "mine") {
          // A turn it took by a release to itself: it stays active, and reads once more after T.
          if (held.selfRaised && !settled) {
            settled = true;
            read = await this.settledRead(held) ?? await this.readWith(held);
            held.record = await this.store.amend(this.options.profile, { settle: undefined });
            continue;
          }
          // The record of this check is written, and a source returned it as the highest: not written a second time.
          return row === "active-start" ? { kind: "start", read } : { kind: "go-on", restricted: false, read };
        }
        // Written, and no source returned it (every put failed, or the sources lost it): the same bytes are put
        // again, a few times. A device does not start on a record no source holds.
        if (read.result === "none" || read.result === "behind" || read.result === "unreachable" || read.result === "closed") {
          if (!read.good || ++unconfirmed > BEHIND_ROUNDS) return row === "active-start" ? { kind: "ask", read } : { kind: "go-on", restricted: true, read };
          await this.put(held, held.stored!, read.conditions);
          read = await this.readWith(held);
          continue;
        }
      }
      // A taking device that reads its own turn back is active only at its settle read, T after its put: by then
      // every device that read the old record has put, and the highest sequence is there to see.
      if (row === "taking" && read.result === "mine" && !settled) {
        const settledRead = await this.settledRead(held);
        // Not every source that took the put answered: no settle read. It waits, and reads again.
        if (!settledRead) return { kind: "wait", read };
        settled = true;
        read = settledRead;
        continue;
      }
      let outcome: TurnOutcome | null;
      try { outcome = await this.carryOut(held, row, turnAction(row, read, behind), read); } catch (error) {
        // No record can be written above what this device saw: it does what it does when it cannot read the turn.
        if (error instanceof TurnClosedError) return this.exhausted(held, row, read);
        // A taking device's put would be sent more than P after the start of its read: it starts over with a read.
        if (!(error instanceof TurnStaleReadError)) throw error;
        outcome = null;
      }
      if (outcome) return outcome;
      // A taking device that put again settles again.
      if (row === "taking") settled = false;
      read = await this.readWith(held, row === "taking");
    }
    // Sources that keep refusing and keep answering lower: nothing more to try now.
    return atStart && held.record.state === "active" ? { kind: "ask", read } : { kind: "wait", read };
  }

  /** The outcome of a device that can write nothing above what it saw: its `unreachable` cell, marked. */
  private async exhausted(held: Held, row: TurnRow, read: TurnRead): Promise<TurnOutcome> {
    const outcome = await this.carryOut(held, row, turnAction(row, { result: "closed" }), read);
    return { ...(outcome ?? { kind: "wait", read }), exhausted: true };
  }

  /** One action. Null: read again. */
  private async carryOut(held: Held, row: TurnRow, action: TurnAction, read: TurnRead): Promise<TurnOutcome | null> {
    const writer = row === "active-start" || row === "active-running";
    switch (action.do) {
      case "write": {
        await this.writeWith(held, conditionsAfter(read, action.condition));
        // Read back: a refusal means someone else wrote, and a device goes on only with a record a source returned.
        return null;
      }
      case "put": {
        if (!held.stored) return action.then === "read" ? { kind: "wait", read } : { kind: "go-on", restricted: false, read };
        // Something that verified under the turn key is above this device's own record, and it is no valid record:
        // the stored packet would be refused there as older for ever. An active device writes its next record above it.
        if (writer && held.wrote && BigInt(held.record.seenSequence ?? 0) > BigInt(held.storedRecord!.sequence)) {
          return this.carryOut(held, row, { do: "write", condition: action.condition, then: row === "active-start" ? "start" : "go-on" }, read);
        }
        const report = await this.put(held, held.stored, conditionsAfter(read, action.condition));
        if (action.then === "read" || report.refused) return null;
        return { kind: "go-on", restricted: false, read };
      }
      case "become": {
        const takeover = held.record.state === "taking" && held.record.handoff?.step.startsWith(TAKEOVER) ? held.record.handoff.step.slice(TAKEOVER.length) as StoredDeviceState : null;
        // A device that was forcing a takeover has no staged state, and goes back to the state it had.
        const state = takeover && action.undo === "staging" ? takeover : action.state;
        if (action.undo === "staging" && !takeover) {
          if (!this.options.undoStaging) throw new Error("A taking device needs its staged state undone before it steps back");
          await this.options.undoStaging();
        }
        // A forced takeover that settled as this device's own: one more takeover in the life of the profile, and the
        // counters raised before the engine starts (WISP 06 § Raised counters), in the same write as `active`, so a
        // crash between the two cannot start the engine on the old counters.
        const won = !!takeover && state === "active";
        const takeovers = held.record.takeovers + 1;
        // The copy: an active device runs the profile and holds none apart; one replaced keeps its own, frozen.
        const was = held.record.state;
        const copy = state === "active" ? { copy: undefined } : state === "superseded" && (was === "active" || was === "releasing") ? { copy: "frozen" as const } : {};
        // Replaced: which device took the turn, and the set as its record lists it (a restored copy may hold a slot of
        // its own), so the screen names it and a handoff back can reach it. Only from a record that still lists this
        // device in its own slot; the turn and the packet stay this device's own, below the mark it keeps.
        const listed = read.record?.slots[held.ownSlot];
        const replacedBy = state === "superseded" && read.result === "other" && read.record && !!listed && toBase64Url(listed.key) === toBase64Url(held.ownKey)
          ? { activeSlot: read.record.active, deviceSet: deviceSetOf(read.record) } : {};
        held.record = await this.store.move(this.options.profile, state, {
          ...(takeover ? { handoff: undefined } : {}), ...(held.record.settle ? { settle: undefined } : {}), ...copy, ...replacedBy,
          ...(won ? { takeovers, raise: pendingRaise("takeover", takeovers, this.now()) } : {}),
        });
        if (!action.then) return { kind: "gated", state, reload: action.reload, ...(action.notice ? { notice: action.notice } : {}), read };
        return this.carryOut(held, turnRow(state as DeviceState, true), action.then, read);
      }
      case "start": return { kind: "start", read };
      case "ask": return { kind: "ask", read };
      case "go-on": return { kind: "go-on", restricted: action.restricted, read };
      case "show": {
        // A standby keeps the last record it accepted: what it shows, and what a `set-update` is checked against.
        // Only a record that lists this device in its own slot: one that does not (a relay that lags behind the record
        // that added this device, or an enrollment the active device never finished) would take this device's own
        // slot out of its record, and with it its key and its links.
        const listed = read.record?.slots[held.ownSlot];
        if (read.result === "other" && !read.known && read.record && read.payload && !!listed && toBase64Url(listed.key) === toBase64Url(held.ownKey)) {
          held.record = await this.store.amend(this.options.profile, { turn: read.record.turn, rev: read.record.rev, turnPacket: toBase64Url(read.payload), activeSlot: read.record.active, deviceSet: deviceSetOf(read.record) });
        }
        const active = held.record.activeSlot === undefined ? undefined : held.record.deviceSet[held.record.activeSlot]?.name;
        // The device this one released the turn to: its own release names it (the taker's record is not out yet).
        const taker = held.record.handoff?.release?.to;
        const to = taker ? held.record.deviceSet.find((slot) => slot?.key === taker)?.name : undefined;
        const device = action.screen === "moving-to" ? to : action.screen === "cannot-check" ? undefined : active;
        return { kind: "show", screen: action.screen, ...(device ? { device } : {}), ...(read.forced && !read.known ? { forced: true } : {}), read };
      }
      case "wait": return { kind: "wait", read };
      case "stay": return { kind: "stay", offers: action.offers, ...(action.awaits ? { awaits: action.awaits } : {}), read };
      case "impossible": return { kind: "impossible", row, read };
    }
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => {}).then(work);
    this.queue = run;
    return run;
  }
}
