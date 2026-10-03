import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { DEVICE_NOTICE_DEFAULTS, pushNotice, type NoticeDevice } from "../../../../web/src/sw/policy";
import { pushDeviceView, readPushDeviceView } from "../../../../web/src/sw/deviceState";
import { readWakeEntry, readWakeText, writeWakeEntries, writeWakeText } from "../../../../web/src/sw/wakeStore";

// covers: devices.push, devices.push.wake

/*
 * What the push worker shows in a profile on several devices (WISP 06 § Push and the phone), the rules of
 * `apps/web/src/sw/policy.ts` and the worker's own read of the device state (`deviceState.ts`): a device that is not the
 * active one never rings and never shows a message, and a wake-up from another of the person's devices names it, only
 * for a token this device gave one of its own.
 */

const now = 1_800_000_000_000;
const TOKEN = "t".repeat(22), DEVICE_TOKEN = "d".repeat(22);
const chat = { entry: { path: "/chat/abc" }, text: { title: "Ghostly", body: "New message", call: "Incoming call" } };
const standby: NoticeDevice = { state: "standby", active: "MacBook", tokens: { [DEVICE_TOKEN]: "MacBook" } };
const active: NoticeDevice = { state: "active", tokens: { [DEVICE_TOKEN]: "Phone" } };
const options = { now, appVisible: false, profile: "" };

describe("a push on a device that is not the active one", () => {
  it("a message and a call show the quiet standby notice, naming the active device, and open the standby screen", () => {
    const message = pushNotice({ token: TOKEN, kind: "message" }, chat, standby, options);
    expect(message).toEqual({ title: "Ghostly", body: "New message. Active on MacBook.", tag: "standby:", call: false, quiet: true, data: { path: "/", profile: "" } });
    const call = pushNotice({ token: TOKEN, kind: "call" }, chat, standby, options);
    expect(call).toMatchObject({ body: "Call for you. Active on MacBook.", call: false, quiet: true });
  });

  it("in the app's language when a page wrote its words, and without a name when the record names no other device", () => {
    const text = { title: "Ghostly", standby: "Nova mensagem. Ativo em {device}.", standbyCallUnnamed: "Chamada para você. Abra o Ghostly no seu dispositivo ativo." };
    expect(pushNotice({ token: TOKEN, kind: "message" }, chat, standby, { ...options, text })!.body).toBe("Nova mensagem. Ativo em MacBook.");
    expect(pushNotice({ token: TOKEN, kind: "call" }, chat, { state: "moving", tokens: {} }, { ...options, text })!.body).toBe("Chamada para você. Abra o Ghostly no seu dispositivo ativo.");
    expect(pushNotice({ token: TOKEN, kind: "message" }, undefined, { state: "superseded", tokens: {} }, options)!.body).toBe(DEVICE_NOTICE_DEFAULTS.standbyUnnamed);
  });

  it("a token this device never knew still shows it (a chat made on the active device); a muted chat, a removed device or an open app shows nothing", () => {
    expect(pushNotice({ token: TOKEN, kind: "message" }, undefined, standby, options)).toMatchObject({ quiet: true });
    expect(pushNotice({ token: TOKEN, kind: "message" }, { ...chat, entry: { path: "/chat/abc", mutedUntil: "forever" } }, standby, options)).toBeNull();
    expect(pushNotice({ token: TOKEN, kind: "message" }, { ...chat, entry: { path: "/chat/abc", mutedUntil: now + 1 } }, standby, options)).toBeNull();
    expect(pushNotice({ token: TOKEN, kind: "message" }, chat, { state: "removed", tokens: {} }, options)).toBeNull();
    expect(pushNotice({ token: TOKEN, kind: "message" }, chat, standby, { ...options, appVisible: true })).toBeNull();
  });

  it("a state that cannot be read is no license to ring: quiet too", () => {
    expect(pushNotice({ token: TOKEN, kind: "call" }, chat, { state: "unreadable", tokens: {} }, options)).toMatchObject({ quiet: true, call: false });
  });
});

describe("a push on the active device, or in a profile on one device", () => {
  it("shows today's notices, ringing for a call", () => {
    expect(pushNotice({ token: TOKEN, kind: "call" }, chat, active, options)).toMatchObject({ body: "Incoming call", call: true });
    expect(pushNotice({ token: TOKEN, kind: "call" }, chat, null, options)).toMatchObject({ body: "Incoming call", call: true });
    expect(pushNotice({ token: TOKEN, kind: "message" }, undefined, null, options)).toBeNull();
    expect(pushNotice({ token: TOKEN, kind: "message" }, chat, active, options)!.quiet).toBeUndefined();
  });
});

describe("a wake-up from another of the person's devices", () => {
  it("names the device whose token it carries: take over where this one is active, move here where it is not", () => {
    expect(pushNotice({ token: DEVICE_TOKEN, kind: "device" }, undefined, active, options)).toEqual({ title: "Ghostly", body: "Phone wants to take over. Open Ghostly.", tag: "device:", call: false, data: { path: "/", profile: "" } });
    expect(pushNotice({ token: DEVICE_TOKEN, kind: "device" }, undefined, standby, options)!.body).toBe("MacBook wants to move this profile here. Open Ghostly.");
  });

  it("shows nothing for a token no device of this one holds, a contact's chat token included, nor in a profile on one device", () => {
    expect(pushNotice({ token: TOKEN, kind: "device" }, chat, active, options)).toBeNull();
    expect(pushNotice({ token: DEVICE_TOKEN, kind: "device" }, undefined, null, options)).toBeNull();
    expect(pushNotice({ token: DEVICE_TOKEN, kind: "device" }, undefined, active, { ...options, appVisible: true })).toBeNull();
  });
});

describe("the worker's read of the device state", () => {
  const record = {
    v: 1, profile: "ghostly_abc", state: "standby", saved: 3, turn: 4, rev: 0, takeovers: 0, earlierSets: [], activeSlot: 0, ownSlot: 1,
    deviceSet: [{ key: "K".repeat(43), name: "MacBook" }, { key: "P".repeat(43), name: "Phone" }, null, null],
    push: { own: { e: "https://fcm.googleapis.com/x", p: "p", a: "a", vp: "v", vk: "k", tokens: { ["K".repeat(43)]: DEVICE_TOKEN, ["G".repeat(43)]: "g".repeat(22) } } },
  };

  it("takes out the state, the active device's name and whose each token is; a token of a device the set no longer lists names nobody", () => {
    expect(pushDeviceView(record)).toEqual({ state: "standby", active: "MacBook", tokens: { [DEVICE_TOKEN]: "MacBook" } });
    expect(pushDeviceView({ ...record, state: "active", activeSlot: 1 })).toEqual({ state: "active", tokens: { [DEVICE_TOKEN]: "MacBook" } });
    expect(pushDeviceView(undefined)).toBeNull();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => { const r = indexedDB.deleteDatabase("ghostly-devices"); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
  });

  it("never makes the database: none there is a profile on one device", async () => {
    expect(await readPushDeviceView("ghostly_abc")).toBeNull();
    expect((await indexedDB.databases()).map((db) => db.name)).not.toContain("ghostly-devices");
    expect(await readPushDeviceView(undefined)).toBeNull();
  });

  it("reads the profile's record by its database's name", async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("ghostly-devices", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("devices", { keyPath: "profile" });
      request.onsuccess = () => { const tx = request.result.transaction("devices", "readwrite"); tx.objectStore("devices").put(record); tx.oncomplete = () => { request.result.close(); resolve(); }; };
      request.onerror = () => reject(request.error);
    });
    expect(await readPushDeviceView("ghostly_abc")).toEqual({ state: "standby", active: "MacBook", tokens: { [DEVICE_TOKEN]: "MacBook" } });
    // Another profile of this browser has no record: on one device.
    expect(await readPushDeviceView("ghostly_other")).toBeNull();
  });
});

describe("the words a standby's page writes", () => {
  it("leave the chats' tokens as the active page wrote them", async () => {
    await writeWakeEntries("p1", [{ token: TOKEN, path: "/chat/abc" }], { title: "Ghostly", body: "New message" });
    await writeWakeText("p1", { title: "Ghostly", body: "Nova mensagem", standby: "Nova mensagem. Ativo em {device}.", db: "ghostly_p1" });
    expect((await readWakeEntry("p1", TOKEN))?.entry).toEqual({ token: TOKEN, path: "/chat/abc" });
    expect(await readWakeText("p1")).toMatchObject({ db: "ghostly_p1", standby: "Nova mensagem. Ativo em {device}." });
  });
});
