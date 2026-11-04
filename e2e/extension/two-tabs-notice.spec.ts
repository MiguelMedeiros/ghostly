import type { Page } from "@playwright/test";
import { chat } from "../support/fixtures";
import { expect, test } from "../support/extension";
import { pair } from "../support/paired";

/** The extension's notifications, as granted: what each page posts is kept on it (`__notes`). */
const grantNotifications = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __notes: string[]; chrome: object };
  w.__notes = [];
  Object.defineProperty(w.chrome, "permissions", { configurable: true, value: { contains: async () => true, request: async () => true } });
  Object.defineProperty(w.chrome, "notifications", {
    configurable: true,
    value: { create: async (id: string, options: { message: string }) => { w.__notes.push(options.message); return id; }, clear: async () => true, onClicked: { addListener() {} } },
  });
});
const notes = (page: Page) => page.evaluate(() => (window as unknown as { __notes: string[] }).__notes);
/** The tab goes behind another, as the browser says of a background tab (headless Chromium calls every tab in front). */
const sendBehind = (page: Page) => page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  document.hasFocus = () => false;
  document.dispatchEvent(new Event("visibilitychange"));
});

/**
 * A call rings in every tab of the extension, which share one peer. A tab in the background posted "Incoming call" as a
 * system notification while the person had the call ringing in the tab in front of them. It posts nothing now while
 * another tab is in sight, and with none in sight, one of the two tabs posts it (each posted its own).
 */
test("a call ringing in two tabs is one notification, and none while one of them is in sight", { tag: ["@client:extension", "@client:web", "@feature:extension.engine", "@feature:calls.ring-elsewhere", "@feature:app.attention.notifications"] }, async ({ extensionPeer, webPeer }) => {
  const [ext, web] = await Promise.all([extensionPeer("two-tabs-notice"), webPeer("two-tabs-notice-contact")]);
  await pair(web, ext);
  await ext.page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    settings.notifications = { ...settings.notifications, systemEnabled: true };
    localStorage.setItem("ghostly_app_settings", JSON.stringify(settings));
  });
  await ext.page.reload();
  await expect(chat(ext)).toBeVisible({ timeout: 30_000 });
  const second = { ...ext, page: await ext.context.newPage() };
  await second.page.goto(ext.page.url());
  await expect(chat(second)).toBeVisible({ timeout: 30_000 });
  for (const tab of [ext, second]) await grantNotifications(tab.page);
  await sendBehind(second.page);

  await web.page.getByTestId("call-audio").click();
  for (const tab of [ext, second]) await expect(tab.page.getByText("Incoming audio call...")).toBeVisible({ timeout: 30_000 });
  // Long enough for the notification the background tab used to post at once.
  await second.page.waitForTimeout(2_000);
  expect(await notes(second.page)).toEqual([]);
  expect(await notes(ext.page)).toEqual([]);

  // The tab in front goes behind too: now nothing of the app is in sight, and the call says so, once for both tabs.
  await sendBehind(ext.page);
  const both = async () => [...await notes(ext.page), ...await notes(second.page)];
  await expect.poll(both, { timeout: 10_000 }).toContain("Incoming call");
  await second.page.waitForTimeout(2_000);
  expect(await both()).toEqual(["Incoming call"]);

  // The caller gives up and calls again while both tabs are behind: both ring, and the new call is one notification more.
  await web.page.getByTitle("End call").click();
  for (const tab of [ext, second]) await expect(tab.page.getByText("Incoming audio call...")).toHaveCount(0, { timeout: 15_000 });
  await web.page.getByTestId("call-audio").click();
  for (const tab of [ext, second]) await expect(tab.page.getByText("Incoming audio call...")).toBeVisible({ timeout: 30_000 });
  await expect.poll(both, { timeout: 10_000 }).toHaveLength(2);
  await second.page.waitForTimeout(2_000);
  expect(await both()).toEqual(["Incoming call", "Incoming call"]);
});
