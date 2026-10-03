import type { TurnResult } from "@ghostly/core";
import type { DeviceState, StoredDeviceState } from "./state";

/*
 * What a device does on a turn read (WISP 06 § Device state by turn read): a pure function from the device's state
 * and the read's result to an action, the WISP's table cell for cell. Nothing here reads, writes or publishes; the
 * turn keeper (`turn.ts`) and the hosts carry the actions out.
 *
 * A `single` profile has no row: it has no turn, and nothing may ask.
 */

/** The table's rows. An `active` device has two: the read that lets it start, and every read while it runs. */
export type TurnRow = "active-start" | "active-running" | "standby" | "releasing" | "taking" | "superseded" | "moving" | "removed";
export const TURN_ROWS: readonly TurnRow[] = ["active-start", "active-running", "standby", "releasing", "taking", "superseded", "moving", "removed"];
/** The table's columns. `behind` and `closed` have none: each becomes one of these (see `turnAction`). */
export type TurnColumn = Exclude<TurnResult, "behind" | "closed">;
export const TURN_COLUMNS: readonly TurnColumn[] = ["mine", "other", "clone", "tombstone", "none", "unreachable"];

/** How many rounds (put the stored packet again, read again) a writer makes on `behind` before it stops asking. */
export const BEHIND_ROUNDS = 3;

/** What of a read the table needs beyond its result. */
export interface TurnFacts {
  result: TurnResult;
  /** `clone`: above the stored sequence, or at an equal one. */
  clone?: "above" | "equal";
  /** `clone` at an equal sequence: this device's `instance` is the lower one. */
  lower?: boolean;
  /** `tombstone`: this device is still listed. */
  listed?: boolean;
}

export type TurnAction =
  /** Write the next record (`rev` plus one, a new `instance`), store it, put it, then start or go on. */
  | { do: "write"; condition: "seen" | "none"; then: "start" | "go-on" }
  /**
   * Write this state durably. `reload`: into the gate, at once (the engine runs). `undo`: first move the registry
   * pointer back and drop the staged state (a taker that lost). `then`: go on as that state, with this action.
   */
  | { do: "become"; state: StoredDeviceState; reload: boolean; notice?: "another-copy"; undo?: "staging"; then?: TurnAction }
  /** Do not start. "Can't check which device is active", with Try again and Start anyway (limited mode). */
  | { do: "ask" }
  /** Nothing changes. `restricted`: no wallet opened, no spend, no admin work until a good read. */
  | { do: "go-on"; restricted: boolean }
  /** Put the stored packet again. `then: "read"`: and read back, the read decides. */
  | { do: "put"; condition: "seen" | "none"; then: "go-on" | "read" }
  /** A standby's screen. */
  | { do: "show"; screen: "moving-to" | "active-on" | "last-known" | "cannot-check" }
  /** Start the engine: the device is the active one, and a source said so. */
  | { do: "start" }
  /** Try the read again later; nothing else happens. */
  | { do: "wait" }
  /** Stay as it is. `offers`: what the person may press. `awaits`: what ends it without them. */
  | { do: "stay"; offers: ("use-here" | "it-wasnt-me" | "add-again")[]; awaits?: "set-update" }
  /** The table says this cannot happen. Nothing is done, and it is worth a log line. */
  | { do: "impossible" };

/** The row of a device state. `atStart`: the read that an `active` device makes as a condition of starting. */
export function turnRow(state: DeviceState, atStart: boolean): TurnRow {
  if (state === "single") throw new Error("A profile on one device has no turn");
  if (state === "active") return atStart ? "active-start" : "active-running";
  return state;
}

const tombstone = (facts: TurnFacts): StoredDeviceState => (facts.listed ? "moving" : "removed");
const STAY: TurnAction = { do: "stay", offers: [] };
const IMPOSSIBLE: TurnAction = { do: "impossible" };

/** One cell of the table. */
function cell(row: TurnRow, column: TurnColumn, facts: TurnFacts): TurnAction {
  switch (row) {
    case "active-start":
    case "active-running": {
      const running = row === "active-running";
      switch (column) {
        case "mine": return running ? { do: "go-on", restricted: false } : { do: "write", condition: "seen", then: "start" };
        case "other": return { do: "become", state: "superseded", reload: running };
        case "clone":
          // At an equal sequence both copies started in the same moment: the lower instance writes rev plus one at once.
          if (facts.clone === "equal" && facts.lower) return { do: "write", condition: "seen", then: running ? "go-on" : "start" };
          return { do: "become", state: "superseded", reload: running, notice: "another-copy" };
        case "tombstone": return { do: "become", state: tombstone(facts), reload: running };
        case "none": return running ? { do: "put", condition: "none", then: "go-on" } : { do: "write", condition: "none", then: "start" };
        case "unreachable": return running ? { do: "go-on", restricted: true } : { do: "ask" };
      }
      break;
    }
    case "standby":
      switch (column) {
        // Its own last record is still the highest: it released, and the taker has not put its turn yet.
        case "mine": return { do: "show", screen: "moving-to" };
        case "other": case "clone": return { do: "show", screen: "active-on" };
        case "tombstone": return { do: "become", state: tombstone(facts), reload: false };
        case "none": return { do: "show", screen: "last-known" };
        case "unreachable": return { do: "show", screen: "cannot-check" };
      }
      break;
    case "releasing":
      switch (column) {
        // It never signed the release: it is the active device again, and reads as one that starts.
        case "mine": case "none": case "unreachable":
          return { do: "become", state: "active", reload: false, then: cell("active-start", column, facts) };
        case "other": case "clone": return { do: "become", state: "superseded", reload: false };
        case "tombstone": return { do: "become", state: tombstone(facts), reload: false };
      }
      break;
    case "taking":
      switch (column) {
        case "mine": return { do: "become", state: "active", reload: false, then: { do: "start" } };
        // Any other device's valid record at its turn included: the taker yields.
        case "other": case "clone": return { do: "become", state: "standby", reload: false, undo: "staging" };
        case "tombstone": return { do: "become", state: "standby", reload: false, undo: "staging", then: { do: "become", state: tombstone(facts), reload: false } };
        case "none": return { do: "put", condition: "none", then: "read" };
        case "unreachable": return { do: "wait" };
      }
      break;
    case "superseded":
      switch (column) {
        // `mine` is never read: its stored packet is below the turn that superseded it, which it keeps as the highest it
        // saw, so its own packet coming back (the newer record expired, a relay lags) is `behind`, treated as `none`.
        // Were it read all the same, nothing changes: the device was replaced, stays so, and never puts its packet again.
        case "mine": case "other": case "none": return { do: "stay", offers: ["use-here", "it-wasnt-me"] };
        case "clone": case "unreachable": return STAY;
        case "tombstone": return { do: "become", state: tombstone(facts), reload: false };
      }
      break;
    case "moving":
      switch (column) {
        // Until a `set-update` signed by the device its stored record names active arrives; a tombstone that no longer lists it ends the wait.
        case "tombstone": return facts.listed ? { do: "stay", offers: [], awaits: "set-update" } : { do: "become", state: "removed", reload: false };
        // The tombstone expired at that source, or the source lags; the active device puts it again.
        case "mine": case "other": case "clone": case "none": case "unreachable": return { do: "stay", offers: [], awaits: "set-update" };
      }
      break;
    case "removed":
      switch (column) {
        case "mine": case "other": case "clone": return IMPOSSIBLE;
        case "tombstone": return { do: "stay", offers: ["add-again"] };
        case "none": case "unreachable": return STAY;
      }
      break;
  }
  throw new Error(`No action for ${row} on ${column}`);
}

/**
 * What a device in `row` does on a read. `round` counts the reads that said `behind` in a row, this one included (1 for the first):
 * a device that writes (`active`, `taking`) puts its stored packet again, conditionally on what it read, and reads
 * again, three rounds at most; then `taking` treats it as `unreachable` and `active` as `none`. Any other state
 * treats `behind` as `none` at once, and puts nothing. `closed` (a packet under the turn key at or above the tombstone's
 * sequence that is no tombstone) is never a good read: every state does what its `unreachable` cell says.
 */
export function turnAction(row: TurnRow, facts: TurnFacts, round = 1): TurnAction {
  if (facts.result === "closed") return cell(row, "unreachable", facts);
  if (facts.result !== "behind") return cell(row, facts.result, facts);
  const writer = row === "active-start" || row === "active-running" || row === "taking";
  if (!writer) return cell(row, "none", facts);
  if (round <= BEHIND_ROUNDS) return { do: "put", condition: "seen", then: "read" };
  return cell(row, row === "taking" ? "unreachable" : "none", facts);
}
