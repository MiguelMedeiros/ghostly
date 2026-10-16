import {
  contactDay, knockHolds, seenEntry, MAX_SEEN, STAMP_BITS_DEFAULT, STAMP_BITS_MAX,
  type ContactKnock, type LinkRecord,
} from "./contactRecords";

/*
 * The owner's side of a contact link's limits (WISP 8xx § Limits), as a pure state the engine keeps per link: which
 * knocks to read, what goes in Requests, when the link is busy and how hard its stamp is. Nothing here talks to a relay.
 */

export const MAX_WAITING = 32;
/** Below this many waiting, a busy link opens again. */
export const REOPEN_BELOW = 24;
export const NEW_PER_HOUR = 12;
/** Good knocks a day could not take before the next day asks for 2 more bits. */
export const FLOOD_PER_DAY = 60;
/** The most asker keys `missed` keeps: the owner sees "256 or more". */
export const MAX_MISSED = 256;
/** The most accepted and declined keys kept, the oldest dropped first: a week and more at the hourly cap. */
export const MAX_DONE = 4096;
const HOUR_MS = 3_600_000;
const SEEN_FOR_MS = 7 * 24 * HOUR_MS;

export interface InboxState {
  /** `off` is for good: nothing is read again. */
  state: LinkRecord["state"];
  bits: number;
  /** Asker keys in Requests, with when each request ends. */
  waiting: Array<{ key: string; expires: number }>;
  /** Asker keys accepted or declined: never read again on this link (the latest `MAX_DONE`). */
  done: string[];
  /** The `seen` entries, newest first, with when each was put there. */
  seen: Array<{ entry: string; at: number }>;
  /** When each asker key's request was last read, taken or not (one read an hour). */
  reads: Record<string, number>;
  /** When each of the last hour's new requests was taken. */
  taken: number[];
  /** The UTC day `overflow` counts for, and how many good knocks it could not take. */
  day: number;
  overflow: number;
  /** Distinct asker keys that knocked while the link was busy, since the owner last looked, at most `MAX_MISSED`. */
  missed: string[];
}

export function newInbox(now: number): InboxState {
  return { state: "open", bits: STAMP_BITS_DEFAULT, waiting: [], done: [], seen: [], reads: {}, taken: [], day: contactDay(now), overflow: 0, missed: [] };
}

/** What the owner publishes under the link key. */
export function inboxRecord(inbox: InboxState, now: number): LinkRecord {
  return { state: inbox.state, bits: inbox.bits, seen: inbox.seen.filter(s => now - s.at < SEEN_FOR_MS).slice(0, MAX_SEEN).map(s => s.entry) };
}

function withSeen(inbox: InboxState, entry: string, now: number): InboxState["seen"] {
  return [{ entry, at: now }, ...inbox.seen.filter(s => s.entry !== entry)].slice(0, MAX_SEEN);
}

/** A new day: the bits go up by 2 after a flooded day, otherwise back down by 2 towards the default. */
function rollDay(inbox: InboxState, now: number): InboxState {
  const day = contactDay(now);
  if (day === inbox.day) return inbox;
  const flooded = day === inbox.day + 1 && inbox.overflow > FLOOD_PER_DAY;
  const bits = flooded ? Math.min(STAMP_BITS_MAX, inbox.bits + 2) : Math.max(STAMP_BITS_DEFAULT, inbox.bits - 2);
  return { ...inbox, day, overflow: 0, bits };
}

export interface KnockPlan {
  inbox: InboxState;
  /** Asker keys whose `_req` to read now, in the order they knocked. */
  read: string[];
  /** Whether the link record changed (a `seen` entry put back) and should be published. */
  publish: boolean;
}

/**
 * What to do with the knocks of one poll. A key already handled is put back in `seen` without a read; a new key is
 * read once an hour at most, while the link is open and the hour has room. Knocks whose stamp fails count for nothing.
 */
export function planKnocks(linkKeyZ32: string, inbox: InboxState, knocks: ContactKnock[], now: number): KnockPlan {
  let next = rollDay(inbox, now);
  if (next.state === "off") return { inbox: next, read: [], publish: next !== inbox };
  const taken = next.taken.filter(t => now - t < HOUR_MS);
  // Only the last hour's reads hold anything back: older ones are dropped, so a flood of keys leaves nothing behind.
  next = { ...next, reads: Object.fromEntries(Object.entries(next.reads).filter(([, at]) => now - at < HOUR_MS)) };
  // Never more than the hour leaves, nor more than the room left under `MAX_WAITING`.
  const room = Math.min(NEW_PER_HOUR - taken.length, MAX_WAITING - next.waiting.length);
  const read: string[] = [];
  let publish = next.bits !== inbox.bits;
  const keys = [...new Set(knocks.filter(k => knockHolds(linkKeyZ32, k, next.bits, now)).map(k => k.key))];
  for (const key of keys) {
    if (next.done.includes(key) || next.waiting.some(w => w.key === key)) {
      const entry = seenEntry(linkKeyZ32, key);
      if (!next.seen.some(s => s.entry === entry && now - s.at < SEEN_FOR_MS)) {
        next = { ...next, seen: withSeen(next, entry, now) };
        publish = true;
      }
      continue;
    }
    if (next.state === "busy") {
      if (next.missed.length < MAX_MISSED && !next.missed.includes(key)) next = { ...next, missed: [...next.missed, key] };
      next = { ...next, overflow: next.overflow + 1 };
      continue;
    }
    const last = next.reads[key];
    if (last !== undefined && now - last < HOUR_MS) continue;
    if (read.length >= room) {
      next = { ...next, overflow: next.overflow + 1 };
      continue;
    }
    read.push(key);
    next = { ...next, reads: { ...next.reads, [key]: now } };
  }
  return { inbox: { ...next, taken }, read, publish };
}

/** A request read and found good: into Requests, `seen`, and busy at `MAX_WAITING`. */
export function takeRequest(linkKeyZ32: string, inbox: InboxState, key: string, expires: number, now: number): InboxState {
  if (inbox.state !== "open" || inbox.waiting.length >= MAX_WAITING || inbox.done.includes(key) || inbox.waiting.some(w => w.key === key)) return inbox;
  const waiting = [...inbox.waiting, { key, expires }];
  return {
    ...inbox,
    waiting,
    seen: withSeen(inbox, seenEntry(linkKeyZ32, key), now),
    taken: [...inbox.taken.filter(t => now - t < HOUR_MS), now],
    state: waiting.length >= MAX_WAITING ? "busy" : inbox.state,
  };
}

/**
 * Out of Requests. Accepted or declined (`done`): never read again on this link. Ended unanswered (`ended`): its asker
 * may ask again and be read again, as the requester's side expects. Nothing changes in `seen`.
 */
export function settleRequest(inbox: InboxState, key: string, how: "done" | "ended" = "done"): InboxState {
  if (!inbox.waiting.some(w => w.key === key)) return inbox;
  const waiting = inbox.waiting.filter(w => w.key !== key);
  const reopen = inbox.state === "busy" && waiting.length < REOPEN_BELOW;
  const done = how === "done" ? [...inbox.done, key].slice(-MAX_DONE) : inbox.done;
  return { ...inbox, waiting, done, state: reopen ? "open" : inbox.state };
}

/** The asker keys whose request ended unanswered by `now`. Settle each one as `ended`. */
export function endedRequests(inbox: InboxState, now: number): string[] {
  return inbox.waiting.filter(w => w.expires <= now).map(w => w.key);
}

/** The owner saw the count of those who tried while the link was busy. */
export function clearMissed(inbox: InboxState): InboxState {
  return inbox.missed.length ? { ...inbox, missed: [] } : inbox;
}

/** The link turned off, for good. */
export function turnOff(inbox: InboxState): InboxState {
  return { ...inbox, state: "off" };
}
