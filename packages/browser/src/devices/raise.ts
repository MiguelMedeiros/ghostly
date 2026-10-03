import { engineText, randomBytes, toBase64Url, type PaymentReview } from "@ghostly/core";
import type { StoredLink } from "../shared/types";

/*
 * Raised counters (WISP 06 § Raised counters, § Forced takeover). A copy of a profile started from older state (a
 * forced takeover from a standby's frozen copy, a backup restored) holds old outgoing counters: a contact drops
 * anything at or under its high-water mark, silently, and a group member drops a frame it counts as already seen. So
 * before the engine starts such a copy raises, once, exactly these:
 *
 * - each chat's DHT mailbox `sequence`, capability record `rev` (with `publishedAt` cleared, so the raised revision
 *   goes out), hold `outSeq` and hold `pointerRev`: to `max(value + S, floor)`;
 * - the group send counter, mesh and community: a floor every epoch and every new head starts at (the group sessions
 *   read it through `seqFloor`), so a copy that catches up to the next epoch does not send from 0 again there.
 *
 * Not raised: edit numbers, pin numbers (clock-bound), reaction numbers (the clock already), message ids (random),
 * incoming high-water marks.
 *
 * The floor. The WISP's `takeovers * S` gives two copies restored from one backup the same floor (they carry the same
 * count), and the second one's first messages are dropped where the first one already sent: the bug this part fixes.
 * The only thing that tells two such copies apart is when each started, so the floor is the highest of
 *   - the floor the profile had, plus `S` (it only rises along one line of copies, whatever the clock says);
 *   - the takeover count times `S` (the WISP's rule, kept);
 *   - the seconds since 2026-01-01 when the copy starts (a later copy starts above an earlier one as long as the
 *     earlier one sent less than one frame a second since; the same reason reaction numbers are the clock).
 * The community beacon packs the counter in 32 bits: in seconds that lasts past the year 2160, and the stride leaves
 * room for about 4,000 rapid takeovers. `MAX_COUNTER_FLOOR` keeps 2^24 numbers free above any floor.
 *
 * The rest of what a copy from older state does before it starts is here too, since it is the same one-time pass over
 * the same database: payment attempts that were not finished become `unknown` and are only looked up; those that
 * hold signed bytes or a signed transaction (USDT, on-chain Bitcoin, Ark) are parked and never broadcast again; the
 * on-chain wallet scans again from the start and drops its reservations; and group admin work is off in every group
 * until the person turns it on there.
 */

/** The stride `S` (WISP 06 § Raised counters). */
export const RAISE_STRIDE = 2 ** 20;
/** The clock part of the floor counts seconds from here. */
export const FLOOR_CLOCK_START_MS = Date.UTC(2026, 0, 1);
/** A clock past this is not plausible, and adds nothing to the floor. */
export const FLOOR_CLOCK_LIMIT_MS = Date.UTC(2100, 0, 1);
/** No floor above this: 2^24 numbers stay free under the community beacon's 32 bits. */
export const MAX_COUNTER_FLOOR = 2 ** 32 - 2 ** 24;

/** The settings row that holds the floor and the raise it came from. */
export const COUNTER_RAISE_KEY = "counterRaise";
/** The settings row a restore writes: a raise the engine makes at its first start. */
export const PENDING_RAISE_KEY = "pendingRaise";
/** The settings row of the groups whose admin work is off on this device. */
export const GROUP_ADMIN_OFF_KEY = "groupAdminOff";

/** Why the counters are raised. */
export type RaiseReason = "takeover" | "restore";

/** A raise to make before the engine starts: in the device record (a takeover) or in the settings (a restore). */
export interface PendingRaise {
  /** Makes the raise happen once: a crash halfway through finds it done or not done, never twice. */
  id: string;
  why: RaiseReason;
  /** The profile's forced takeovers, this one included. */
  takeovers: number;
  /** When the copy started (ms). */
  at: number;
}

/** What the settings hold of the last raise. */
export interface CounterRaise { id: string; floor: number; at: number; why: RaiseReason }

/** The groups whose admin work is off here, and since when. */
export interface GroupAdminOff { at: number; groups: string[] }

/** A raise to make, with a fresh id. */
export function pendingRaise(why: RaiseReason, takeovers: number, at: number = Date.now()): PendingRaise {
  return { id: toBase64Url(randomBytes(12)), why, takeovers, at };
}

export function isPendingRaise(value: unknown): value is PendingRaise {
  const v = value as Partial<PendingRaise> | null;
  return !!v && typeof v === "object" && typeof v.id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v.id) && (v.why === "takeover" || v.why === "restore")
    && Number.isSafeInteger(v.takeovers) && v.takeovers! >= 0 && Number.isSafeInteger(v.at) && v.at! >= 0;
}

export function isCounterRaise(value: unknown): value is CounterRaise {
  const v = value as Partial<CounterRaise> | null;
  return !!v && typeof v === "object" && typeof v.id === "string" && Number.isSafeInteger(v.floor) && v.floor! >= 0 && v.floor! <= MAX_COUNTER_FLOOR;
}

export function isGroupAdminOff(value: unknown): value is GroupAdminOff {
  const v = value as Partial<GroupAdminOff> | null;
  return !!v && typeof v === "object" && Number.isSafeInteger(v.at) && Array.isArray(v.groups) && v.groups.every((g) => typeof g === "string");
}

/** The floor of a copy that starts at `now` (see above). */
export function nextCounterFloor(previous: number, takeovers: number, now: number): number {
  // A clock past 2100 is not believed (it would spend most of the 32 bits at once): the stride alone counts then.
  const clock = now > FLOOR_CLOCK_LIMIT_MS ? 0 : Math.max(0, Math.floor((now - FLOOR_CLOCK_START_MS) / 1000));
  const floor = Math.max(previous + RAISE_STRIDE, takeovers * RAISE_STRIDE, clock);
  return Math.min(MAX_COUNTER_FLOOR, floor);
}

/** One counter, raised: by the stride, and at least to the floor. */
export const raisedCounter = (value: number | undefined, floor: number): number => Math.max((Number.isSafeInteger(value) ? value! : 0) + RAISE_STRIDE, floor);

/**
 * A chat's row with its outgoing counters raised. A paired chat that never published (no mailbox state, no capability
 * state yet) gets them at the floor: the device it replaces may have published since the copy was made.
 */
export function raisedLink(link: StoredLink, floor: number): StoredLink {
  const paired = !!link.profile && !link.group;
  const next: StoredLink = { ...link };
  if (link.dhtDeliveryState) next.dhtDeliveryState = { ...link.dhtDeliveryState, sequence: raisedCounter(link.dhtDeliveryState.sequence, floor) };
  else if (paired) next.dhtDeliveryState = { sequence: floor, peerSequence: 0 };
  if (link.capsState) {
    const { publishedAt: _out, ...caps } = link.capsState;
    next.capsState = { ...caps, rev: raisedCounter(link.capsState.rev, floor) };
  } else if (paired) next.capsState = { rev: floor };
  if (link.hold) next.hold = { ...link.hold, outSeq: raisedCounter(link.hold.outSeq, floor), pointerRev: raisedCounter(link.hold.pointerRev, floor) };
  return next;
}

/**
 * Payment methods whose unfinished attempt may hold signed bytes that a reconcile would broadcast again (USDT, Ark), or
 * that sign the whole transaction when the review is made, before the person approves it (both on-chain sources), or
 * whose outcome a fresh database cannot find (Bark).
 */
export const PARKED_METHODS: ReadonlySet<PaymentReview["method"]> = new Set(["usdt", "bitcoin", "arkade", "bark"]);

/** A saved payment attempt as the copy keeps it: not finished means `unknown`, and signed bytes are parked. */
export function raisedIntent<T extends { review: PaymentReview }>(saved: T): T {
  const { review } = saved;
  if (!["pending", "submitted", "unknown"].includes(review.state)) return saved;
  // A `pending` review is parked too: an on-chain review holds a signed transaction from the moment it is made, and a
  // reconcile of an `unknown` one that finds it missing on chain would broadcast it, approved or not.
  const parked = PARKED_METHODS.has(review.method);
  return { ...saved, review: { ...review, state: "unknown", ...(parked ? { parked: true as const, error: engineText("parkedSigned") } : {}) } };
}

/** The on-chain wallet's stored state (`providers/bdk.ts`): it scans again, and no review holds its coins. */
export const isBdkKey = (key: IDBValidKey): boolean => typeof key === "string" && key.startsWith("bdkWallet-");
export function raisedBdk(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  return { ...(value as Record<string, unknown>), scanned: false, reserved: [] };
}

/** What a raise did. */
export interface RaiseResult { floor: number; links: number; parked: number; groups: number; done: "now" | "before" }

const STORES = { links: "links", settings: "settings", intents: "paymentIntents", groups: "groups" } as const;

/**
 * Makes `pending` in one transaction of the profile's database: every chat, every payment attempt, the on-chain
 * wallets, the groups' admin work, the floor and the raise's id. A raise already made (its id is the stored one)
 * changes nothing. The settings row a restore wrote is taken away in the same transaction.
 */
export function applyCounterRaise(db: IDBDatabase, pending: PendingRaise): Promise<RaiseResult> {
  const names = [STORES.links, STORES.settings, STORES.intents, STORES.groups].filter((name) => db.objectStoreNames.contains(name));
  const tx = db.transaction(names, "readwrite");
  const result: RaiseResult = { floor: 0, links: 0, parked: 0, groups: 0, done: "now" };
  const done = new Promise<RaiseResult>((resolve, reject) => {
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("The counters could not be raised"));
  });
  const settings = tx.objectStore(STORES.settings);
  const fail = (error: unknown) => { try { tx.abort(); } catch { /* already over */ } void error; };
  const read = settings.get(COUNTER_RAISE_KEY);
  read.onsuccess = () => {
    try {
      const was = isCounterRaise(read.result) ? read.result : null;
      if (was?.id === pending.id) {
        result.floor = was.floor; result.done = "before";
        settings.delete(PENDING_RAISE_KEY);
        return;
      }
      const floor = nextCounterFloor(was?.floor ?? 0, pending.takeovers, pending.at);
      result.floor = floor;
      settings.put({ id: pending.id, floor, at: pending.at, why: pending.why } satisfies CounterRaise, COUNTER_RAISE_KEY);
      settings.delete(PENDING_RAISE_KEY);
      if (names.includes(STORES.links)) {
        const cursor = tx.objectStore(STORES.links).openCursor();
        cursor.onsuccess = () => {
          const at = cursor.result;
          if (!at) return;
          at.update(raisedLink(at.value as StoredLink, floor));
          result.links += 1;
          at.continue();
        };
      }
      if (names.includes(STORES.intents)) {
        const cursor = tx.objectStore(STORES.intents).openCursor();
        cursor.onsuccess = () => {
          const at = cursor.result;
          if (!at) return;
          const next = raisedIntent(at.value as { review: PaymentReview });
          if (next !== at.value) { at.update(next); if (next.review.parked) result.parked += 1; }
          at.continue();
        };
      }
      const keys = settings.openCursor();
      keys.onsuccess = () => {
        const at = keys.result;
        if (!at) return;
        if (isBdkKey(at.key)) at.update(raisedBdk(at.value));
        at.continue();
      };
      if (names.includes(STORES.groups)) {
        const groups = tx.objectStore(STORES.groups).getAllKeys();
        groups.onsuccess = () => {
          const ids = (groups.result as IDBValidKey[]).filter((key): key is string => typeof key === "string");
          result.groups = ids.length;
          const off = settings.get(GROUP_ADMIN_OFF_KEY);
          off.onsuccess = () => {
            const before = isGroupAdminOff(off.result) ? off.result.groups : [];
            settings.put({ at: pending.at, groups: [...new Set([...before, ...ids])].sort() } satisfies GroupAdminOff, GROUP_ADMIN_OFF_KEY);
          };
        };
      }
    } catch (error) { fail(error); }
  };
  return done;
}
