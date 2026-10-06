import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_POLL_INTERVALS, newDeviceSetSecret, signTurnPacket, toBase64Url, turnKeys } from "@ghostly/core";
import { FakeTurnNetwork } from "./helpers/turnNetwork";
import { resetDeviceGates, type DeviceGateView } from "../src/devices/gate";
import type { HandoffSource, HandoffStaging, HandoffStagingHost } from "../src/devices/handoff";
import type { HandoffProfileHost } from "../src/devices/handoffHost";
import { standbyHandoff } from "../src/devices/handoffStandby";
import { DeviceLinks } from "../src/devices/links";
import { DEVICE_KEYS_DB, closeDeviceKeysDb, createDeviceSigningKey } from "../src/devices/signingKey";
import type { DeviceRecord } from "../src/devices/state";
import { closeDevicesDb, readDeviceRecord, setDeviceMirror } from "../src/devices/store";
import { DB_VERSION } from "../src/shared/idb";
import { dropDevicesDatabase, putDeviceRecord } from "./helpers/deviceRecord";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, useFakeWorld, yieldToLoop } from "../../core/test/support/pairingWorld";
// covers: devices.handoff

/*
 * A device that released the profile and never heard the taker's `handoff-done` (WISP 06 § The handoff): that frame goes
 * once, as the taker reloads into its new state, and can be lost. The standby's next turn read finds the taker's record
 * ("Active on <device>"), and that ends the handoff here too: before, the screen kept "Moving to <device>. Waiting for it
 * to finish." with no Use here, after every restart, until the other device offered the profile back.
 */

let pkarr: MemoryPkarr;
const engines: DeviceLinks[] = [];
const dropKeys = () => new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(DEVICE_KEYS_DB); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });

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

const host: HandoffProfileHost = {
  app: "test", kind: "web",
  source: () => ({}) as HandoffSource,
  staging: {
    open: async (database?: string) => ({ database: database ?? "ghostly_staged", dropRest: async () => {} }) as unknown as HandoffStaging,
    install: async () => {}, revert: async () => {}, drop: async () => {},
  } satisfies HandoffStagingHost,
  storedVersion: async () => DB_VERSION,
};

beforeEach(async () => {
  setDeviceMirror(null); resetDeviceGates();
  await closeDevicesDb(); await closeDeviceKeysDb(); await dropDevicesDatabase(); await dropKeys();
  useFakeWorld();
  pkarr = new MemoryPkarr(DESKTOP_NETWORK);
});
afterEach(async () => {
  const stopping = Promise.all(engines.splice(0).map((links) => links.stop()));
  if (vi.isFakeTimers()) { await settled(stopping); await closeWorld(); } else await stopping;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The desktop released the profile to the tablet and the tablet took it, but its `handoff-done` never came. */
async function releasedDesktop(): Promise<{ links: DeviceLinks; profile: string; turn: FakeTurnNetwork }> {
  const d = newDeviceSetSecret(), keys = turnKeys(d);
  const turn = new FakeTurnNetwork();
  const desktopProfile = "ghostly_desktop";
  const desktopKey = await createDeviceSigningKey(desktopProfile, { forceSeed: true });
  const tabletKey = await createDeviceSigningKey("ghostly_tablet", { forceSeed: true });
  const slots = [{ key: desktopKey.publicKey, name: "Desktop" }, { key: tabletKey.publicKey, name: "Tablet" }, null, null];
  const deviceSet = [{ key: toBase64Url(desktopKey.publicKey), name: "Desktop" }, { key: toBase64Url(tabletKey.publicKey), name: "Tablet" }];
  // The desktop's own record at turn 7, and the tablet's at turn 8 (it took the release and wrote its record).
  const before = await signTurnPacket(keys, { turn: 7, rev: 0, author: 0, active: 0, slots, instance: new Uint8Array(8).fill(1) }, (bytes) => desktopKey.sign(bytes));
  const after = await signTurnPacket(keys, { turn: 8, rev: 0, author: 1, active: 1, slots, instance: new Uint8Array(8).fill(2) }, (bytes) => tabletKey.sign(bytes));
  turn.seed(after);
  const tablet = deviceSet[1].key;
  await putDeviceRecord({
    v: 1, profile: desktopProfile, state: "standby", saved: 1, turn: 7, rev: 0, takeovers: 0, earlierSets: [], turnPacket: toBase64Url(before),
    deviceSet, activeSlot: 1, ownSlot: 0, d: toBase64Url(d), signingKey: desktopKey.kind, releasedTurn: 8, copy: "frozen",
    handoff: { role: "releasing", step: "released", id: "x".repeat(22), peer: tablet, from: 7, at: 1, release: { turn: 8, to: tablet, h: "h".repeat(43), s: "s".repeat(86) } },
  });

  const shown: DeviceGateView[] = [];
  const links = new DeviceLinks({
    profile: desktopProfile, transport: pkarr.transport(), pollIntervals: RELAY_POLL_INTERVALS, createPeerConnection: () => fakePeerConnection("Desktop"), turn,
    handoff: async (running) => standbyHandoff({ profile: desktopProfile, links: running, host, show: (view) => { shown.push(view); }, take: async () => null }),
  });
  engines.push(links);
  await settled(links.start());
  // After the restart the release is still out: "Moving to Tablet. Waiting for it to finish."
  expect(await settled(links.call("deviceHandoffView", null) as Promise<unknown>)).toMatchObject({ role: "giver", step: "switching" });
  return { links, profile: desktopProfile, turn };
}

describe("a standby that released the profile and never heard handoff-done", () => {
  it("ends the handoff on the turn read that finds the taker's record, and offers Use here again", async () => {
    const { links, profile: desktopProfile } = await releasedDesktop();
    const outcome = await settled(links.checkTurn());
    expect(outcome).toMatchObject({ kind: "show", screen: "active-on", device: "Tablet" });
    await run(1_000);
    expect(await settled(links.call("deviceHandoffView", null) as Promise<unknown>)).toBeNull();
    expect(((await readDeviceRecord(desktopProfile)) as DeviceRecord).handoff).toBeUndefined();
    expect(((await readDeviceRecord(desktopProfile)) as DeviceRecord).state).toBe("standby");
  });

  it("Use here reads the turn first: the old handoff ends, and the pull is a new one with the device that has the profile", async () => {
    const { links, profile, turn } = await releasedDesktop();
    // Its link to the tablet is up: only the release still out makes it read the turn before it asks.
    vi.spyOn(links, "handoffLive").mockReturnValue(true);
    const reads = turn.calls.filter((call) => call.op === "read").length;
    const view = await settled(links.call("deviceHandoffPull", { password: "a long lock password" }) as Promise<unknown>);
    expect(turn.calls.filter((call) => call.op === "read").length).toBeGreaterThan(reads);
    expect(((await readDeviceRecord(profile)) as DeviceRecord).handoff?.role).not.toBe("releasing");
    expect(view).toMatchObject({ role: "taker" });
  });
});
