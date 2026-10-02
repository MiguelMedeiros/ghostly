import {
  classifyTurnRead, fromBase64Url, nextTurnPosition, randomBytes, readTurnPacket, signTurnPacket, signTurnRelease, toBase64Url, turnKeys, turnPutSummary,
  type TurnConditions, type TurnFields, type TurnKeys, type TurnNetwork, type TurnRead, type TurnRecord, type TurnRelease, type TurnSigner, type TurnSourcePut,
} from "@ghostly/core";
import { MAX_DEVICES, type DevicePatch, type DeviceRecord, type DeviceSlot, type DeviceState, type StoredDeviceState } from "./state";
import { amendDevice, moveDevice, readDeviceRecord } from "./store";
import { turnAction, turnRow, type TurnAction, type TurnRow } from "./turnAction";

/*
 * The turn keeper (WISP 06 § The turn): one profile's turn record on this device. It reads every source, compares
 * the answers with the packet this device stored, writes the next record above everything it ever saw, and carries
 * out what the table says for the device's state (`turnAction.ts`), as far as that is the turn's own business: the
 * record, its puts, and the durable change of state. Starting the engine, reloading into the gate, the screens and
 * the staged state of a handoff are the host's, which gets them back as a `TurnOutcome`.
 *
 * The rules it keeps:
 * - a packet is stored durably before it is put, and put byte for byte ever after;
 * - a put goes to each source on that source's own condition, and a refusal is never tried again without it: a
 *   refusal means someone else wrote, and the answer is a read;
 * - a record it writes has a sequence above the highest raw one ever seen at the address;
 * - a `single` profile has no turn: nothing is read and nothing is put.
 *
 * The device signing key is not this part's: it comes in as `signer`.
 */

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
  /** A taking device that lost: moves the registry pointer back and drops the staged state, before `standby` is written. */
  undoStaging?: () => Promise<void>;
}

/** What the host does next. Every state change named here is already written durably. */
export type TurnOutcome =
  /** The profile has no device set. Nothing was read or put. */
  | { kind: "single" }
  /** Start the engine: this device is the active one and its record is written. */
  | { kind: "start"; read: TurnRead }
  /** The engine goes on. `restricted`: no wallet opened, no spend, no admin work until a good read. */
  | { kind: "go-on"; restricted: boolean; read: TurnRead }
  /** Do not start: "Can't check which device is active", Try again or Start anyway (limited mode). */
  | { kind: "ask"; read: TurnRead }
  /** The device is no longer (or not) the active one. `reload`: into the gate, at once. */
  | { kind: "gated"; state: StoredDeviceState; reload: boolean; notice?: "another-copy"; read: TurnRead }
  /** A standby's screen. `device`: the name of the active device, or the one the turn moves to. */
  | { kind: "show"; screen: "moving-to" | "active-on" | "last-known" | "cannot-check"; device?: string; forced?: boolean; read: TurnRead }
  | { kind: "wait"; read: TurnRead }
  | { kind: "stay"; offers: ("use-here" | "it-wasnt-me" | "add-again")[]; awaits?: "set-update"; read: TurnRead }
  /** The address takes no ordinary record any more, and what closed it is no valid tombstone. */
  | { kind: "closed"; read: TurnRead }
  | { kind: "impossible"; row: TurnRow; read: TurnRead };

/** A put of the turn record, every source's answer included. */
export interface TurnPutReport {
  payload: Uint8Array;
  puts: TurnSourcePut[];
  /** A source refused: someone else wrote. The next thing to do is a read. */
  refused: boolean;
}

/** The address holds something at or above the last sequence an ordinary record can have. */
export class TurnClosedError extends Error {
  constructor() {
    super("The turn address takes no further record");
    this.name = "TurnClosedError";
  }
}

const sequenceToStore = (sequence: bigint): number => Number(sequence > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : sequence);
/**
 * The conditions of a put after a read. Each source is compared with what that source held, so one that held no
 * record gets none by itself, and one that holds anything, valid or not, is put to on that sequence. Only a writer
 * that read `behind` to the end puts with no condition at all (WISP 06 § Publishing and reading, `behind`).
 */
const conditionsAfter = (read: TurnRead, condition: "seen" | "none"): TurnConditions =>
  (condition === "none" && read.result === "behind" ? Object.fromEntries(Object.keys(read.conditions).map((source) => [source, null])) : read.conditions);

/** The record's slots as the device state keeps them. */
export function deviceSetOf(record: TurnRecord): (DeviceSlot | null)[] {
  return record.slots.map((slot) => slot && { key: toBase64Url(slot.key), name: slot.name });
}

interface Held { record: DeviceRecord; keys: TurnKeys; ownSlot: number; ownKey: Uint8Array; stored: Uint8Array | null; storedRecord: TurnRecord | null; wrote: boolean }

export class TurnKeeper {
  private readonly store: TurnStore;
  private readonly now: () => number;
  private lastGoodAt: number | null = null;
  /** Reads and puts are made one after the other: two checks at once would race each other's writes. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: TurnKeeperOptions) {
    this.store = options.store ?? realStore;
    this.now = options.now ?? Date.now;
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

  /** One read of every source, compared with the stored packet. The highest raw sequence seen is kept, durably. */
  private async readWith(held: Held): Promise<TurnRead> {
    const answers = await this.options.network.turnRead(held.keys.identity.pubKeyZ32);
    const read = classifyTurnRead({
      keys: held.keys, ownKey: held.ownKey, stored: held.stored, ownSlot: held.ownSlot,
      ...(held.record.state === "taking" ? { taking: held.record.turn } : {}),
    }, answers);
    if (read.good) this.lastGoodAt = this.now();
    const seen = sequenceToStore(read.seen);
    if (seen > (held.record.seenSequence ?? 0)) held.record = await this.store.amend(this.options.profile, { seenSequence: seen });
    return read;
  }

  /** One read. Null for a `single` profile, which has no turn: no source is asked. */
  read(): Promise<TurnRead | null> {
    return this.exclusive(async () => {
      const held = await this.held();
      return held ? this.readWith(held) : null;
    });
  }

  /** Puts the stored packet again, unchanged, on the conditions given (the last read's). */
  putStored(conditions: TurnConditions): Promise<TurnPutReport | null> {
    return this.exclusive(async () => {
      const held = await this.held();
      return held?.stored ? this.put(held, held.stored, conditions) : null;
    });
  }

  private async put(held: Held, payload: Uint8Array, conditions: TurnConditions): Promise<TurnPutReport> {
    const puts = await this.options.network.turnPut(held.keys.identity.pubKeyZ32, payload, conditions);
    return { payload, puts, refused: turnPutSummary(puts).refused > 0 };
  }

  /**
   * Writes this device's next record as the active one: signed, sealed, stored durably, and only then put. In its own
   * turn that is `rev` plus one with a new `instance`; `turn` and `release` are for a device that takes the turn (a
   * handoff's taker with the release it holds, a forced takeover with none). The sequence is above the highest raw
   * one ever seen. When `rev` runs out, or something was seen above the turn, the record is the next turn's with a
   * release from this device to itself. Throws `TurnClosedError` when the address takes no further record.
   */
  write(conditions: TurnConditions, options: { turn?: number; release?: TurnRelease; slots?: (DeviceSlot | null)[] } = {}): Promise<TurnPutReport | null> {
    return this.exclusive(async () => {
      const held = await this.held();
      return held ? this.writeWith(held, conditions, options) : null;
    });
  }

  private async writeWith(held: Held, conditions: TurnConditions, options: { turn?: number; release?: TurnRelease; slots?: (DeviceSlot | null)[] } = {}): Promise<TurnPutReport> {
    const { record, keys, ownSlot, ownKey, storedRecord, wrote } = held;
    const turn = options.turn ?? record.turn;
    const lastRev = wrote && storedRecord!.turn === turn ? storedRecord!.rev : null;
    const place = nextTurnPosition(turn, lastRev, ownSlot, record.seenSequence ?? 0);
    if (!place) throw new TurnClosedError();
    const set = options.slots ?? record.deviceSet;
    const slots = Array.from({ length: MAX_DEVICES }, (_, i) => { const slot = set[i]; return slot ? { key: fromBase64Url(slot.key), name: slot.name } : null; });
    // A release is the turn's: every record of a turn carries the one the turn was taken with. A turn this device
    // had to raise by itself carries its release to itself.
    let release = options.release ?? (wrote && storedRecord!.turn === place.turn ? storedRecord!.release : undefined);
    // A release names its turn: one given for a turn that can no longer be written is of no use.
    if (place.raised && options.release) throw new Error("Something was seen above the turn this release names");
    if (place.raised) release = await signTurnRelease(keys.address, place.turn, ownSlot, ownSlot, ownKey, new Uint8Array(32), this.options.signer);
    const fields: TurnFields = { turn: place.turn, rev: place.rev, author: ownSlot, active: ownSlot, slots, instance: (this.options.instance ?? (() => randomBytes(8)))(), ...(release ? { release } : {}) };
    const payload = await signTurnPacket(keys, fields, this.options.signer);
    // Stored before it is put: what this device finds on the network after a crash is never newer than what it holds.
    held.record = await this.store.amend(this.options.profile, { turn: place.turn, rev: place.rev, turnPacket: toBase64Url(payload), activeSlot: ownSlot, ...(options.slots ? { deviceSet: options.slots } : {}) });
    held.stored = payload;
    const read = readTurnPacket(keys, payload);
    held.storedRecord = read.kind === "valid" ? read.record : null;
    held.wrote = true;
    return this.put(held, payload, conditions);
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
      let behind = 0;
      // Every round ends in an outcome or in one more read; the rounds are bounded by the `behind` rule and by refusals.
      for (let round = 0; round < 8; round++) {
        const read = await this.readWith(held);
        behind = read.result === "behind" ? behind + 1 : 0;
        const row = turnRow(held.record.state, atStart);
        const outcome = await this.carryOut(held, row, turnAction(row, read, behind), read);
        if (outcome) return outcome;
      }
      // Sources that keep refusing and keep answering lower: nothing more to try now.
      return { kind: "wait", read: await this.readWith(held) };
    });
  }

  /** One action. Null: read again. */
  private async carryOut(held: Held, row: TurnRow, action: TurnAction, read: TurnRead): Promise<TurnOutcome | null> {
    const writer = row === "active-start" || row === "active-running";
    switch (action.do) {
      case "write": {
        if (read.closed) return { kind: "closed", read };
        const report = await this.writeWith(held, conditionsAfter(read, action.condition));
        // A refused put of its own record: someone else wrote. The read says who.
        if (report.refused) return null;
        return action.then === "start" ? { kind: "start", read } : { kind: "go-on", restricted: false, read };
      }
      case "put": {
        if (!held.stored) return action.then === "read" ? { kind: "wait", read } : { kind: "go-on", restricted: false, read };
        // Something above this device's own record is on a source, and it is no valid record: the stored packet
        // would be refused there as older for ever. An active device writes its next record above it.
        if (writer && held.wrote && BigInt(held.record.seenSequence ?? 0) > BigInt(held.storedRecord!.sequence)) {
          return this.carryOut(held, row, { do: "write", condition: action.condition, then: row === "active-start" ? "start" : "go-on" }, read);
        }
        const report = await this.put(held, held.stored, conditionsAfter(read, action.condition));
        if (action.then === "read" || report.refused) return null;
        return { kind: "go-on", restricted: false, read };
      }
      case "become": {
        if (action.undo === "staging") {
          if (!this.options.undoStaging) throw new Error("A taking device needs its staged state undone before it steps back");
          await this.options.undoStaging();
        }
        held.record = await this.store.move(this.options.profile, action.state);
        if (!action.then) return { kind: "gated", state: action.state, reload: action.reload, ...(action.notice ? { notice: action.notice } : {}), read };
        return this.carryOut(held, turnRow(action.state as DeviceState, true), action.then, read);
      }
      case "start": return { kind: "start", read };
      case "ask": return { kind: "ask", read };
      case "go-on": return { kind: "go-on", restricted: action.restricted, read };
      case "show": {
        // A standby keeps the last record it accepted: what it shows, and what a `set-update` is checked against.
        if (read.result === "other" && !read.known && read.record && read.payload) {
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
