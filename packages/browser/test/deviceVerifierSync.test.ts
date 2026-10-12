import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PkarrTransport } from "@ghostly/core";
import { GhostlyNode } from "../src/engine/node";
import { STORES, transact } from "../src/shared/idb";
import { openDeviceGate, resetDeviceGates } from "../src/devices/gate";
import { closeDevicesDb, readDeviceRecord } from "../src/devices/store";
import { dropDevicesDatabase as dropDevices, putDeviceRecord } from "./helpers/deviceRecord";
// covers: devices.takeover

/*
 * The password proof's verifier beside the device state (WISP 06 § Forced takeover) is the one the profile's settings
 * hold, and none once they hold none: a standby checks a forced takeover's password with it, and the turn record states
 * which one stands. Driven through the engine: the lock password typed again unchanged (Add a device), a new password,
 * a proof that cannot be loaded, a verifier that could not be made.
 */

const pake = vi.hoisted(() => ({ down: false, failMake: false, made: 0 }));
vi.mock("../src/devices/handoffPake", async (original) => ({
  ...(await original<typeof import("../src/devices/handoffPake")>()),
  handoffPakeReady: async () => { if (pake.down) throw new Error("The password proof could not be loaded"); },
  makeHandoffVerifier: async (password: string) => {
    if (pake.down || pake.failMake) throw new Error("The password proof could not be made");
    return { v: 1, setup: btoa(`setup ${++pake.made}`).replace(/=+$/, ""), record: btoa(password).replace(/=+$/, "") };
  },
  // As the real one: false for a wrong password, and false when it cannot be loaded.
  provesHandoffPassword: async (verifier: { record: string }, password: string) => !pake.down && atob(verifier.record) === password,
}));

const transport: PkarrTransport = { publish: async () => {}, publishPayload: async () => {}, resolve: async () => null, describe: () => ({ protocol: "none", relays: [] }) };
const nodes: GhostlyNode[] = [];
afterEach(async () => {
  for (const node of nodes.splice(0)) await node.shutdown().catch(() => {});
  pake.down = false; pake.failMake = false;
  await transact([STORES.settings], (s) => { s[STORES.settings].delete("handoffVerifier"); });
  resetDeviceGates();
  await closeDevicesDb(); await dropDevices();
});

const PHONE = "P".repeat(43), DESKTOP = "D".repeat(43);
const OLD = { v: 1 as const, setup: "b2xkLXNldHVw", record: "b2xkLXJlY29yZA" };

interface Inside { ownDeviceKey: string | null; deviceLinks: unknown; syncDeviceVerifier(): Promise<void> }

async function desktop(verifier?: typeof OLD) {
  await putDeviceRecord({
    v: 1, profile: "ghostly", state: "active", saved: 1, turn: 3, rev: 0, takeovers: 0, earlierSets: [], deviceSet: [{ key: DESKTOP, name: "Desktop" }, { key: PHONE, name: "Phone" }], ownSlot: 0, activeSlot: 0,
    ...(verifier ? { verifier } : {}),
  });
  resetDeviceGates();
  expect((await openDeviceGate("ghostly")).state).toBe("active");
  const node = new GhostlyNode({ onState: vi.fn(), onMessages: vi.fn(), onCallSignal: vi.fn() }, { transport, automaticWallets: false });
  nodes.push(node);
  const inside = node as unknown as Inside;
  inside.ownDeviceKey = DESKTOP;
  // The turn keeper as the engine reaches it: asked to state the verifier, it notes which one the device state held then.
  const stated: unknown[] = [];
  inside.deviceLinks = { turnKeeper: async () => ({ stateVerifier: async () => { stated.push((await readDeviceRecord("ghostly"))?.verifier ?? null); return true; } }) };
  return { node, inside, stated };
}
const kept = async () => (await readDeviceRecord("ghostly"))?.verifier;

describe("the verifier beside the device state follows the profile's", () => {
  it("Add a device, the lock password typed again unchanged: the verifier stays the one every standby holds", async () => {
    const { node, stated } = await desktop();
    await node.deviceHandoffVerifier({ password: "first password" });
    const first = await kept();
    expect(first).toBeDefined();
    expect(pake.made).toBeGreaterThan(0);
    const made = pake.made;
    await node.deviceHandoffVerifier({ password: "first password", current: "first password" });
    await node.deviceHandoffVerifier({ password: "first password", current: "first password" });
    expect(await kept()).toEqual(first);
    expect(pake.made).toBe(made);
    expect(stated.at(-1)).toEqual(first);
  });

  it("a new password: a new verifier, beside the device state before the turn record is asked to state it", async () => {
    const { node, stated } = await desktop();
    await node.deviceHandoffVerifier({ password: "first password" });
    const first = await kept();
    await node.deviceHandoffVerifier({ password: "second password", current: "first password" });
    const second = await kept();
    expect(second).not.toEqual(first);
    expect(stated.at(-1)).toEqual(second);
    // The password it checks must be known to replace it.
    await expect(node.deviceHandoffVerifier({ password: "third password", current: "a guess" })).rejects.toThrow(/handoff-password/);
    expect(await kept()).toEqual(second);
  });

  it("the proof cannot be loaded: an unchanged password keeps its verifier, a changed one leaves none", async () => {
    const { node, stated } = await desktop();
    await node.deviceHandoffVerifier({ password: "first password" });
    const first = await kept();
    pake.down = true;
    await expect(node.deviceHandoffVerifier({ password: "first password", current: "first password" })).rejects.toThrow(/could not be loaded/);
    expect(await kept()).toEqual(first);
    // The lock changed and nothing can check the new password: the old verifier must not go on checking the old one.
    await expect(node.deviceHandoffVerifier({ password: "second password", current: "first password" })).rejects.toThrow(/could not be loaded/);
    expect(await kept()).toBeUndefined();
    expect(stated.at(-1)).toBeNull();
  });

  it("a verifier that could not be made for a new password: the profile has none, the device state keeps none, and that is stated", async () => {
    const { node, stated } = await desktop();
    await node.deviceHandoffVerifier({ password: "first password" });
    pake.failMake = true;
    await expect(node.deviceHandoffVerifier({ password: "second password", current: "first password" })).rejects.toThrow(/could not be made/);
    expect(await kept()).toBeUndefined();
    expect(stated.at(-1)).toBeNull();
    // The unchanged password with a failing make: nothing is made, so nothing fails.
    pake.failMake = false;
    await node.deviceHandoffVerifier({ password: "second password" });
    const second = await kept();
    pake.failMake = true;
    await node.deviceHandoffVerifier({ password: "second password", current: "second password" });
    expect(await kept()).toEqual(second);
  });

  it("a device state that holds a verifier the profile no longer has loses it at the next start; one that matches is kept", async () => {
    const { inside } = await desktop(OLD);
    await inside.syncDeviceVerifier();
    expect(await kept()).toBeUndefined();
    await transact([STORES.settings], (s) => { s[STORES.settings].put(OLD, "handoffVerifier"); });
    await inside.syncDeviceVerifier();
    expect(await kept()).toEqual(OLD);
    const saved = (await readDeviceRecord("ghostly"))!.saved;
    await inside.syncDeviceVerifier();
    expect((await readDeviceRecord("ghostly"))!.saved).toBe(saved);
  });
});
