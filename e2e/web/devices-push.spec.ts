import type { BrowserContext, CDPSession, Page } from "@playwright/test";
import { p256 } from "@noble/curves/nist.js";
import { toBase64Url } from "@ghostly/core";
import { expect, test } from "../support/fixtures";

/**
 * Push and the phone (WISP 06 § Push and the phone), in the real push worker: it reads the device state itself, from
 * the `ghostly-devices` database, when a push arrives. On a device that is not the active one a message and a call show
 * the quiet "Active on <device>" notices and never ring; a wake-up from another of the person's devices names it, only
 * for a token this device gave one of its own; on the active device the notices are today's. The push service is stood
 * in for as in wake-push.spec.ts (a headless Chromium has none), and the device record is written as enrollment would.
 */
const deployed = !!process.env.E2E_WEB_URL;
// Chromium's headless shell refuses notifications outright; the full browser in its headless mode shows them.
test.use({ channel: "chromium" });
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/phone";
const MACBOOK = "M".repeat(43), PHONE = "P".repeat(43);
const DEVICE_TOKEN = "devicetokenaaaaaaaaaaa", UNKNOWN_TOKEN = "chatmadeonthemacbookaa";

/** A `PushManager` that subscribes to the stand-in: the rest of the Push API is the browser's own. */
async function standInPushManager(context: BrowserContext): Promise<void> {
  const p256dh = toBase64Url(p256.getPublicKey(p256.utils.randomSecretKey(), false));
  const auth = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  await context.addInitScript(({ endpoint, p256dh, auth }) => {
    const bytes = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)).buffer;
    const KEY = "qa-push-subscribed";
    const subscription = () => ({
      endpoint, expirationTime: null, options: { userVisibleOnly: true },
      getKey: (name: string) => (name === "p256dh" ? bytes(p256dh) : name === "auth" ? bytes(auth) : null),
      unsubscribe: async () => { localStorage.removeItem(KEY); return true; },
      toJSON: () => ({ endpoint, keys: { p256dh, auth } }),
    });
    PushManager.prototype.subscribe = async function () { localStorage.setItem(KEY, "1"); return subscription() as unknown as PushSubscription; };
    PushManager.prototype.getSubscription = async function () { return (localStorage.getItem(KEY) ? subscription() : null) as unknown as PushSubscription; };
  }, { endpoint: ENDPOINT, p256dh, auth });
}

interface Shown { title: string; body: string; tag: string; silent: boolean | null; requireInteraction: boolean; path: string }

/** A page of the origin that is not the app (the app on screen would show nothing): to deliver pushes and look at notifications. */
async function workerConsole(context: BrowserContext): Promise<{ page: Page; deliver(text: string): Promise<void>; shown(): Promise<Shown[]>; clear(): Promise<void> }> {
  const page = await context.newPage();
  await page.goto("/manifest.json");
  const cdp: CDPSession = await context.newCDPSession(page);
  const registrations = new Map<string, string>();
  cdp.on("ServiceWorker.workerRegistrationUpdated", ({ registrations: list }) => {
    for (const r of list as { registrationId: string; scopeURL: string; isDeleted: boolean }[]) if (!r.isDeleted) registrations.set(r.scopeURL, r.registrationId);
  });
  await cdp.send("ServiceWorker.enable");
  const origin = new URL(page.url()).origin;
  return {
    page,
    async deliver(text) {
      await expect.poll(() => registrations.get(`${origin}/push/default/`)).toBeTruthy();
      await cdp.send("ServiceWorker.deliverPushMessage", { origin, registrationId: registrations.get(`${origin}/push/default/`)!, data: text });
    },
    shown: () => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration("/push/default/");
      return (await registration!.getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, silent: n.silent, requireInteraction: n.requireInteraction, path: (n.data as { path: string }).path }));
    }),
    clear: () => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration("/push/default/");
      for (const n of await registration!.getNotifications()) n.close();
    }),
  };
}

/** Writes this profile's device record as enrollment and the device links would: the phone, with the MacBook active or itself. */
const writeRecord = (page: Page, state: "standby" | "active") => page.evaluate(({ state, MACBOOK, PHONE, DEVICE_TOKEN }) => new Promise<void>((resolve, reject) => {
  const open = indexedDB.open("ghostly-devices", 1);
  open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains("devices")) open.result.createObjectStore("devices", { keyPath: "profile" }); };
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const tx = open.result.transaction("devices", "readwrite");
    tx.objectStore("devices").put({
      v: 1, profile: "ghostly", state, saved: 1, turn: 9, rev: 0, takeovers: 0, earlierSets: [],
      deviceSet: [{ key: MACBOOK, name: "MacBook" }, { key: PHONE, name: "Phone" }, null, null], activeSlot: state === "active" ? 1 : 0, ownSlot: 1,
      push: { own: { e: "https://fcm.googleapis.com/fcm/send/phone", p: "p", a: "a", vp: "v", vk: "k", tokens: { [MACBOOK]: DEVICE_TOKEN } } },
    });
    tx.oncomplete = () => { open.result.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  };
}), { state, MACBOOK, PHONE, DEVICE_TOKEN });

/** The worker's table, as the app wrote it. */
const wakeTable = (page: Page) => page.evaluate(() => new Promise<{ tokens: { token: string; path: string }[]; text: { db?: string; standby?: string } | undefined }>((resolve, reject) => {
  const open = indexedDB.open("ghostly-wake");
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const tx = open.result.transaction(["tokens", "text"]);
    const tokens = tx.objectStore("tokens").getAll();
    const text = tx.objectStore("text").get("");
    tx.oncomplete = () => { resolve({ tokens: tokens.result, text: text.result }); open.result.close(); };
  };
}));

test("a device that is not the active one never rings: quiet Active on <device> notices; a wake-up names the device that asks", { tag: ["@feature:devices.push", "@feature:devices.push.wake"] }, async ({ peer }) => {
  test.skip(deployed, "the push service stand-in needs the test's own build");
  test.setTimeout(4 * 60_000);
  const phone = await peer("phone", { serviceWorkers: "allow" });
  await phone.context.grantPermissions(["notifications"], { origin: new URL(phone.page.url()).origin });
  await standInPushManager(phone.context);
  await phone.page.reload();
  await expect(phone.page.getByTitle("New Chat")).toBeVisible();

  // Wake-ups on: the push worker is registered, and the app writes its words and where the device state is.
  await phone.page.goto("/#/settings");
  await phone.page.getByTestId("settings-wake").click();
  await expect(phone.page.getByTestId("settings-wake")).toBeChecked();
  await expect.poll(async () => (await wakeTable(phone.page)).text?.db).toBe("ghostly");
  expect((await wakeTable(phone.page)).text?.standby).toBe("New message. Active on {device}.");

  // The MacBook took the profile: this device is a standby. The app is closed (on screen, nothing would show).
  await writeRecord(phone.page, "standby");
  await phone.page.close();
  const worker = await workerConsole(phone.context);

  // A message from a chat this device never knew (made on the MacBook): the quiet notice, naming the active device.
  await worker.deliver(JSON.stringify({ wake: 1, k: UNKNOWN_TOKEN }));
  await expect.poll(() => worker.shown()).toEqual([{ title: "Ghostly", body: "New message. Active on MacBook.", tag: "standby:", silent: true, requireInteraction: false, path: "/" }]);
  // A call: no ring, nothing that stays up.
  await worker.clear();
  await worker.deliver(JSON.stringify({ wake: 1, k: UNKNOWN_TOKEN, c: 1 }));
  await expect.poll(() => worker.shown()).toEqual([{ title: "Ghostly", body: "Call for you. Active on MacBook.", tag: "standby:", silent: true, requireInteraction: false, path: "/" }]);
  // The MacBook asks for a handoff with the token this device gave it.
  await worker.clear();
  await worker.deliver(JSON.stringify({ wake: 1, k: DEVICE_TOKEN, d: 1 }));
  await expect.poll(async () => (await worker.shown()).map((n) => n.body)).toEqual(["MacBook wants to move this profile here. Open Ghostly."]);
  // The device flag on a token no device of this one holds proves nothing: nothing new shows.
  await worker.clear();
  await worker.deliver(JSON.stringify({ wake: 1, k: UNKNOWN_TOKEN, d: 1 }));
  await worker.page.waitForTimeout(1_500);
  expect(await worker.shown()).toEqual([]);

  // Active again: a wake-up from the MacBook says it wants to take over. The same token again within 30 seconds would
  // only show the notice on screen again, silently (the worker's own limit, as for a call).
  await writeRecord(worker.page, "active");
  await worker.page.waitForTimeout(31_000);
  await worker.deliver(JSON.stringify({ wake: 1, k: DEVICE_TOKEN, d: 1 }));
  await expect.poll(async () => (await worker.shown()).map((n) => [n.body, n.silent])).toEqual([["MacBook wants to take over. Open Ghostly.", false]]);
});
