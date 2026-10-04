import type { BrowserContext, Page } from "@playwright/test";
import { chat, delivered, expect, link, say, test } from "../support/fixtures";
import { LocalRelay } from "../support/relay";

/**
 * One profile on several devices, one active at a time (WISP 06 § The gate). The device state is read before the
 * engine starts. Nothing can enroll a device yet, so every real profile is `single`; here a state is written directly,
 * as enrollment and the handoff will write it, and the app is opened on it.
 */

/** Every `indexedDB.open` of the page, by name, from before any of the app's scripts run. */
async function recordOpens(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const opened: string[] = [];
    (window as unknown as { __opened: string[] }).__opened = opened;
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (name: string, version?: number) => { opened.push(name); return open(name, version); };
  });
}
/** Without the probe the web app's own browser check makes (`ghostly-boot-check`, apps/ui/src/lib/bootCheck.ts). */
const opens = (page: Page) => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened.filter((name) => name !== "ghostly-boot-check"));

/** Writes (or, with null, removes) the device record of the first profile, from a page of the origin that is not the app. */
async function setDeviceState(page: Page, state: "standby" | null): Promise<void> {
  await page.goto("/manifest.json");
  await page.evaluate(async (wanted) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("ghostly-devices", 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains("devices")) request.result.createObjectStore("devices", { keyPath: "profile" }); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("devices", "readwrite", { durability: "strict" });
      const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      if (wanted) tx.objectStore("devices").put({ v: 1, profile: "ghostly", state: wanted, saved: 1, turn: 7, rev: 0, deviceSet: [{ key, name: "MacBook" }, { key, name: "This browser" }], activeSlot: 0, ownSlot: 1, takeovers: 0, earlierSets: [], turnPacket: key });
      else tx.objectStore("devices").delete("ghostly");
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, state);
}

/** What the profile keeps in this browser's local storage: its sessions, settings and keys. */
const profileStorage = (page: Page) => page.evaluate(() => JSON.stringify(Object.entries(localStorage).filter(([key]) => key.startsWith("ghostly_")).sort()));

/** The profile's storage once it has stopped changing (a receipt or a read mark can still land just after a message shows). */
async function settledStorage(page: Page): Promise<string> {
  // Unchanged for 3 s in a row (a receipt usually lands within a second or two of the message showing).
  let last = await profileStorage(page);
  let still = 0;
  for (let i = 0; i < 40 && still < 6; i++) {
    await page.waitForTimeout(500);
    const now = await profileStorage(page);
    still = now === last ? still + 1 : 0;
    last = now;
  }
  return last;
}

test("a profile on standby on this device opens no peer database, asks no relay and shows the standby screen; active again, it is as it was", { tag: ["@feature:devices.gate", "@feature:devices.standby-screen"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await say(alice, "before the move");
  await expect(chat(bob).getByText("before the move")).toBeVisible();
  const { page } = alice;

  // Another device took the profile: this one is written `standby`, and reloads into the gate.
  await recordOpens(alice.context);
  // The contact's receipt for that message can land a moment after it shows: snapshot once nothing moves.
  const kept = await settledStorage(page);
  await setDeviceState(page, "standby");
  const asked: string[] = [];
  const count = (request: { url(): string }) => { if (LocalRelay.pattern.test(request.url())) asked.push(request.url()); };
  alice.context.on("request", count);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/");
  const standby = page.getByTestId("device-standby");
  await expect(standby).toBeVisible();
  await expect(standby).toHaveAttribute("data-state", "standby");
  await expect(page.getByTestId("device-standby-title")).toHaveText("Active on MacBook");
  await expect(standby).toContainText("This device is on standby for this profile.");
  // Nothing of the profile is on screen, though its chats are still stored here.
  await expect(page.getByTestId("sidebar")).toHaveCount(0);
  await expect(page.getByTestId("chat-row")).toHaveCount(0);
  await expect(page.getByPlaceholder("Message…")).toHaveCount(0);
  await standby.getByTestId("device-standby-info").click();
  await expect(standby.getByTestId("device-standby-text")).toContainText("Only one device sends, receives and pays at a time");

  // A page of the app, and an invite link, show the same and are not taken in.
  await page.goto("/#/wallet");
  await expect(standby).toBeVisible();
  await expect(page.getByTestId("sidebar")).toHaveCount(0);

  // Several poll intervals: an engine that started would have published and polled at once. A contact's message
  // stays with the contact.
  await say(bob, "while on standby");
  await page.waitForTimeout(6_000);
  expect(asked).toEqual([]);
  expect(errors).toEqual([]);
  // The peer database was never opened: only the device state was read, and the words the push worker shows on this
  // device were written beside it, in a database of the push worker's own (WISP 06 § Push and the phone).
  expect((await opens(page)).filter((name) => name !== "ghostly-wake")).toEqual(["ghostly-devices"]);
  // And nothing was written into the copy this device keeps.
  expect(await profileStorage(page)).toBe(kept);
  alice.context.off("request", count);

  // The profile comes back to this device (here: the record is taken away, so it is `single` again): everything is
  // as it was, the chat is there, and it talks to its contact.
  await setDeviceState(page, null);
  await page.goto("/");
  await expect(page.getByTestId("device-standby")).toHaveCount(0);
  await expect(page.getByTestId("sidebar").getByTestId("chat-row").first()).toBeVisible();
  await page.getByTestId("sidebar").getByTestId("chat-row").first().click();
  await expect(chat(alice).getByText("before the move")).toBeVisible();
  await say(alice, "back again");
  await expect(chat(bob).getByText("back again")).toBeVisible();
  await expect(delivered(chat(alice).locator("[data-message]", { hasText: "back again" }).last()).or(chat(alice).getByText("back again"))).toBeVisible();
});

test("a profile with no device set starts as before: no device state database is made or opened for it", { tag: ["@feature:devices.gate"] }, async ({ peer }) => {
  const alice = await peer("alice", { beforeOpen: recordOpens });
  const { page } = alice;
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await expect(page.getByTestId("device-standby")).toHaveCount(0);
  await expect.poll(async () => (await opens(page)).includes("ghostly")).toBe(true);
  // Nothing was ever enrolled on this device: the gate learns that without opening anything, and nothing is left behind.
  expect(await opens(page)).not.toContain("ghostly-devices");
  expect(await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))).not.toContain("ghostly-devices");
});
