import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELAY_POLL_INTERVALS, randomBytes, toBase64Url, type NativeEndpoint, type NativeTransport } from "@ghostly/core";
import { EnrollInviter, EnrollJoiner, ghostLinkEnrollChannel } from "../src/devices/enroll";
import { DeviceLinks } from "../src/devices/links";
import { DEVICE_KEYS_DB, closeDeviceKeysDb, loadDeviceSigningKey } from "../src/devices/signingKey";
import { closeDevicesDb, readDeviceRecord, setDeviceMirror } from "../src/devices/store";
import { dropDevicesDatabase } from "./helpers/deviceRecord";
import { FakeTurnNetwork } from "./helpers/turnNetwork";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, useFakeWorld, yieldToLoop } from "../../core/test/support/pairingWorld";
import { NativeWorld } from "../../core/test/support/nativeWorld";
// covers: devices.enroll, devices.enroll.session

/*
 * Adding a device over a real one-time session (WISP 06 § Adding a device): two GhostLinks on the code's link, through
 * a relay in memory and fake WebRTC, signing through the two device signing keys (one non-extractable, one a seed).
 * Then the device links the two records name: live, and a ping echoed. Every key and secret is made in the test.
 */

const A = "ghostly_desktop", B = "ghostly_phone";
const dropKeys = () => new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase(DEVICE_KEYS_DB); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
let pkarr: MemoryPkarr;
const links: DeviceLinks[] = [];

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
async function until(condition: () => boolean, limit: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < limit) { if (condition()) return true; await run(250); }
  return condition();
}

beforeEach(async () => {
  setDeviceMirror(null);
  await closeDevicesDb(); await closeDeviceKeysDb(); await dropDevicesDatabase(); await dropKeys();
  useFakeWorld();
  pkarr = new MemoryPkarr(DESKTOP_NETWORK);
});
afterEach(async () => {
  const stopping = Promise.all(links.splice(0).map((l) => l.stop()));
  if (vi.isFakeTimers()) { await settled(stopping); await closeWorld(); } else await stopping;
  vi.useRealTimers();
});

describe("enroll/1 over a one-time paired session", () => {
  it("both devices show the same digits, the new one ends as a standby, and the two hold a live device link", async () => {
    const network = new FakeTurnNetwork();
    const open = (owner: string) => ghostLinkEnrollChannel({ transport: pkarr.transport(), createPeerConnection: () => fakePeerConnection(owner), pollIntervals: RELAY_POLL_INTERVALS });
    const a = new EnrollInviter({ profile: A, network, open: open("desktop"), didSeed: async () => randomBytes(32), name: "Desktop" });
    const b = new EnrollJoiner({ profile: B, network, open: open("phone"), about: { name: "Phone", kind: "web", app: "1.1.0" }, forceSeed: true, install: null });
    const waiting = await settled(a.start());
    if (waiting.step !== "waiting") throw new Error("no code");
    expect(waiting.code).toMatch(/^ghostly1z/);
    await settled(b.start(waiting.code));
    expect(await until(() => a.current().step === "confirm" && b.current().step === "confirm", 60_000)).toBe(true);
    const av = a.current(), bv = b.current();
    if (av.step !== "confirm" || bv.step !== "confirm") throw new Error("no digits");
    expect(av.digits).toBe(bv.digits);
    expect(av.device).toBe("Phone");

    await settled(a.confirm(true));
    expect(await until(() => a.ended && b.ended, 60_000)).toBe(true);
    expect(a.current()).toEqual({ role: "inviter", step: "done", device: "Phone", published: true });
    expect(b.current()).toEqual({ role: "joiner", step: "done", device: "Desktop" });
    const ra = (await settled(readDeviceRecord(A)))!, rb = (await settled(readDeviceRecord(B)))!;
    expect(ra.state).toBe("active");
    expect(rb.state).toBe("standby");
    expect((await settled(loadDeviceSigningKey(A)))!.kind).toBe("webcrypto");
    expect(rb.deviceSet[0]?.key).toBe(toBase64Url((await settled(loadDeviceSigningKey(A)))!.publicKey));

    // The device links the records name: the active device and the new standby find each other, and a ping comes back.
    const desktop = new DeviceLinks({ profile: A, transport: pkarr.transport(), pollIntervals: RELAY_POLL_INTERVALS, createPeerConnection: () => fakePeerConnection("desktop-link"), turn: network });
    const phone = new DeviceLinks({ profile: B, transport: pkarr.transport(), pollIntervals: RELAY_POLL_INTERVALS, createPeerConnection: () => fakePeerConnection("phone-link"), turn: network });
    links.push(desktop, phone);
    await settled(Promise.all([desktop.start(), phone.start()]));
    const phoneKey = rb.deviceSet[1]!.key, desktopKey = rb.deviceSet[0]!.key;
    expect(await until(() => desktop.live(phoneKey) && phone.live(desktopKey), 90_000)).toBe(true);
    expect(await settled(phone.ping(desktopKey))).toBeGreaterThanOrEqual(0);
    expect(await settled(desktop.ping(phoneKey))).toBeGreaterThanOrEqual(0);
    expect(await settled(phone.call("deviceSet", null))).toMatchObject({ state: "standby", devices: [{ name: "Desktop", active: true, status: "live" }, { name: "Phone", self: true }] });
  });

  it("a Linux Desktop with no WebRTC joins from a web page that has WebRTC: the page starts its native endpoint for it", async () => {
    const network = new FakeTurnNetwork();
    const native = new NativeWorld();
    native.hexIds = true;
    const factories = (name: string): Partial<Record<NativeTransport, (seed: string) => Promise<NativeEndpoint>>> => ({ "iroh/1": async () => native.endpoint("iroh/1", name) });
    const web = ghostLinkEnrollChannel({ transport: pkarr.transport(), createPeerConnection: () => fakePeerConnection("web"), nativeTransports: factories("web"), pollIntervals: RELAY_POLL_INTERVALS });
    const linux = ghostLinkEnrollChannel({ transport: pkarr.transport(), nativeTransports: factories("linux"), pollIntervals: RELAY_POLL_INTERVALS });
    const a = new EnrollInviter({ profile: A, network, open: web, didSeed: async () => randomBytes(32), name: "Web", forceSeed: true });
    const b = new EnrollJoiner({ profile: B, network, open: linux, about: { name: "Linux", kind: "desktop", app: "1.1.0" }, forceSeed: true, install: null });
    const waiting = await settled(a.start());
    if (waiting.step !== "waiting") throw new Error("no code");
    await settled(b.start(waiting.code));
    expect(await until(() => a.current().step === "confirm" && b.current().step === "confirm", 90_000)).toBe(true);
    await settled(a.confirm(true));
    expect(await until(() => a.ended && b.ended, 60_000)).toBe(true);
    expect(a.current()).toMatchObject({ step: "done", device: "Linux" });
    expect(b.current()).toMatchObject({ step: "done", device: "Web" });
    // The page dialled, or was dialled, on Iroh: it started an endpoint although it has WebRTC.
    expect((native.dialsBy.get("web") ?? 0) + (native.dialsBy.get("linux") ?? 0)).toBeGreaterThan(0);
  });

  it("two devices that see each other and cannot connect both say so, at the joiner's timeout", async () => {
    const network = new FakeTurnNetwork();
    // A page with WebRTC and nothing native, and a device with neither that it could use: no transport in common.
    const web = ghostLinkEnrollChannel({ transport: pkarr.transport(), createPeerConnection: () => fakePeerConnection("web"), pollIntervals: RELAY_POLL_INTERVALS });
    const linux = ghostLinkEnrollChannel({ transport: pkarr.transport(), pollIntervals: RELAY_POLL_INTERVALS });
    const timing = { proofMs: 30_000 };
    const a = new EnrollInviter({ profile: A, network, open: web, didSeed: async () => randomBytes(32), name: "Web", forceSeed: true, timing });
    const b = new EnrollJoiner({ profile: B, network, open: linux, about: { name: "Linux", kind: "desktop", app: "1.1.0" }, forceSeed: true, install: null, timing });
    const waiting = await settled(a.start());
    if (waiting.step !== "waiting") throw new Error("no code");
    await settled(b.start(waiting.code));
    // Well inside the code's ten minutes: both screens end, neither with digits.
    expect(await until(() => a.ended && b.ended, 90_000)).toBe(true);
    expect(a.current()).toEqual({ role: "inviter", step: "failed", reason: "unreached" });
    expect(b.current()).toEqual({ role: "joiner", step: "failed", reason: "unreached" });
    expect(await settled(readDeviceRecord(B))).toBeNull();
  });

  it("a second device with the same code gets no session once the first one authenticated", async () => {
    const network = new FakeTurnNetwork();
    const open = (owner: string) => ghostLinkEnrollChannel({ transport: pkarr.transport(), createPeerConnection: () => fakePeerConnection(owner), pollIntervals: RELAY_POLL_INTERVALS });
    const a = new EnrollInviter({ profile: A, network, open: open("desktop"), didSeed: async () => randomBytes(32), name: "Desktop", forceSeed: true });
    const b = new EnrollJoiner({ profile: B, network, open: open("phone"), about: { name: "Phone", kind: "web", app: "1.1.0" }, forceSeed: true, install: null });
    const waiting = await settled(a.start());
    if (waiting.step !== "waiting") throw new Error("no code");
    await settled(b.start(waiting.code));
    expect(await until(() => a.current().step === "confirm", 60_000)).toBe(true);
    const intruder = new EnrollJoiner({ profile: "ghostly_intruder", network, open: open("intruder"), about: { name: "Intruder", kind: "web", app: "1.1.0" }, forceSeed: true, install: null, timing: { proofMs: 60_000 } });
    await settled(intruder.start(waiting.code));
    expect(await until(() => intruder.ended, 90_000)).toBe(true);
    expect(intruder.current()).toMatchObject({ step: "failed" });
    // The person's device is still the one on the inviter's screen.
    expect(a.current()).toMatchObject({ step: "confirm", device: "Phone" });
    await settled(a.cancel());
    expect(await settled(readDeviceRecord("ghostly_intruder"))).toBeNull();
  });
});
