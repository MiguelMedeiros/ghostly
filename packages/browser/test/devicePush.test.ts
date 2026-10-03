import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import {
  RELAY_POLL_INTERVALS, decryptPushPayload, generateVapidKeys, newDeviceSetSecret, newWakeToken, toBase64Url, utf8Decode, type PushRequest, type WakeTarget,
} from "@ghostly/core";
import { resetDeviceGates } from "../src/devices/gate";
import { DeviceLinks, type DeviceLinksOptions } from "../src/devices/links";
import {
  DEVICE_WAKE_FRAME, DeviceWaker, deviceOfToken, deviceWakeFrame, otherTarget, ownTargetFor, profileWakeAfter, profileWakeOnRemoval, pushForSet, readDeviceWake,
  DEVICE_TOKENS_FRAME, readDeviceTokens, wakeOwnerOf, withAllowed, withOtherPush, withOwnPush, withRenew,
} from "../src/devices/push";
import { DEVICE_KEYS_DB, closeDeviceKeysDb, createDeviceSigningKey, type DeviceSigningKey } from "../src/devices/signingKey";
import { parseDeviceRecord, type DeviceRecord, type DeviceSlot, type StoredDeviceState } from "../src/devices/state";
import { closeDevicesDb, readDeviceRecord, setDeviceMirror } from "../src/devices/store";
import type { WakeSubscription } from "../src/shared/types";
import { dropDevicesDatabase, putDeviceRecord } from "./helpers/deviceRecord";
import { DESKTOP_NETWORK, MemoryPkarr, closeWorld, fakePeerConnection, useFakeWorld, yieldToLoop } from "../../core/test/support/pairingWorld";
// covers: devices.push, devices.push.wake, devices.push.renew

/*
 * Push and the phone (WISP 06 § Push and the phone): the rules that keep the profile's push target across a switch,
 * the device record's push fields, the `device-wake` frame between two devices' links, and the wake-up a handoff posts
 * to a device whose link is down. Every key and subscription is made in the test.
 */

const PHONE = "P".repeat(43), DESKTOP = "D".repeat(43), LAPTOP = "L".repeat(43);

function subscription(endpoint = "https://fcm.googleapis.com/fcm/send/phone") {
  const secret = p256.utils.randomSecretKey();
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub: WakeSubscription = { endpoint, p256dh: toBase64Url(p256.getPublicKey(secret, false)), auth: toBase64Url(auth), vapid: generateVapidKeys() };
  return { sub, secret, auth, target: (token = newWakeToken()): WakeTarget => ({ endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, vapid: sub.vapid, token }) };
}

const record = (patch: Partial<DeviceRecord> = {}): DeviceRecord => ({
  v: 1, profile: "ghostly", state: "active", saved: 1, turn: 3, rev: 0, takeovers: 0, earlierSets: [], deviceSet: [{ key: DESKTOP, name: "Desktop" }, { key: PHONE, name: "Phone" }, null, null], ownSlot: 0, activeSlot: 0, ...patch,
});

describe("the profile's push target across a switch", () => {
  const phone = subscription();

  it("the active device's own subscription is never replaced by another device's", () => {
    const own = { ...subscription("https://fcm.googleapis.com/fcm/send/desktop").sub, device: DESKTOP };
    expect(profileWakeAfter(own, PHONE, phone.target(), DESKTOP)).toEqual({ next: own, changed: false });
    expect(profileWakeAfter(own, PHONE, null, DESKTOP)).toEqual({ next: own, changed: false });
  });

  it("a desktop with none of its own takes the phone's, and keeps it while the phone is on standby", () => {
    const taken = profileWakeAfter(undefined, PHONE, phone.target(), DESKTOP);
    expect(taken).toEqual({ next: { ...phone.sub, device: PHONE }, changed: true });
    // The phone says the same again on its next session: nothing changes, so contacts are not told again.
    expect(profileWakeAfter(taken.next, PHONE, phone.target(), DESKTOP).changed).toBe(false);
    // Another device's target does not take the phone's place.
    expect(profileWakeAfter(taken.next, LAPTOP, subscription("https://fcm.googleapis.com/fcm/send/laptop").target(), DESKTOP).changed).toBe(false);
  });

  it("the phone's browser replaced its subscription: the new one is the profile's, under the phone's name", () => {
    const current = { ...phone.sub, device: PHONE };
    const replaced = subscription("https://fcm.googleapis.com/fcm/send/phone-2");
    expect(profileWakeAfter(current, PHONE, replaced.target(), DESKTOP)).toEqual({ next: { ...replaced.sub, device: PHONE }, changed: true });
  });

  it("the phone has none any more: the profile has none, and contacts are told", () => {
    expect(profileWakeAfter({ ...phone.sub, device: PHONE }, PHONE, null, DESKTOP)).toEqual({ next: undefined, changed: true });
    // A device that never gave the profile its own says nothing about it.
    expect(profileWakeAfter({ ...phone.sub, device: PHONE }, LAPTOP, null, DESKTOP).changed).toBe(false);
  });

  it("a subscription made before the profile had a device set is the phone's once the phone shares the same one", () => {
    expect(profileWakeAfter(phone.sub, PHONE, phone.target(), DESKTOP)).toEqual({ next: { ...phone.sub, device: PHONE }, changed: true });
    // A different one is not taken for it: nobody said whose it was.
    expect(profileWakeAfter(phone.sub, PHONE, subscription("https://fcm.googleapis.com/fcm/send/other").target(), DESKTOP).changed).toBe(false);
  });

  it("a removed device's subscription goes with it; another's stays", () => {
    expect(profileWakeOnRemoval({ ...phone.sub, device: PHONE }, PHONE)).toEqual({ next: undefined, changed: true });
    expect(profileWakeOnRemoval({ ...phone.sub, device: PHONE }, LAPTOP).changed).toBe(false);
    expect(profileWakeOnRemoval(undefined, PHONE).changed).toBe(false);
  });

  it("tells the pages whose it is", () => {
    expect(wakeOwnerOf({ ...phone.sub, device: PHONE }, PHONE)).toBe("here");
    expect(wakeOwnerOf({ ...phone.sub, device: PHONE }, DESKTOP)).toBe("away");
    expect(wakeOwnerOf(phone.sub, DESKTOP)).toBeUndefined();
    expect(wakeOwnerOf({ ...phone.sub, device: PHONE }, null)).toBeUndefined();
  });
});

describe("the device record's push fields", () => {
  it("make a token per device once, keep it when only the endpoint changes, and drop the tokens of a new key pair", () => {
    const first = subscription();
    let rec = record({ ownSlot: 1 });
    rec = parseDeviceRecord({ ...rec, ...withOwnPush(rec, first.sub)! });
    const made = ownTargetFor(rec, DESKTOP);
    expect(made.patch).toBeDefined();
    rec = parseDeviceRecord({ ...rec, ...made.patch! });
    expect(ownTargetFor(rec, DESKTOP)).toEqual({ target: made.target });
    expect(deviceOfToken(rec.push, made.target!.token)).toBe(DESKTOP);
    // The browser replaced the subscription: same key pair, same token for the desktop.
    const replaced = { ...subscription("https://fcm.googleapis.com/fcm/send/phone-2").sub, vapid: first.sub.vapid };
    rec = parseDeviceRecord({ ...rec, ...withOwnPush(rec, replaced)! });
    expect(ownTargetFor(rec, DESKTOP).target).toEqual({ ...made.target, endpoint: replaced.endpoint, p256dh: replaced.p256dh, auth: replaced.auth });
    // The same subscription again writes nothing.
    expect(withOwnPush(rec, replaced)).toBeNull();
    // A new key pair is a new subscription: the old tokens name nothing.
    rec = parseDeviceRecord({ ...rec, ...withOwnPush(rec, subscription("https://fcm.googleapis.com/fcm/send/phone-3").sub)! });
    expect(deviceOfToken(rec.push, made.target!.token)).toBeNull();
    // None any more: no target, and nothing for anyone.
    rec = parseDeviceRecord({ ...rec, ...withOwnPush(rec, null)! });
    expect(rec.push).toBeUndefined();
    expect(ownTargetFor(rec, DESKTOP)).toEqual({ target: null });
  });

  it("keep each other device's target, forget it on none, and drop a device the set no longer lists", () => {
    const phone = subscription();
    let rec = record();
    rec = parseDeviceRecord({ ...rec, ...withOtherPush(rec, PHONE, phone.target("t".repeat(22)))! });
    expect(otherTarget(rec, PHONE)).toEqual(phone.target("t".repeat(22)));
    expect(withOtherPush(rec, PHONE, phone.target("t".repeat(22)))).toBeNull();
    // Removed: the set lists it no more, and its target goes.
    const removed = parseDeviceRecord({ ...rec, deviceSet: [{ key: DESKTOP, name: "Desktop" }, null, null, null] });
    expect(otherTarget(parseDeviceRecord({ ...removed, ...pushForSet(removed)! }), PHONE)).toBeNull();
    rec = parseDeviceRecord({ ...rec, ...withOtherPush(rec, PHONE, null)! });
    expect(rec.push).toBeUndefined();
  });

  it("a removed device knew this device's subscription: it is to be made again; a new endpoint does it", () => {
    const own = subscription();
    let rec = record({ ownSlot: 1 });
    rec = parseDeviceRecord({ ...rec, ...withOwnPush(rec, own.sub)!, });
    rec = parseDeviceRecord({ ...rec, ...ownTargetFor(rec, DESKTOP).patch! });
    rec = parseDeviceRecord({ ...rec, ...withOtherPush(rec, DESKTOP, subscription("https://fcm.googleapis.com/fcm/send/desktop").target())! });
    expect(rec.push?.renew).toBeUndefined();
    // The desktop is removed: its token and target go, and this device's subscription is to be renewed.
    const removed = parseDeviceRecord({ ...rec, deviceSet: [null, { key: PHONE, name: "Phone" }, null, null] });
    const after = parseDeviceRecord({ ...removed, ...pushForSet(removed)! });
    expect(after.push).toEqual({ own: { ...after.push!.own!, tokens: {} }, renew: true });
    // The same subscription again does nothing; a new endpoint (and key pair) is the renewal.
    expect(withOwnPush(after, own.sub)).toBeNull();
    const renewed = parseDeviceRecord({ ...after, ...withOwnPush(after, subscription("https://fcm.googleapis.com/fcm/send/phone-2").sub)! });
    expect(renewed.push?.renew).toBeUndefined();
    // A device with no subscription has nothing to renew.
    const none = record();
    expect(withRenew(none)).toBeNull();
    expect(pushForSet(parseDeviceRecord({ ...none, ...withOtherPush(none, PHONE, own.target())!, deviceSet: [{ key: DESKTOP, name: "Desktop" }, null, null, null] }))).toEqual({ push: undefined });
  });

  it("keep the chats' tokens the active device lists, and a renewal it asks for; a malformed list says nothing", () => {
    const own = subscription();
    let rec = record({ ownSlot: 1, state: "standby" });
    rec = parseDeviceRecord({ ...rec, ...withOwnPush(rec, own.sub)! });
    const tokens = readDeviceTokens({ t: DEVICE_TOKENS_FRAME, k: ["b".repeat(22), "a".repeat(22), "a".repeat(22)] })!;
    expect(tokens).toEqual(["a".repeat(22), "b".repeat(22)]);
    rec = parseDeviceRecord({ ...rec, ...withAllowed(rec, tokens)! });
    expect(withAllowed(rec, tokens)).toBeNull();
    rec = parseDeviceRecord({ ...rec, ...withRenew(rec)! });
    expect(rec.push).toMatchObject({ renew: true, allowed: tokens });
    expect(withRenew(rec)).toBeNull();
    expect(readDeviceTokens({ t: DEVICE_TOKENS_FRAME, k: ["<script>"] })).toBeNull();
    expect(readDeviceTokens({ t: DEVICE_TOKENS_FRAME, k: "x" })).toBeNull();
    expect(() => parseDeviceRecord({ ...rec, push: { ...rec.push, renew: false } } as never)).toThrow(/push/);
    expect(() => parseDeviceRecord({ ...rec, push: { ...rec.push, allowed: ["short"] } } as never)).toThrow(/push/);
  });

  it("refuse a record whose push fields are not push targets", () => {
    const bad = [{ own: { e: "https://x", p: "p", a: "a", vp: "v", vk: "k" } }, { own: { e: "https://x", p: "p", a: "a", vp: "v", vk: "k", tokens: { [DESKTOP]: "short" } } },
      { others: { [PHONE]: { e: "https://x", p: "p", a: "a", vp: "v", vk: "k" } } }, { others: [] }];
    for (const push of bad) expect(() => parseDeviceRecord(record({ push } as never)), JSON.stringify(push)).toThrow(/push/);
  });

  it("the frame round-trips; a malformed one says nothing", () => {
    const target = subscription().target();
    expect(readDeviceWake(JSON.parse(JSON.stringify(deviceWakeFrame(target))))).toEqual(target);
    expect(readDeviceWake(deviceWakeFrame(null))).toBeNull();
    expect(readDeviceWake({ t: DEVICE_WAKE_FRAME, w: { e: "http://x" } })).toBeUndefined();
    expect(readDeviceWake({ t: "paired-wake", w: null })).toBeUndefined();
  });
});

describe("a device wake-up", () => {
  it("goes to the device's subscription with its token and the device flag, once in 30 seconds; a gone subscription says so", async () => {
    const phone = subscription();
    const target = phone.target();
    const sent: PushRequest[] = [];
    let status = 201;
    let now = 1_000_000;
    const waker = new DeviceWaker(async (request) => { sent.push(request); return status; }, () => now);
    expect(await waker.wake(PHONE, target)).toBe("sent");
    expect(JSON.parse(utf8Decode(decryptPushPayload(sent[0]!.body, phone.secret, phone.auth)))).toEqual({ wake: 1, k: target.token, d: 1 });
    expect(await waker.wake(PHONE, target)).toBe("skipped");
    now += 30_000;
    status = 410;
    expect(await waker.wake(PHONE, target)).toBe("gone");
    expect(sent).toHaveLength(2);
  });
});

// ---------- two devices' links ----------

interface TestDevice { profile: string; key: DeviceSigningKey; slot: DeviceSlot; links: DeviceLinks; wakes: [string, WakeTarget | null][] }
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
async function until(condition: () => boolean | Promise<boolean>, limit: number): Promise<boolean> {
  for (let waited = 0; waited < limit; waited += 250) { if (await condition()) return true; await run(250); }
  return condition();
}
async function makeDevice(name: string, options: Partial<DeviceLinksOptions> = {}): Promise<TestDevice> {
  const profile = `ghostly_${name.toLowerCase()}`;
  const key = await createDeviceSigningKey(profile, { forceSeed: true });
  const wakes: [string, WakeTarget | null][] = [];
  const links = new DeviceLinks({
    profile, transport: pkarr.transport(), pollIntervals: RELAY_POLL_INTERVALS, createPeerConnection: () => fakePeerConnection(name),
    onDeviceWake: (from, target) => { wakes.push([from, target]); }, ...options,
  });
  engines.push(links);
  return { profile, key, slot: { key: toBase64Url(key.publicKey), name }, links, wakes };
}
async function write(device: TestDevice, state: StoredDeviceState, d: Uint8Array, set: TestDevice[], patch: Partial<DeviceRecord> = {}): Promise<void> {
  await putDeviceRecord({
    v: 1, profile: device.profile, state, saved: 1, turn: 7, rev: 0, takeovers: 0, earlierSets: [], deviceSet: set.map((m) => m.slot), activeSlot: 0, d: toBase64Url(d),
    signingKey: device.key.kind, ownSlot: set.indexOf(device), ...patch,
  });
}

describe("device-wake between two devices", () => {
  beforeEach(async () => {
    setDeviceMirror(null); resetDeviceGates();
    await closeDevicesDb(); await closeDeviceKeysDb(); await dropDevicesDatabase(); await dropKeys();
    useFakeWorld();
    pkarr = new MemoryPkarr(DESKTOP_NETWORK);
  });
  afterEach(async () => {
    await settled(Promise.all(engines.splice(0).map((links) => links.stop())));
    await closeWorld();
    vi.useRealTimers();
  });

  it("the phone shares how to wake it on every session, a new subscription reaches the desktop under the same token, and the desktop wakes it once the link is down", async () => {
    const d = newDeviceSetSecret();
    const sent: PushRequest[] = [];
    const desktop = await makeDevice("Desktop", { pushSend: async (request) => { sent.push(request); return 201; } });
    const phone = await makeDevice("Phone");
    const first = subscription();
    await write(desktop, "active", d, [desktop, phone]);
    await write(phone, "standby", d, [desktop, phone], { push: { own: { e: first.sub.endpoint, p: first.sub.p256dh, a: first.sub.auth, vp: first.sub.vapid.publicKey, vk: first.sub.vapid.privateKey, tokens: {} } } });
    await settled(Promise.all([desktop.links.start(), phone.links.start()]));
    expect(await until(() => desktop.links.live(phone.slot.key) && phone.links.live(desktop.slot.key), 60_000)).toBe(true);
    expect(await until(() => desktop.wakes.length > 0, 10_000)).toBe(true);
    // The phone made a token for the desktop alone, and the desktop keeps the phone's target with it.
    const token = (await readDeviceRecord(phone.profile))!.push!.own!.tokens[desktop.slot.key]!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(desktop.wakes.at(-1)).toEqual([phone.slot.key, first.target(token)]);
    expect(otherTarget(await readDeviceRecord(desktop.profile), phone.slot.key)).toEqual(first.target(token));
    // The desktop has no subscription: it tells the phone so (and the phone keeps nothing for it).
    expect(await until(() => phone.wakes.length > 0, 10_000)).toBe(true);
    expect(phone.wakes.at(-1)).toEqual([desktop.slot.key, null]);
    // The phone's browser replaced its subscription: the desktop hears it now, under the same token.
    const replaced = { ...subscription("https://fcm.googleapis.com/fcm/send/phone-2").sub, vapid: first.sub.vapid };
    await settled(phone.links.setOwnPush({ endpoint: replaced.endpoint, p256dh: replaced.p256dh, auth: replaced.auth }));
    expect(await until(async () => otherTarget(await readDeviceRecord(desktop.profile), phone.slot.key)?.endpoint === replaced.endpoint, 10_000)).toBe(true);
    expect(otherTarget(await readDeviceRecord(desktop.profile), phone.slot.key)?.token).toBe(token);
    // Live: nothing is posted, the link carries the handoff itself.
    expect(await settled(desktop.links.wake(phone.slot.key))).toBe("none");
    expect(sent).toEqual([]);
    // The phone suspends the app: its link goes down, and a handoff asked of it posts one wake-up to its subscription.
    const stopping = engines.splice(engines.indexOf(phone.links), 1);
    await settled(Promise.all(stopping.map((links) => links.stop())));
    expect(await until(() => !desktop.links.live(phone.slot.key), 120_000)).toBe(true);
    expect(await settled(desktop.links.wake(phone.slot.key))).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(replaced.endpoint);
    expect(await settled(desktop.links.wake(phone.slot.key))).toBe("skipped");
  });

  it("the active device asks the standby for a new subscription and tells it the chats' tokens; a standby is not heard asking", async () => {
    const d = newDeviceSetSecret();
    const desktop = await makeDevice("Desktop"), phone = await makeDevice("Phone");
    const own = subscription();
    await write(desktop, "active", d, [desktop, phone]);
    await write(phone, "standby", d, [desktop, phone], { push: { own: { e: own.sub.endpoint, p: own.sub.p256dh, a: own.sub.auth, vp: own.sub.vapid.publicKey, vk: own.sub.vapid.privateKey, tokens: {} } } });
    await settled(Promise.all([desktop.links.start(), phone.links.start()]));
    expect(await until(() => desktop.links.live(phone.slot.key) && phone.links.live(desktop.slot.key), 60_000)).toBe(true);
    expect(desktop.links.askRenew(phone.slot.key)).toBe(true);
    expect(desktop.links.sendTokens(phone.slot.key, ["c".repeat(22)])).toBe(true);
    expect(await until(async () => (await readDeviceRecord(phone.profile))?.push?.renew === true, 10_000)).toBe(true);
    expect(await until(async () => JSON.stringify((await readDeviceRecord(phone.profile))?.push?.allowed) === JSON.stringify(["c".repeat(22)]), 10_000)).toBe(true);
    // What the standby page reads: the renewal asked.
    expect(await settled(phone.links.call("devicePushState", null))).toEqual({ endpoint: own.sub.endpoint, vapidPublic: own.sub.vapid.publicKey, renew: true });
    // The other way round: a standby asks nothing of the active device.
    await write(desktop, "active", d, [desktop, phone], { push: { own: { e: own.sub.endpoint, p: own.sub.p256dh, a: own.sub.auth, vp: own.sub.vapid.publicKey, vk: own.sub.vapid.privateKey, tokens: {} } } });
    expect(phone.links.askRenew(desktop.slot.key)).toBe(true);
    phone.links.sendTokens(desktop.slot.key, ["e".repeat(22)]);
    await run(2_000);
    expect((await readDeviceRecord(desktop.profile))?.push).toMatchObject({ own: { e: own.sub.endpoint } });
    expect((await readDeviceRecord(desktop.profile))?.push?.renew).toBeUndefined();
    expect((await readDeviceRecord(desktop.profile))?.push?.allowed).toBeUndefined();
    // The renewal, with a new key pair: the record follows and the request is done.
    const fresh = subscription("https://fcm.googleapis.com/fcm/send/phone-renewed");
    await settled(phone.links.call("devicePushSet", { subscription: { endpoint: fresh.sub.endpoint, p256dh: fresh.sub.p256dh, auth: fresh.sub.auth, vapid: fresh.sub.vapid } }));
    const after = (await readDeviceRecord(phone.profile))!.push!;
    expect(after.own).toMatchObject({ e: fresh.sub.endpoint, vp: fresh.sub.vapid.publicKey });
    expect(after.renew).toBeUndefined();
    await expect(phone.links.call("devicePushSet", { subscription: { endpoint: fresh.sub.endpoint, p256dh: fresh.sub.p256dh, auth: fresh.sub.auth, vapid: { publicKey: fresh.sub.vapid.publicKey, privateKey: generateVapidKeys().privateKey } } })).rejects.toThrow(/not a pair/);
  });

  it("a device-wake from a device the set does not list is not kept", async () => {
    const d = newDeviceSetSecret();
    const desktop = await makeDevice("Desktop");
    await write(desktop, "active", d, [desktop]);
    // Straight into the handler, as a link would hand it: the sender is no device of this set.
    const receive = (desktop.links as unknown as { deviceWake(from: string, frame: unknown): Promise<void> }).deviceWake.bind(desktop.links);
    await settled(receive(PHONE, deviceWakeFrame(subscription().target())));
    expect((await readDeviceRecord(desktop.profile))!.push).toBeUndefined();
  });
});
