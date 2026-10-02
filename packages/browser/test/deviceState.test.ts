import { describe, expect, it } from "vitest";
import { DEVICE_STATES, DeviceRecordError, DeviceTransitionError, amend, canTransition, firstRecord, parseDeviceRecord, runsEngine, stricter, transition,
  type DeviceRecord, type DeviceState, type StoredDeviceState } from "../src/devices/state";
// covers: devices.gate

/*
 * The device states of WISP 06 (§ States of a device) and the changes between them. One table says which are legal;
 * this spells the same table out again from the WISP's text, so a change to either has to be meant.
 */

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const record = (state: StoredDeviceState, patch: Partial<DeviceRecord> = {}): DeviceRecord =>
  ({ v: 1, profile: "ghostly", state, saved: 3, turn: 7, rev: 2, deviceSet: [{ key: KEY, name: "MacBook" }, { key: KEY, name: "Phone" }], takeovers: 0, earlierSets: [], ...patch });

/** WISP 06, state by state: where each may go. */
const LEGAL: Record<DeviceState, DeviceState[]> = {
  // A first device enrolled (this one stays active), or this device was enrolled, or a restored copy takes over.
  single: ["active", "standby"],
  // Quiesce for a handoff; a higher turn it did not release; a tombstone.
  active: ["releasing", "superseded", "moving", "removed"],
  // Cancel or a failure; the release; a higher turn; a tombstone.
  releasing: ["active", "standby", "superseded", "moving", "removed"],
  // A release it holds; a forced takeover; a tombstone.
  standby: ["taking", "active", "moving", "removed"],
  // Its own turn read back; another record at its turn; a tombstone.
  taking: ["active", "standby", "moving", "removed"],
  // Use here; It wasn't me; a tombstone.
  superseded: ["taking", "active", "moving", "removed"],
  // An accepted set-update or a new enrollment; a device set of its own; no longer listed.
  moving: ["standby", "active", "removed"],
  // A new enrollment.
  removed: ["standby"],
};

describe("the device states", () => {
  it("only `single` and `active` run the engine", () => {
    expect(DEVICE_STATES.filter(runsEngine)).toEqual(["single", "active"]);
  });

  it("allows exactly the changes WISP 06 names, for every pair of states", () => {
    for (const from of DEVICE_STATES) for (const to of DEVICE_STATES) {
      expect(canTransition(from, to), `${from} to ${to}`).toBe(LEGAL[from].includes(to));
    }
  });

  it("never leads back to `single`, and never changes a state into itself", () => {
    for (const from of DEVICE_STATES) {
      expect(canTransition(from, "single")).toBe(false);
      expect(canTransition(from, from)).toBe(false);
    }
  });

  it("every state has a way out", () => {
    for (const from of DEVICE_STATES) expect(LEGAL[from].length, from).toBeGreaterThan(0);
  });
});

describe("a change of state", () => {
  it("makes the first record of a `single` profile, `active` or `standby`", () => {
    const made = transition(null, "ghostly_work", "standby", { deviceSet: [{ key: KEY, name: "MacBook" }], turn: 41 });
    expect(made).toEqual({ v: 1, profile: "ghostly_work", state: "standby", saved: 0, turn: 41, rev: 0, deviceSet: [{ key: KEY, name: "MacBook" }], takeovers: 0, earlierSets: [] });
    expect(transition(null, "ghostly", "active").state).toBe("active");
    expect(firstRecord("ghostly", "active").state).toBe("active");
  });

  it("refuses a first record in any other state", () => {
    for (const to of ["releasing", "taking", "superseded", "moving", "removed"] as const) {
      expect(() => transition(null, "ghostly", to)).toThrow(DeviceTransitionError);
    }
  });

  it("keeps the record and sets what the change brings", () => {
    const released = transition(record("releasing"), "ghostly", "standby", { releasedTurn: 8, handoff: undefined });
    expect(released).toMatchObject({ state: "standby", turn: 7, rev: 2, releasedTurn: 8, saved: 3 });
  });

  it("refuses an illegal change and says which", () => {
    const refused = (() => { try { transition(record("standby"), "ghostly", "releasing"); } catch (error) { return error; } })();
    expect(refused).toBeInstanceOf(DeviceTransitionError);
    expect(refused).toMatchObject({ from: "standby", to: "releasing", message: "A device cannot go from standby to releasing" });
    // The one a bug would most want: a standby that makes itself active needs a release (`taking`) or a takeover, and
    // a removed device is never active again without a new enrollment.
    expect(() => transition(record("removed"), "ghostly", "active")).toThrow(DeviceTransitionError);
    expect(() => transition(record("active"), "ghostly", "standby")).toThrow(DeviceTransitionError);
  });

  it("a patch cannot smuggle in a state, a profile or the write counter", () => {
    const patch = { state: "active", profile: "ghostly_other", saved: 99, v: 2 } as never;
    expect(transition(record("standby"), "ghostly", "taking", patch)).toMatchObject({ state: "taking", profile: "ghostly", saved: 3, v: 1 });
    expect(amend(record("standby"), patch)).toMatchObject({ state: "standby", profile: "ghostly", saved: 3, v: 1 });
  });

  it("the highest-ever fields and the takeover count only rise", () => {
    const from = record("active", { releasedTurn: 8, seenSequence: 900, takeovers: 2 });
    expect(amend(from, { releasedTurn: 9, seenSequence: 900, takeovers: 3 })).toMatchObject({ releasedTurn: 9, seenSequence: 900, takeovers: 3 });
    expect(() => amend(from, { releasedTurn: 7 })).toThrow("releasedTurn may only rise");
    expect(() => amend(from, { seenSequence: 899 })).toThrow("seenSequence may only rise");
    expect(() => amend(from, { seenSequence: undefined })).toThrow("seenSequence may only rise");
    expect(() => transition(from, "ghostly", "releasing", { takeovers: 1 })).toThrow("takeovers may only rise");
  });

  it("refuses to make a record that would not be valid", () => {
    expect(() => amend(record("active"), { rev: 2 ** 18 })).toThrow(DeviceRecordError);
    expect(() => amend(record("active"), { deviceSet: Array.from({ length: 5 }, () => ({ key: KEY, name: "x" })) })).toThrow(DeviceRecordError);
  });
});

describe("a stored record", () => {
  it("reads back when it is whole", () => {
    const full = record("taking", {
      turnPacket: "cGFja2V0", d: KEY, lineage: "bGluZWFnZQ", activeSlot: 0, ownSlot: 1, releasedTurn: 6, seenSequence: 2 ** 40,
      handoff: { role: "taking", step: "verified", staging: "stage1", release: { turn: 8, to: KEY, h: KEY, s: KEY } },
      leftFiles: [{ sha256: KEY, size: 20_000_000, where: "native" }], breezDatabase: "breez-abc",
      earlierSets: [{ d: KEY, tombstone: "dG9tYg", setUpdate: "{\"t\":\"set-update\"}", pending: [KEY] }],
    });
    expect(parseDeviceRecord(structuredClone(full))).toEqual(full);
  });

  it.each([
    ["nothing", null],
    ["an array", []],
    ["another version", { ...record("standby"), v: 2 }],
    ["no state", { ...record("standby"), state: undefined }],
    ["`single` stored as a state", { ...record("standby"), state: "single" }],
    ["a state this build does not know", { ...record("standby"), state: "frozen" }],
    ["no profile", { ...record("standby"), profile: "" }],
    ["a turn above 2^32 - 1", { ...record("standby"), turn: 2 ** 32 }],
    ["a negative write counter", { ...record("standby"), saved: -1 }],
    ["five devices", { ...record("standby"), deviceSet: Array.from({ length: 5 }, () => ({ key: KEY, name: "x" })) }],
    ["a key that is not base64url", { ...record("standby"), deviceSet: [{ key: "not/base64url", name: "x" }] }],
    ["a slot index past the set", { ...record("standby"), activeSlot: 4 }],
    ["a handoff with no role", { ...record("standby"), handoff: { step: "x" } }],
    ["nine earlier sets", { ...record("standby"), earlierSets: Array.from({ length: 9 }, () => ({ d: KEY, tombstone: KEY, setUpdate: "", pending: [] })) }],
  ])("is refused when it holds %s", (_what, value) => {
    expect(() => parseDeviceRecord(value)).toThrow(DeviceRecordError);
  });
});

describe("Desktop's two copies", () => {
  it("a record wins over none", () => {
    const one = record("active");
    expect(stricter(one, null)).toBe(one);
    expect(stricter(null, one)).toBe(one);
    expect(stricter(null, null)).toBeNull();
  });

  it("a state other than `active` wins, whichever was written last", () => {
    const active = record("active", { saved: 9 }), standby = record("standby", { saved: 4 });
    expect(stricter(active, standby)).toBe(standby);
    expect(stricter(standby, active)).toBe(standby);
  });

  it("between two that both stop the engine, or both run it, the one written last wins", () => {
    const older = record("standby", { saved: 4 }), newer = record("taking", { saved: 5 });
    expect(stricter(older, newer)).toBe(newer);
    expect(stricter(newer, older)).toBe(newer);
    const a = record("active", { saved: 2, rev: 1 }), b = record("active", { saved: 3, rev: 2 });
    expect(stricter(a, b)).toBe(b);
  });
});
