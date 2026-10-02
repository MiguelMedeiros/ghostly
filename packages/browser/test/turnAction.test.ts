import { describe, expect, it } from "vitest";
import { BEHIND_ROUNDS, TURN_COLUMNS, TURN_ROWS, turnAction, turnRow, type TurnAction, type TurnColumn, type TurnFacts, type TurnRow } from "../src/devices/turnAction";
import { DEVICE_STATES, canTransition, type DeviceState } from "../src/devices/state";
// covers: devices.turn.action

/*
 * WISP 06 § Device state by turn read, cell for cell. Each line below is one cell of the table as the WISP words it,
 * and the action the engine takes for it. "No cell is empty, and every state has a way out."
 */

const superseded = (reload: boolean): TurnAction => ({ do: "become", state: "superseded", reload });
const asActiveAtStart = (then: TurnAction): TurnAction => ({ do: "become", state: "active", reload: false, then });
const yields: TurnAction = { do: "become", state: "standby", reload: false, undo: "staging" };
const impossible: TurnAction = { do: "impossible" };
const stay: TurnAction = { do: "stay", offers: [] };
const waitsForSetUpdate: TurnAction = { do: "stay", offers: [], awaits: "set-update" };

type Cell = [row: TurnRow, facts: TurnFacts, wisp: string, action: TurnAction];
const TABLE: Cell[] = [
  // `active`, at start
  ["active-start", { result: "mine" }, "Write the next record, store, put, start", { do: "write", condition: "seen", then: "start" }],
  ["active-start", { result: "other" }, "superseded", superseded(false)],
  ["active-start", { result: "clone", clone: "above" }, "Above its stored sequence: superseded, shown as 'Another copy of this device is running'", { do: "become", state: "superseded", reload: false, notice: "another-copy" }],
  ["active-start", { result: "clone", clone: "equal", lower: true }, "At an equal sequence: the lower instance writes rev plus one and starts", { do: "write", condition: "seen", then: "start" }],
  ["active-start", { result: "clone", clone: "equal", lower: false }, "At an equal sequence: the other is superseded", { do: "become", state: "superseded", reload: false, notice: "another-copy" }],
  ["active-start", { result: "tombstone", listed: true }, "moving if listed", { do: "become", state: "moving", reload: false }],
  ["active-start", { result: "tombstone", listed: false }, "else removed", { do: "become", state: "removed", reload: false }],
  ["active-start", { result: "none" }, "Write the next record, store, put with no condition, start", { do: "write", condition: "none", then: "start" }],
  ["active-start", { result: "unreachable" }, "Do not start; 'Try again' or 'Start anyway' (offline only)", { do: "ask" }],
  // `active`, running
  ["active-running", { result: "mine" }, "Go on", { do: "go-on", restricted: false }],
  ["active-running", { result: "other" }, "superseded, reload", superseded(true)],
  ["active-running", { result: "clone", clone: "above" }, "As at start (and reload: the engine runs)", { do: "become", state: "superseded", reload: true, notice: "another-copy" }],
  ["active-running", { result: "clone", clone: "equal", lower: true }, "As at start: the lower instance writes rev plus one at once, and goes on", { do: "write", condition: "seen", then: "go-on" }],
  ["active-running", { result: "clone", clone: "equal", lower: false }, "As at start: the other stops", { do: "become", state: "superseded", reload: true, notice: "another-copy" }],
  ["active-running", { result: "tombstone", listed: true }, "moving, reload", { do: "become", state: "moving", reload: true }],
  ["active-running", { result: "tombstone", listed: false }, "removed, reload", { do: "become", state: "removed", reload: true }],
  ["active-running", { result: "none" }, "Put the stored packet again, go on", { do: "put", condition: "none", then: "go-on" }],
  ["active-running", { result: "unreachable" }, "Go on; no wallet opened, no spend, no admin work until a good read", { do: "go-on", restricted: true }],
  // `standby`
  ["standby", { result: "mine" }, "Show 'Moving to <device>. Waiting for it to finish.'", { do: "show", screen: "moving-to" }],
  ["standby", { result: "other" }, "Show 'Active on <device>'", { do: "show", screen: "active-on" }],
  ["standby", { result: "clone", clone: "above" }, "Treated as other", { do: "show", screen: "active-on" }],
  ["standby", { result: "clone", clone: "equal", lower: true }, "Treated as other", { do: "show", screen: "active-on" }],
  ["standby", { result: "tombstone", listed: true }, "moving", { do: "become", state: "moving", reload: false }],
  ["standby", { result: "tombstone", listed: false }, "removed", { do: "become", state: "removed", reload: false }],
  ["standby", { result: "none" }, "Show the device it last knew as active", { do: "show", screen: "last-known" }],
  ["standby", { result: "unreachable" }, "Show 'Can't check which device is active'", { do: "show", screen: "cannot-check" }],
  // `releasing`, at start
  ["releasing", { result: "mine" }, "Write active, then as active", asActiveAtStart({ do: "write", condition: "seen", then: "start" })],
  ["releasing", { result: "other" }, "superseded", superseded(false)],
  ["releasing", { result: "clone", clone: "above" }, "superseded", superseded(false)],
  ["releasing", { result: "clone", clone: "equal", lower: true }, "superseded", superseded(false)],
  ["releasing", { result: "tombstone", listed: true }, "moving", { do: "become", state: "moving", reload: false }],
  ["releasing", { result: "tombstone", listed: false }, "removed", { do: "become", state: "removed", reload: false }],
  ["releasing", { result: "none" }, "Write active, then as active", asActiveAtStart({ do: "write", condition: "none", then: "start" })],
  ["releasing", { result: "unreachable" }, "Write active, then as active at start", asActiveAtStart({ do: "ask" })],
  // `taking`
  ["taking", { result: "mine" }, "Write active, start", { do: "become", state: "active", reload: false, then: { do: "start" } }],
  ["taking", { result: "other" }, "Pointer back, drop staging, standby", yields],
  ["taking", { result: "clone", clone: "above" }, "The same", yields],
  ["taking", { result: "clone", clone: "equal", lower: true }, "The same", yields],
  ["taking", { result: "tombstone", listed: true }, "The same, then moving", { ...yields, then: { do: "become", state: "moving", reload: false } }],
  ["taking", { result: "tombstone", listed: false }, "The same, then removed", { ...yields, then: { do: "become", state: "removed", reload: false } }],
  ["taking", { result: "none" }, "Put with no condition, read back", { do: "put", condition: "none", then: "read" }],
  ["taking", { result: "unreachable" }, "Wait, try again", { do: "wait" }],
  // `superseded`
  ["superseded", { result: "mine" }, "Cannot happen (it can, once the newer record expired: stay, the same two buttons)", { do: "stay", offers: ["use-here", "it-wasnt-me"] }],
  ["superseded", { result: "other" }, "Stay; Use here (a handoff) or It wasn't me (a takeover)", { do: "stay", offers: ["use-here", "it-wasnt-me"] }],
  ["superseded", { result: "clone", clone: "above" }, "Stay", stay],
  ["superseded", { result: "tombstone", listed: true }, "moving", { do: "become", state: "moving", reload: false }],
  ["superseded", { result: "tombstone", listed: false }, "removed", { do: "become", state: "removed", reload: false }],
  ["superseded", { result: "none" }, "Stay; the same two buttons", { do: "stay", offers: ["use-here", "it-wasnt-me"] }],
  ["superseded", { result: "unreachable" }, "Stay", stay],
  // `moving`
  ["moving", { result: "mine" }, "Cannot happen", impossible],
  ["moving", { result: "other" }, "Cannot happen at the old address", impossible],
  ["moving", { result: "clone", clone: "above" }, "Cannot happen", impossible],
  ["moving", { result: "tombstone", listed: true }, "Stay until a set-update signed by the device its stored record names active arrives", waitsForSetUpdate],
  ["moving", { result: "none" }, "Stay (the tombstone expired; the active device puts it again)", waitsForSetUpdate],
  ["moving", { result: "unreachable" }, "Stay", waitsForSetUpdate],
  // `removed`
  ["removed", { result: "mine" }, "n/a", impossible],
  ["removed", { result: "other" }, "n/a", impossible],
  ["removed", { result: "clone", clone: "above" }, "n/a", impossible],
  ["removed", { result: "tombstone", listed: false }, "Stay; Add it again is a new enrollment", { do: "stay", offers: ["add-again"] }],
  ["removed", { result: "none" }, "Stay", stay],
  ["removed", { result: "unreachable" }, "Stay", stay],
];

describe("device state by turn read", () => {
  it.each(TABLE)("%s on %j: %s", (row, facts, _wisp, action) => {
    expect(turnAction(row, facts)).toEqual(action);
  });

  it("no cell is empty: every state against every result of a read is in the table above", () => {
    const covered = new Set(TABLE.map(([row, facts]) => `${row} ${facts.result}`));
    for (const row of TURN_ROWS) for (const column of TURN_COLUMNS) expect(covered.has(`${row} ${column}`), `${row} on ${column}`).toBe(true);
    expect(TURN_ROWS.length * TURN_COLUMNS.length).toBe(48);
    // And the function answers for every one of them, with every variant of a clone and a tombstone.
    for (const row of TURN_ROWS) for (const column of TURN_COLUMNS) for (const clone of ["above", "equal"] as const) for (const flag of [true, false]) {
      expect(turnAction(row, { result: column, clone, lower: flag, listed: flag }).do).toBeTruthy();
    }
  });

  it("the one case the table's words leave out: a moving device that reads a tombstone which no longer lists it is removed", () => {
    expect(turnAction("moving", { result: "tombstone", listed: false })).toEqual({ do: "become", state: "removed", reload: false });
  });

  it("every state a cell leads to is a legal change of the device state", () => {
    const stateOf: Record<TurnRow, DeviceState> = { "active-start": "active", "active-running": "active", standby: "standby", releasing: "releasing", taking: "taking", superseded: "superseded", moving: "moving", removed: "removed" };
    const check = (from: DeviceState, action: TurnAction) => {
      if (action.do !== "become") return;
      expect(canTransition(from, action.state), `${from} to ${action.state}`).toBe(true);
      if (action.then) check(action.state, action.then);
    };
    for (const [row, facts] of TABLE) check(stateOf[row], turnAction(row, facts));
  });

  it("behind has no column: a writer puts its stored packet again and reads again, three rounds at most", () => {
    const again: TurnAction = { do: "put", condition: "seen", then: "read" };
    for (const row of ["active-start", "active-running", "taking"] as const) {
      for (let round = 1; round <= BEHIND_ROUNDS; round++) expect(turnAction(row, { result: "behind" }, round)).toEqual(again);
    }
    expect(BEHIND_ROUNDS).toBe(3);
    // Then a taking device treats it as unreachable (it waits and tries later), and an active one as none (it puts with no condition).
    expect(turnAction("taking", { result: "behind" }, 4)).toEqual({ do: "wait" });
    expect(turnAction("active-start", { result: "behind" }, 4)).toEqual({ do: "write", condition: "none", then: "start" });
    expect(turnAction("active-running", { result: "behind" }, 4)).toEqual({ do: "put", condition: "none", then: "go-on" });
  });

  it("behind in any state that does not write is none, at once", () => {
    for (const row of ["standby", "releasing", "superseded", "moving", "removed"] as const) {
      expect(turnAction(row, { result: "behind" }, 1)).toEqual(turnAction(row, { result: "none" }));
    }
  });

  it("every state has a row, an active device two, and a single profile none", () => {
    expect(DEVICE_STATES.filter((s) => s !== "single").map((s) => turnRow(s, true))).toEqual(["active-start", "standby", "releasing", "taking", "superseded", "moving", "removed"]);
    expect(turnRow("active", false)).toBe("active-running");
    expect(() => turnRow("single", true)).toThrow("no turn");
  });

  it("every state has a way out", () => {
    // superseded leaves by a handoff or a takeover; moving by a set-update; removed by enrollment; a taker by its own read.
    const out = (row: TurnRow, column: TurnColumn) => turnAction(row, { result: column, listed: true });
    expect(out("superseded", "other")).toMatchObject({ offers: ["use-here", "it-wasnt-me"] });
    expect(out("moving", "tombstone")).toMatchObject({ awaits: "set-update" });
    expect(turnAction("removed", { result: "tombstone", listed: false })).toMatchObject({ offers: ["add-again"] });
    expect(out("taking", "mine")).toMatchObject({ state: "active" });
    expect(out("taking", "other")).toMatchObject({ state: "standby" });
  });
});
