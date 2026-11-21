import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test, chat, connect, link, say } from "../support/fixtures";
import { DEVICE_SET_PASSWORD, enrollDevice, untilShown } from "../support/devices";

/**
 * "Remove this profile here" (WISP 06 § User experience). A device that held the profile, gave it to another and was
 * then removed keeps a frozen copy, not encrypted. Its removed screen takes that copy off it, after the profile's name
 * is typed: here its first profile, the one a device that joined on first run holds the set in. Nothing of the chat is
 * left in any database or key of this origin, and the device opens again on an empty profile, ready to be added again.
 */

/** The stores of every IndexedDB database, and the localStorage keys, that hold `marker`. */
const holding = (page: Page, marker: string) => page.evaluate(async (marker) => {
  const found: string[] = [];
  for (const { name } of await indexedDB.databases()) {
    if (!name) continue;
    const db = await new Promise<IDBDatabase | null>((resolve) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(null); r.onupgradeneeded = () => { r.transaction?.abort(); resolve(null); }; });
    if (!db) continue;
    for (const store of Array.from(db.objectStoreNames)) {
      const values = await new Promise<unknown[]>((resolve) => { const r = db.transaction(store, "readonly").objectStore(store).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => resolve([]); });
      if (values.some((value) => { try { return JSON.stringify(value).includes(marker); } catch { return false; } })) found.push(`${name}/${store}`);
    }
    db.close();
  }
  for (const [key, value] of Object.entries(localStorage)) if (value.includes(marker)) found.push(`localStorage:${key}`);
  return found;
}, marker);

test("a removed device takes its copy of the profile off itself, the first profile's included", { tag: ["@feature:devices.remove"] }, async ({ peer }) => {
  test.setTimeout(12 * 60_000);
  const marker = `removehere${randomBytes(6).toString("hex")}`;
  const [desktop, phone, contact] = await Promise.all([peer("desktop"), peer("phone"), peer("contact")]);

  // The desktop's first profile has a chat; the phone joins it, takes the profile with Use here, and removes the desktop.
  await link(desktop, contact);
  await connect(desktop, contact);
  await say(desktop, `${marker} from the desktop`);
  await expect(chat(contact).getByText(`${marker} from the desktop`)).toBeVisible({ timeout: 120_000 });
  await enrollDevice(desktop, phone);
  await phone.page.getByTestId("handoff-use-here").click();
  await phone.page.getByTestId("handoff-password").fill(DEVICE_SET_PASSWORD);
  await phone.page.getByTestId("handoff-start").click();
  await untilShown(phone.page, phone.page.getByTitle("New Chat"), { timeout: 300_000 });
  await untilShown(desktop.page, desktop.page.getByTestId("device-standby").and(desktop.page.locator("[data-state=standby]")));
  await phone.page.goto("/#/profile");
  await phone.page.getByTestId("device-row").filter({ hasNotText: "Phone" }).first().getByTestId("device-menu").click();
  await phone.page.getByTestId("device-remove-open").click();
  await phone.page.getByTestId("device-remove").getByTestId("device-remove-go").click();
  await expect(phone.page.getByTestId("device-removed")).toContainText("Removed", { timeout: 60_000 });

  // The desktop, removed: its frozen copy holds the chat in the clear.
  await desktop.page.reload();
  await untilShown(desktop.page, desktop.page.getByTestId("device-standby").and(desktop.page.locator("[data-state=removed]")), { timeout: 180_000 });
  expect(await holding(desktop.page, marker)).toContain("ghostly/messages");

  // Remove this profile here, with the profile's name typed.
  await desktop.page.getByTestId("device-standby-remove-here").click();
  const dialog = desktop.page.getByTestId("device-remove-here");
  await expect(dialog).toContainText("Remove Personal from this device?");
  await expect(dialog.getByTestId("device-remove-here-go")).toBeDisabled();
  await dialog.getByTestId("device-remove-here-name").fill("Personal");
  await dialog.getByTestId("device-remove-here-go").click();

  // It opens again on an empty first profile, from which it can be added to a profile again.
  await expect(desktop.page.getByTestId("home-already")).toBeVisible({ timeout: 120_000 });
  await expect(desktop.page.getByTestId("device-standby")).toHaveCount(0);
  expect(await holding(desktop.page, marker), "nothing of the copy is left on this device").toEqual([]);
  const profiles = await desktop.page.evaluate(() => JSON.parse(localStorage.getItem("ghostly_profiles") ?? "null") as { profiles: { id: string }[] } | null);
  expect(profiles?.profiles.map((p) => p.id) ?? [""]).toEqual([""]);
  // The phone keeps the profile and its chat.
  await phone.page.goto("/#/");
  await phone.page.getByTestId("sidebar").getByTestId("chat-row").first().click();
  await expect(chat(phone).getByText(`${marker} from the desktop`)).toBeVisible({ timeout: 60_000 });
});
