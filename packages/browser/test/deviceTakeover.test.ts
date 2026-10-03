import { beforeEach, describe, expect, it } from "vitest";
import { identityFromSeed, readTurnPacket, sign, signTurnPacket, signTurnRelease, toBase64Url, turnKeys, TURN_SETTLE_MS, type Identity, type TurnRecord } from "@ghostly/core";
import { amend, firstRecord, transition, type DevicePatch, type DeviceRecord, type StoredDeviceState } from "../src/devices/state";
import { TurnKeeper, takeoverTurn, type TurnStore } from "../src/devices/turn";
import { TakeoverRefusal, canTakeOver, forceTakeover, takeoverTarget } from "../src/devices/takeover";
import { FakeTurnNetwork } from "./helpers/turnNetwork";
// covers: devices.takeover, devices.turn.keeper

/*
 * A forced takeover (WISP 06 § Forced takeover): the lock password and the lost device's name, the turn above every turn
 * the device knows (a releaser above its own release), the settle wait, the counters raised with `active`. Two devices
 * forcing at once end with one active; the old active device coming back mid-take stops; a wrong password, a device
 * with no copy, a locked-out device: nothing is written to the turn, and the active device goes on.
 */

const D = new Uint8Array(32).fill(0xd6);
const keys = turnKeys(D);
const devices: Identity[] = [1, 2, 3].map((n) => identityFromSeed(new Uint8Array(32).fill(n + 40)));
const NAMES = ["Desktop", "Phone", "Laptop"];
const deviceSet = () => devices.map((device, i) => ({ key: toBase64Url(device.publicKey), name: NAMES[i] }));
const slots = () => [...devices.map((device, i) => ({ key: device.publicKey, name: NAMES[i] })), null];
const N = 900;
const PASSWORD = "correct horse battery";
const VERIFIER = { v: 1 as const, setup: "c2V0dXA", record: "cmVjb3Jk" };

function memoryStore(initial: DeviceRecord): TurnStore & { record: DeviceRecord; writes: number } {
  const store = {
    record: initial, writes: 0,
    read: async () => store.record,
    amend: async (_profile: string, patch: DevicePatch) => { store.writes++; return (store.record = { ...amend(store.record, patch), saved: store.record.saved + 1 }); },
    move: async (profile: string, to: StoredDeviceState, patch: DevicePatch = {}) => { store.writes++; return (store.record = { ...transition(store.record, profile, to, patch), saved: store.record.saved + 1 }); },
  };
  return store;
}

const clock = { t: 9_000_000, onSleep: undefined as (() => Promise<void>) | undefined };
beforeEach(() => { clock.t = 9_000_000; clock.onSleep = undefined; });

async function packet(turn: number, rev: number, author: number): Promise<Uint8Array> {
  return signTurnPacket(keys, { turn, rev, author, active: author, slots: slots(), instance: new Uint8Array(8).fill(author + 1) }, (bytes) => sign(bytes, devices[author].seed));
}
const opened = (payload: Uint8Array | null): TurnRecord => {
  const read = readTurnPacket(keys, payload!);
  if (read.kind !== "valid") throw new Error(read.kind);
  return read.record;
};

/** A device in `slot` with the record of turn `N` (the desktop's), in `state`. */
async function device(network: FakeTurnNetwork, slot: number, state: StoredDeviceState, patch: DevicePatch = {}) {
  const stored = await packet(N, 0, 0);
  const base = firstRecord("ghostly", "standby", { turn: N, d: toBase64Url(D), deviceSet: deviceSet(), ownSlot: slot, activeSlot: 0, turnPacket: toBase64Url(stored), copy: "frozen", verifier: VERIFIER, ...patch });
  const record = state === "standby" ? base : state === "active" ? { ...base, state: "active" as const, activeSlot: slot } : { ...base, state };
  const store = memoryStore({ ...record, saved: 1 });
  const keeper = new TurnKeeper({
    profile: "ghostly", network, store, signer: (bytes) => sign(bytes, devices[slot].seed), now: () => clock.t,
    sleep: async (ms) => { await clock.onSleep?.(); clock.t += ms; },
  });
  return { keeper, store, stored };
}

const ports = (store: ReturnType<typeof memoryStore>, keeper: TurnKeeper | null, proves = async (_v: unknown, p: string) => p === PASSWORD) => ({
  read: () => store.read(), amend: (patch: DevicePatch) => store.amend("ghostly", patch), proves, keeper: async () => keeper, now: () => clock.t,
});

describe("the turn of a forced takeover", () => {
  it("is one above the highest the device knows: read, stored, or released", () => {
    expect(takeoverTurn({ turn: N, releasedTurn: undefined }, { record: null })).toBe(N + 1);
    expect(takeoverTurn({ turn: N, releasedTurn: undefined }, { record: { turn: N + 4 } as TurnRecord })).toBe(N + 5);
    // A releaser that released N + 1 and takes the profile back: N + 2, above its taker's release.
    expect(takeoverTurn({ turn: N, releasedTurn: N + 1 }, { record: { turn: N } as TurnRecord })).toBe(N + 2);
  });
});

describe("a forced takeover through the turn keeper", () => {
  let network: FakeTurnNetwork;
  beforeEach(() => { network = new FakeTurnNetwork(); });

  it("takes the turn above the active device's, waits T, starts, and writes active with the raise and one more takeover", async () => {
    const phone = await device(network, 1, "standby");
    network.seed(phone.stored);
    const slept: number[] = [];
    clock.onSleep = async () => { slept.push(clock.t); };
    const outcome = await forceTakeover(ports(phone.store, phone.keeper), { password: PASSWORD, name: "desktop" });
    expect(outcome.kind).toBe("start");
    expect(slept).toHaveLength(1);
    const record = opened(network.source("dht").held);
    expect({ turn: record.turn, author: record.author, active: record.active, release: record.release }).toEqual({ turn: N + 1, author: 1, active: 1, release: undefined });
    expect(phone.store.record).toMatchObject({ state: "active", takeovers: 1, raise: { why: "takeover", takeovers: 1 } });
    expect(phone.store.record.copy).toBeUndefined();
    expect(phone.store.record.handoff).toBeUndefined();
  });

  it("a releaser whose taker never finished takes the profile back at N + 2", async () => {
    const desktop = await device(network, 0, "standby", { releasedTurn: N + 1, activeSlot: 0 });
    network.seed(desktop.stored);
    // The taker's release of N + 1 is valid, but its record never went out.
    await signTurnRelease(keys.address, N + 1, 0, 1, devices[1].publicKey, new Uint8Array(32).fill(1), (bytes) => sign(bytes, devices[0].seed));
    const outcome = await forceTakeover(ports(desktop.store, desktop.keeper), { password: PASSWORD, name: "" });
    expect(outcome.kind).toBe("start");
    expect(opened(network.source("https://relay.test").held).turn).toBe(N + 2);
  });

  it("two standbys forcing at once: the higher sequence starts, the other goes back to standby with nothing to raise", async () => {
    const phone = await device(network, 1, "standby");
    const laptop = await device(network, 2, "standby");
    network.seed(phone.stored);
    // Both read N before either put: the laptop's raise starts while the phone waits for its settle read.
    const phoneTake = phone.keeper.raise();
    let laptopTake: Promise<unknown> | null = null;
    clock.onSleep = async () => { if (!laptopTake) { laptopTake = laptop.keeper.raise(); await laptopTake; } };
    const [phoneOutcome] = await Promise.all([phoneTake]);
    const laptopOutcome = await laptopTake!;
    expect(phoneOutcome?.kind).not.toBe("start");
    expect((laptopOutcome as { kind: string }).kind).toBe("start");
    expect(laptop.store.record).toMatchObject({ state: "active", takeovers: 1 });
    expect(phone.store.record.state).toBe("standby");
    expect(phone.store.record.raise).toBeUndefined();
    expect(phone.store.record.takeovers).toBe(0);
    expect(phone.store.record.copy).toBe("frozen");
    expect(opened(network.source("dht").held).author).toBe(2);
  });

  it("the old active device coming back while the taker settles reads the higher turn and stops, keeping its copy", async () => {
    const phone = await device(network, 1, "standby");
    const desktop = await device(network, 0, "active");
    // The record on the network is the desktop's own, byte for byte.
    network.seed(desktop.stored);
    let desktopOutcome: { kind: string } | null = null;
    // The desktop starts again in the middle of the phone's settle wait: its read at start shows the phone's turn.
    clock.onSleep = async () => { if (!desktopOutcome) desktopOutcome = await desktop.keeper.check(true); };
    const outcome = await phone.keeper.raise();
    expect(outcome?.kind).toBe("start");
    expect(desktopOutcome).toMatchObject({ kind: "gated", state: "superseded" });
    expect(desktop.store.record).toMatchObject({ state: "superseded", copy: "frozen" });
    expect(opened(network.source("dht").held)).toMatchObject({ turn: N + 1, author: 1 });
  });

  it("the old active device that started just before the take writes in its own turn and is replaced at its next read", async () => {
    const phone = await device(network, 1, "standby");
    const desktop = await device(network, 0, "active");
    // The record on the network is the desktop's own, byte for byte.
    network.seed(desktop.stored);
    expect((await desktop.keeper.check(true)).kind).toBe("start");
    expect((await phone.keeper.raise())?.kind).toBe("start");
    expect(await desktop.keeper.check(false)).toMatchObject({ kind: "gated", state: "superseded" });
    expect(desktop.store.record.copy).toBe("frozen");
  });

  it("a takeover that wins writes T after its put: the settle wait is never skipped", async () => {
    const phone = await device(network, 1, "standby");
    network.seed(phone.stored);
    const before = clock.t;
    await phone.keeper.raise();
    expect(clock.t - before).toBeGreaterThanOrEqual(TURN_SETTLE_MS);
  });
});

describe("what keeps a forced takeover from locking the owner out", () => {
  let network: FakeTurnNetwork;
  beforeEach(() => { network = new FakeTurnNetwork(); });

  it("a wrong password writes nothing to the turn and is counted; five in an hour lock the device out without a check", async () => {
    const phone = await device(network, 1, "standby");
    network.seed(phone.stored);
    let checks = 0;
    const counting = async (_v: unknown, p: string) => { checks++; return p === PASSWORD; };
    for (let i = 0; i < 5; i++) {
      await expect(forceTakeover(ports(phone.store, phone.keeper, counting), { password: "guess", name: "Desktop" })).rejects.toThrow("takeover-password");
    }
    expect(network.calls).toEqual([]);
    expect(phone.store.record.takeoverAttempts?.total).toBe(5);
    // The sixth is refused before the password is even checked, the right one included.
    const refusal = await forceTakeover(ports(phone.store, phone.keeper, counting), { password: PASSWORD, name: "Desktop" }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(TakeoverRefusal);
    expect((refusal as TakeoverRefusal).reason).toBe("locked-out");
    expect((refusal as TakeoverRefusal).retry).toBeGreaterThan(0);
    expect(checks).toBe(5);
    expect(network.calls).toEqual([]);
    expect(phone.store.record.state).toBe("standby");
    // An hour later it may try again, and the right password takes over.
    clock.t += 3_600_001;
    expect((await forceTakeover(ports(phone.store, phone.keeper, counting), { password: PASSWORD, name: "Desktop" })).kind).toBe("start");
    expect(phone.store.record.takeoverAttempts).toEqual({ recent: [], total: 0 });
  });

  it("fifteen wrong passwords with no right one refuse the device for good", async () => {
    const phone = await device(network, 1, "standby");
    for (let i = 0; i < 15; i++) {
      await forceTakeover(ports(phone.store, phone.keeper), { password: "guess", name: "Desktop" }).catch(() => {});
      clock.t += 3_600_001;
    }
    const refusal = await forceTakeover(ports(phone.store, phone.keeper), { password: PASSWORD, name: "Desktop" }).catch((e: unknown) => e);
    expect((refusal as TakeoverRefusal).reason).toBe("refused");
    expect(network.calls).toEqual([]);
  });

  it("a standby with no copy of the profile never takes over: it would start an empty profile and stop the real one", async () => {
    const fresh = await device(network, 1, "standby", { copy: undefined });
    expect(canTakeOver(fresh.store.record)).toBe(false);
    await expect(forceTakeover(ports(fresh.store, fresh.keeper), { password: PASSWORD, name: "Desktop" })).rejects.toThrow("takeover-no-copy");
    expect(network.calls).toEqual([]);
  });

  it("a frozen copy with no verifier beside it cannot check a password, so it does not take over", async () => {
    const old = await device(network, 1, "standby", { verifier: undefined });
    await expect(forceTakeover(ports(old.store, old.keeper), { password: PASSWORD, name: "Desktop" })).rejects.toThrow("takeover-no-password");
    expect(network.calls).toEqual([]);
  });

  it("the name of the device that stops must be typed", async () => {
    const phone = await device(network, 1, "standby");
    expect(takeoverTarget(phone.store.record)).toBe("Desktop");
    await expect(forceTakeover(ports(phone.store, phone.keeper), { password: PASSWORD, name: "Laptop" })).rejects.toThrow("takeover-name");
    expect(network.calls).toEqual([]);
  });

  it("the active device and a device mid-handoff are refused", async () => {
    const desktop = await device(network, 0, "active");
    await expect(forceTakeover(ports(desktop.store, desktop.keeper), { password: PASSWORD, name: "" })).rejects.toThrow("takeover-state");
  });

  it("a takeover that loses goes back to what it was, and the device it lost to goes on", async () => {
    const phone = await device(network, 1, "standby");
    // Another device already holds a higher turn than the phone will read: the laptop forces N + 1 after the phone's read.
    const laptop = await device(network, 2, "standby");
    network.seed(phone.stored);
    network.afterRead = () => { network.afterRead = undefined; void laptop.keeper.raise(); };
    clock.onSleep = async () => {};
    const outcome = await forceTakeover(ports(phone.store, phone.keeper), { password: PASSWORD, name: "Desktop" });
    expect(outcome.kind).not.toBe("start");
    expect(phone.store.record).toMatchObject({ state: "standby", takeovers: 0, copy: "frozen" });
    expect(phone.store.record.raise).toBeUndefined();
  });

  it("a superseded device takes the turn back (It wasn't me) above the turn that replaced it", async () => {
    const desktop = await device(network, 0, "superseded", { activeSlot: 1 });
    const intruder = await packet(N + 7, 0, 1);
    network.seed(intruder);
    const outcome = await forceTakeover(ports(desktop.store, desktop.keeper), { password: PASSWORD, name: "Phone" });
    expect(outcome.kind).toBe("start");
    expect(opened(network.source("dht").held)).toMatchObject({ turn: N + 8, author: 0 });
  });
});
