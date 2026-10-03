import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_POLL_INTERVALS, newDeviceSetSecret, toBase64Url, type PkarrTransport } from "@ghostly/core";
import { replaceDeviceGate, resetDeviceGates } from "../src/devices/gate";
import { DeviceLinks } from "../src/devices/links";
import { DEVICE_KEYS_DB, closeDeviceKeysDb, createDeviceSigningKey, type DeviceSigningKey } from "../src/devices/signingKey";
import type { DeviceSlot } from "../src/devices/state";
import { closeDevicesDb, setDeviceMirror } from "../src/devices/store";
import { GhostlyNode } from "../src/engine/node";
import { databaseName } from "../src/shared/idb";
import { dropDevicesDatabase, putDeviceRecord } from "./helpers/deviceRecord";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, useFakeWorld, yieldToLoop } from "../../core/test/support/pairingWorld";
// covers: devices.turn.keeper

/*
 * A running active device reads the turn (WISP 06 § When a device checks): every 10 minutes while it runs, and at once
 * when another device's link says it holds the turn. A read that says another device took over stops it. Before, only
 * a start, the network coming back or a single-writer wallet opening read it, so a device that another one took over
 * from while it ran went on as the active one until it restarted. Every key and secret is made in the test.
 */

const dropKeys = () => new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(DEVICE_KEYS_DB); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });

beforeEach(async () => {
  setDeviceMirror(null); resetDeviceGates();
  await closeDevicesDb(); await closeDeviceKeysDb(); await dropDevicesDatabase(); await dropKeys();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); resetDeviceGates(); });

describe("the active device's engine", () => {
  const transport: PkarrTransport = {
    publish: async () => {}, publishPayload: async () => {}, resolve: async () => null, describe: () => ({ protocol: "none", relays: [] }),
    turnRead: async () => [], turnPut: async () => [],
  };
  const replaced = { kind: "gated", state: "superseded", reload: true, read: { result: "other" } };
  const node = async () => {
    const made = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn(), onDeviceGate: vi.fn() }, { transport, automaticWallets: false });
    const inner = made as unknown as Record<string, unknown> & { settings: { online: boolean } };
    inner.settings.online = true;
    const checkTurn = vi.fn(async () => ({ kind: "go-on", restricted: false, read: { result: "mine" } }) as unknown);
    inner.deviceLinks = { checkTurn, stop: async () => {} };
    replaceDeviceGate({ profile: databaseName(), state: "active", full: true, view: null });
    const d = newDeviceSetSecret();
    await putDeviceRecord({ v: 1, profile: databaseName(), state: "superseded", saved: 1, turn: 8, rev: 0, takeovers: 0, earlierSets: [], deviceSet: [{ key: toBase64Url(new Uint8Array(32).fill(1)), name: "Desktop" }, { key: toBase64Url(new Uint8Array(32).fill(2)), name: "Phone" }], activeSlot: 1, ownSlot: 0, d: toBase64Url(d), signingKey: "seed" });
    const stop = vi.spyOn(inner as unknown as { stopReplaced(view: unknown): Promise<void> }, "stopReplaced").mockResolvedValue();
    return { made, inner, checkTurn, stop };
  };

  it("reads the turn every 10 minutes while it runs, and notes a good read", async () => {
    const { made, inner, checkTurn, stop } = await node();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    (inner as unknown as { watchActiveTurn(): void }).watchActiveTurn();
    await vi.advanceTimersByTimeAsync(GhostlyNode.ACTIVE_TURN_EVERY_MS - 1);
    expect(checkTurn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(61_001);
    expect(checkTurn).toHaveBeenCalledTimes(1);
    expect(inner.turnGoodAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(GhostlyNode.ACTIVE_TURN_EVERY_MS + 61_000);
    expect(checkTurn).toHaveBeenCalledTimes(2);
    expect(stop).not.toHaveBeenCalled();
    vi.useRealTimers();
    await made.shutdown();
  });

  it("reads it at once on a hint and stops when another device took over, and not when the profile is limited or offline", async () => {
    const { inner, checkTurn, stop } = await node();
    checkTurn.mockResolvedValue(replaced);
    const read = () => (inner as unknown as { readActiveTurn(): Promise<void> }).readActiveTurn();
    inner.limitedMode = true;
    await read();
    inner.limitedMode = false; inner.settings.online = false;
    await read();
    expect(checkTurn).not.toHaveBeenCalled();
    inner.settings.online = true;
    await read();
    expect(checkTurn).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("the device links of the active device", () => {
  let pkarr: MemoryPkarr;
  const engines: DeviceLinks[] = [];
  async function run(ms: number): Promise<void> {
    for (let t = 0; t < ms; t += 250) { await vi.advanceTimersByTimeAsync(250); await yieldToLoop(); await yieldToLoop(); }
  }
  async function settled<T>(work: Promise<T>): Promise<T> {
    let done = false;
    const tracked = work.finally(() => { done = true; });
    tracked.catch(() => {});
    for (let i = 0; !done && i < 400; i++) await run(250);
    return tracked;
  }
  afterEach(async () => {
    const stopping = Promise.all(engines.splice(0).map((links) => links.stop()));
    if (vi.isFakeTimers()) { await settled(stopping); await closeWorld(); } else await stopping;
  });

  it("hand the engine another device's hint that it holds the turn", async () => {
    useFakeWorld();
    pkarr = new MemoryPkarr(DESKTOP_NETWORK);
    const d = newDeviceSetSecret();
    const make = async (name: string) => {
      const profile = `ghostly_${name.toLowerCase()}`;
      const key: DeviceSigningKey = await createDeviceSigningKey(profile, { forceSeed: true });
      return { profile, name, key, slot: { key: toBase64Url(key.publicKey), name } as DeviceSlot };
    };
    const desktop = await make("Desktop"), phone = await make("Phone");
    const set = [desktop.slot, phone.slot];
    // Both think they are the active one: the phone took over while the desktop ran.
    await putDeviceRecord({ v: 1, profile: desktop.profile, state: "active", saved: 1, turn: 7, rev: 0, takeovers: 0, earlierSets: [], deviceSet: set, activeSlot: 0, ownSlot: 0, d: toBase64Url(d), signingKey: desktop.key.kind });
    await putDeviceRecord({ v: 1, profile: phone.profile, state: "active", saved: 1, turn: 8, rev: 0, takeovers: 1, earlierSets: [], deviceSet: set, activeSlot: 1, ownSlot: 1, d: toBase64Url(d), signingKey: phone.key.kind });
    const hinted = vi.fn();
    const desktopLinks = new DeviceLinks({ profile: desktop.profile, transport: pkarr.transport(), pollIntervals: RELAY_POLL_INTERVALS, createPeerConnection: () => fakePeerConnection("Desktop"), onActiveHint: hinted });
    const phoneLinks = new DeviceLinks({ profile: phone.profile, transport: pkarr.transport(), pollIntervals: RELAY_POLL_INTERVALS, createPeerConnection: () => fakePeerConnection("Phone") });
    engines.push(desktopLinks, phoneLinks);
    await settled(Promise.all([desktopLinks.start(), phoneLinks.start()]));
    const start = Date.now();
    while (Date.now() - start < 120_000 && !hinted.mock.calls.length) await run(250);
    expect(hinted).toHaveBeenCalled();
  });
});
