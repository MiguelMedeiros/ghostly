import { bytesEqual } from "./bytes";
import { readTurnPacket, TOMBSTONE_SEQUENCE, type TurnKeys, type TurnPacketRead, type TurnRecord, type TurnRefusal } from "./turnRecord";

/*
 * Reading the turn (WISP 06 § Publishing and reading): every source is asked, every answer is verified and opened,
 * and the highest sequence among them is compared with the packet this device stored. The stored packet is never an
 * answer itself. This file is the comparison alone, a pure function of what the sources said; who asks them is
 * `TurnNetwork` (`relay.ts` for the browsers, the Desktop's Rust for the DHT and its relays).
 */

/** One source's answer to a read: a relay, or the DHT itself. */
export interface TurnSourceAnswer {
  /** The relay's address, or `dht`. */
  source: string;
  /** Whether it answered at all. A source that answers "no record" answered. */
  answered: boolean;
  /** The packets it returned, as relay payloads: one from a relay, every distinct item the nodes returned from the DHT. */
  payloads: Uint8Array[];
  /**
   * Sequences (decimal text) the source reports holding without handing the item over: an item under the key that is
   * no signed packet at all. Nobody signed that number, and the source could say anything: it is that source's put
   * condition and nothing else. It never counts as seen, never closes the address and never moves a writer's place.
   */
  sequences?: string[];
  /**
   * The answer may be minutes old: a relay that does not know `?policy=NetworkOnly` was asked plainly and answered
   * from its cache. Such an answer can show a newer record (that is never stale news), but never makes `mine` or
   * `none`, and alone it does not make a read good.
   */
  stale?: boolean;
  detail?: string;
}

/** What a source said to a put. `refused`: someone else wrote (301, 302 from a node; 409, 412, 428 from a relay). Read. */
export interface TurnSourcePut {
  source: string;
  outcome: "stored" | "refused" | "failed";
  detail?: string;
}

/**
 * What each source is known to hold, from the last read: its highest sequence (as decimal text), or null when it
 * answered that it has no record. A put goes only to the sources named here, each with its own condition: a source
 * that lags must not be compared with what another one holds. A source that did not answer the read is not put to.
 */
export type TurnConditions = Record<string, string | null>;

/** The turn's own way to the network: every source read, every put conditional, no answer hidden, nothing retried. */
export interface TurnNetwork {
  turnRead(pubKeyZ32: string): Promise<TurnSourceAnswer[]>;
  turnPut(pubKeyZ32: string, payload: Uint8Array, conditions: TurnConditions): Promise<TurnSourcePut[]>;
  /**
   * The profile has a device set: whatever a source needs before its first answer is made ready now (the Desktop's
   * own DHT node for the turn, which takes seconds to join). Never called for a profile on one device.
   */
  turnWarm?(): Promise<void>;
}

/*
 * Settle (WISP 06 § Settle: how a raised turn becomes active). No relay refuses the second of two puts, so a device
 * that reads its own record back straight after its put learns nothing. Every device that raises the turn reads, sends
 * its put within `P` of the start of that read (or reads again first), is `taking` after the put, waits `T` from the
 * end of the put, reads every source again, and goes active only on `mine`. The three numbers live here and nowhere else.
 */
/** `P`: a raising put is sent within this long of the start of the read it acts on. */
export const TURN_PUT_WINDOW_MS = 10_000;
/** `V`: the longest a put is assumed to take from being sent to being visible at every source. Assumed, not measured. */
export const TURN_VISIBLE_MS = 10_000;
/** `T`: how long a device that raised the turn waits, from the end of its put, before the read that may make it active. `T >= P + 2V`. */
export const TURN_SETTLE_MS = 30_000;

/** WISP 06 § Publishing and reading, the result table. */
export type TurnResult = "mine" | "behind" | "other" | "clone" | "tombstone" | "closed" | "none" | "unreachable";

/** Who reads: what this device holds. */
export interface TurnReader {
  keys: TurnKeys;
  /** This device's signing key. */
  ownKey: Uint8Array;
  /** The packet this device stored: its own last record, or (a device that never was active) the last record it accepted. */
  stored: Uint8Array | null;
  /** This device's slot, where it has one and the stored packet does not say (it is not listed there yet). */
  ownSlot?: number;
  /** A `taking` device: the turn it takes. It yields to any other valid record at that turn, whatever the sequences. */
  taking?: number;
  /**
   * The mark: the highest sequence this device ever saw at the address in a packet that verified under the turn key.
   * A record below it is no news (`behind`): a newer record that expired does not make an older one current again.
   */
  seen?: bigint;
}

export interface TurnRead {
  result: TurnResult;
  /** A read is good when at least one source answered and the result is not `closed`. */
  good: boolean;
  /**
   * The record the result is about: the highest valid one the sources hold (`mine`: this device's own; `behind`: the
   * lower one they hold; `other`, `clone`, `tombstone`: the one that outranks this device). Absent for `none` and `unreachable`.
   */
  record?: TurnRecord;
  /** That record's packet, to store when it is accepted. */
  payload?: Uint8Array;
  /** `clone`: above this device's stored sequence, or at an equal one. */
  clone?: "above" | "equal";
  /** `clone` at an equal sequence: whether this device's `instance` is the lower one. It then goes on and writes `rev` plus one at once. */
  lower?: boolean;
  /** `tombstone`: whether this device is still listed (`moving`) or not (`removed`). */
  listed?: boolean;
  /** `other`: the turn was taken without a release, or with one whose `from` was not the device this reader knew as active. */
  forced?: boolean;
  /** `other`: the record is the one this device already stored (a standby reading the active device's record again). */
  known?: boolean;
  /**
   * The highest sequence among the answers in a packet that verified under the turn key, its record valid or not.
   * 0 when there was none. What moves the device's mark; a number a source only reports never does.
   */
  seen: bigint;
  /** Packets under the turn key that are no valid record, with the rule each breaks. Signed by the turn key, every one. */
  invalid: { source: string; sequence: bigint; refusal: TurnRefusal }[];
  /** Sequences a source named for an item it did not hand over (`TurnSourceAnswer.sequences`): unsigned, so only reported. */
  unsigned: { source: string; sequence: bigint }[];
  /** Per source that answered: the highest raw sequence it holds, for the next put's conditions. */
  conditions: TurnConditions;
}

/** A valid packet, once however many sources returned it, with every one of them. */
interface Found { sources: string[]; payload: Uint8Array; read: Extract<TurnPacketRead, { kind: "valid" }> }
type Kept = { record: TurnRecord; payload: Uint8Array };

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/**
 * Of two valid records at one sequence, the one every reader keeps: the lower `instance` (WISP 06 § Record); negative
 * when that is `a`. Never a library's own rule: the `pkarr` crate prefers the larger encoded bytes, which for a sealed
 * record is random. Two records with one `instance` are told apart by their bodies, then by their packets, so every
 * reader still agrees.
 */
export function keptAtEqualSequence(a: Kept, b: Kept): number {
  return compareBytes(a.record.instance, b.record.instance) || compareBytes(a.record.body, b.record.body) || compareBytes(a.payload, b.payload);
}

const kept = (f: Found): Kept => ({ record: f.read.record, payload: f.payload });

/** The result of a read: what the answers of every source mean for this device. */
export function classifyTurnRead(reader: TurnReader, answers: TurnSourceAnswer[]): TurnRead {
  const { keys } = reader;
  const invalid: TurnRead["invalid"] = [];
  const unsigned: TurnRead["unsigned"] = [];
  const conditions: TurnConditions = {};
  const found: Found[] = [];
  let seen = 0n, good = false;
  /** Sources whose answer is fresh: only they can say `mine` or `none`. */
  const fresh = new Set<string>();
  for (const answer of answers) {
    if (!answer.answered) continue;
    if (!answer.stale) { good = true; fresh.add(answer.source); }
    let top: bigint | null = null;
    for (const payload of answer.payloads) {
      const read = readTurnPacket(keys, payload);
      // Not a packet under the turn key: no honest source stores it, so it is no record and its number means nothing.
      if (read.kind === "foreign") continue;
      if (top === null || read.sequence > top) top = read.sequence;
      if (read.kind === "invalid") { invalid.push({ source: answer.source, sequence: read.sequence, refusal: read.refusal }); continue; }
      const known = found.find((f) => bytesEqual(f.payload, payload));
      if (known) known.sources.push(answer.source); else found.push({ sources: [answer.source], payload, read });
    }
    if (top !== null && top > seen) seen = top;
    // What the source says it holds without showing it: its condition, so a put there names it, and nothing more.
    let named = top;
    for (const text of answer.sequences ?? []) {
      if (!/^\d{1,19}$/.test(text)) continue;
      const sequence = BigInt(text);
      unsigned.push({ source: answer.source, sequence });
      if (named === null || sequence > named) named = sequence;
    }
    conditions[answer.source] = named === null ? null : named.toString();
  }
  // A packet under the turn key at or above the tombstone's sequence that is no valid tombstone: only a holder of `D`
  // can have made it, and nothing can be put above it. Never a good read; a valid tombstone at that sequence wins.
  const top = BigInt(TOMBSTONE_SEQUENCE);
  const closing = invalid.reduce((max, packet) => (packet.sequence > max ? packet.sequence : max), 0n);
  if (closing >= top && (closing > top || !found.some((f) => f.read.record.tombstone))) return { result: "closed", good: false, seen, invalid, unsigned, conditions };
  const base = { good, seen, invalid, unsigned, conditions };
  // A newer record is news whoever shows it; the answers of a stale source show nothing else.
  const freshFound = found.filter((f) => f.sources.some((source) => fresh.has(source)));
  if (!good && !found.length) return { result: "unreachable", ...base };
  if (!found.length) return { result: "none", ...base };
  /** The mark, this read included. */
  const mark = reader.seen !== undefined && reader.seen > seen ? reader.seen : seen;

  // The highest sequence wins; at an equal one, the lower instance, for every reader alike.
  const best = found.reduce((a, b) => (b.read.sequence > a.read.sequence || (b.read.sequence === a.read.sequence && keptAtEqualSequence(kept(b), kept(a)) < 0) ? b : a));
  const record = best.read.record, payload = best.payload;
  const ownAt = (r: TurnRecord): number => r.slots.findIndex((slot) => !!slot && bytesEqual(slot.key, reader.ownKey));

  if (record.tombstone) return { result: "tombstone", record, payload, listed: ownAt(record) >= 0, ...base };

  const held = reader.stored ? readTurnPacket(keys, reader.stored) : null;
  if (held && held.kind !== "valid") throw new Error("The stored turn packet is not a valid record");
  const stored = held?.record ?? null;
  const ownSlot = reader.ownSlot ?? (stored ? ownAt(stored) : -1);
  const fromOwnSlot = (r: TurnRecord) => ownSlot >= 0 && r.author === ownSlot;
  /** Whether this device wrote the packet it stored. */
  const wrote = !!stored && fromOwnSlot(stored) && bytesEqual(stored.slots[stored.author]!.key, reader.ownKey);
  const activeKey = stored && !stored.tombstone ? stored.slots[stored.active]?.key : undefined;
  const other = (f: Found, extra: Partial<TurnRead> = {}): TurnRead => {
    const release = f.read.record.release;
    // Without a release, or released by a device this reader did not know as active: a takeover. A reader that
    // holds no record of the set yet takes the first valid one as current and shows no takeover for it: the first
    // record of a set has no release, and without an earlier record that cannot be told from a takeover.
    const forced = !!stored && (!release || (!!activeKey && !bytesEqual(f.read.record.slots[release.from]!.key, activeKey)));
    return { result: "other", record: f.read.record, payload: f.payload, forced, ...extra, ...base };
  };
  const clone = (f: Found, extra: Partial<TurnRead>): TurnRead => ({ result: "clone", record: f.read.record, payload: f.payload, ...extra, ...base });

  // A taking device yields to any other valid record at its turn, whatever the sequences: a third device that forced
  // the same turn is not overridden by a taker in a higher slot.
  if (reader.taking !== undefined) {
    const rival = found.find((f) => f.read.record.turn === reader.taking && !(reader.stored && bytesEqual(f.payload, reader.stored)) && !fromOwnSlot(f.read.record));
    if (rival) return other(rival);
  }

  // From this device's own slot, and never stored here: another copy of this device's storage wrote it, or a second
  // restored copy took the same free slot.
  if (!stored) return fromOwnSlot(record) ? clone(best, { clone: "above" }) : other(best);

  const storedSequence = BigInt(stored.sequence);
  if (best.read.sequence < storedSequence) return good ? { result: "behind", record, payload, ...base } : { result: "unreachable", ...base };
  if (best.read.sequence > storedSequence) {
    // Above what this device stored, and below something it saw before: the newer record expired, or a source lags.
    if (reader.seen !== undefined && best.read.sequence < reader.seen) return good ? { result: "behind", record, payload, ...base } : { result: "unreachable", ...base };
    return fromOwnSlot(record) ? clone(best, { clone: "above" }) : other(best);
  }

  // At the stored sequence. The stored packet itself and nothing else there: this device's own record, or the one it
  // already accepted from the active device.
  const rivals = found.filter((f) => f.read.sequence === storedSequence && !bytesEqual(f.payload, reader.stored!));
  if (!rivals.length) {
    // The record this device already accepted from the active device; below its mark, it is no news.
    if (!wrote) return mark > storedSequence && good ? { result: "behind", record, payload, ...base } : other(best, { known: true });
    // `mine` needs a fresh source that returned the stored packet (a stale one alone: no fresh answer says so), and
    // nothing this device ever saw verified above it.
    if (mark <= storedSequence && freshFound.some((f) => bytesEqual(f.payload, reader.stored!))) return { result: "mine", record, payload, ...base };
    return good ? { result: "behind", record, payload, ...base } : { result: "unreachable", ...base };
  }
  // An equal sequence is an equal turn, rev and slot. In another device's slot, that device and its copy settle it.
  if (!wrote) return other(best);
  const rival = rivals.reduce((a, b) => (keptAtEqualSequence(kept(b), kept(a)) < 0 ? b : a));
  return clone(rival, { clone: "equal", lower: keptAtEqualSequence({ record: stored, payload: reader.stored! }, kept(rival)) < 0 });
}

/** A put's answers in short. `refused` anywhere means someone else wrote: read, and never put again without the condition. */
export function turnPutSummary(puts: TurnSourcePut[]): { stored: number; refused: number; failed: number } {
  const count = (outcome: TurnSourcePut["outcome"]) => puts.filter((p) => p.outcome === outcome).length;
  return { stored: count("stored"), refused: count("refused"), failed: count("failed") };
}
