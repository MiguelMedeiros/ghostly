import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { forgetSharedData, openMacDesktop, type MacDesktop } from "../support/desktopMac";

/**
 * System notifications in the Desktop app on a Mac (#315). macOS gives no notifications to an app in a temporary
 * folder: Launch Services marks it `in-temp-dir`, and the request fails without a dialog. Settings said "Not
 * available here". That is where macOS runs a downloaded app opened before it was moved (App Translocation), and
 * where a copy made for testing often lives. Now Settings says to move the app; from any other folder the switch
 * is offered, and a notification call is answered (without the permission it shows nothing).
 *
 * Nothing here asks macOS for the permission: that opens a dialog for the person at the Mac. How Settings shows a
 * refusal is in src/test/app/systemNotifications.test.tsx (the page cannot fake one here: Tauri's `invoke` cannot
 * be redefined). The banner itself, and a click on it opening its chat, are checked by hand.
 *
 *   npm run desktop:macos:build
 *   npm run test:e2e:desktop-macos -- notifications
 */

// 49720-49729: this test's ports.
const PORTS = { temporary: 49720, placed: 49721 };
/** Not a temporary folder: where the second copy goes (git ignores it). */
const PLACED = fileURLToPath(new URL("../../test-results/desktop-macos-apps", import.meta.url));

const row = '[data-testid="settings-system-notifications-row"]';
const toggle = '[data-testid="settings-system-notifications"]';

/** What a native command answers, or "threw: …". */
const invoke = <T,>(desktop: MacDesktop, command: string, args: object) => desktop.app.executeAsync<T | string>(
  `const [command, args, done] = arguments;
   window.__TAURI_INTERNALS__.invoke(command, args).then(done, (e) => done("threw: " + e));`,
  command, args,
);

const opened: MacDesktop[] = [];
test.beforeAll(() => {
  test.skip(process.platform !== "darwin", "macOS only");
  forgetSharedData();
});
test.afterAll(async () => {
  for (const desktop of opened) await desktop.stop();
  forgetSharedData();
});

test("from a temporary folder Settings says to move the app; from another the switch is offered", {
  tag: ["@client:desktop", "@feature:desktop.notifications", "@feature:app.attention.notifications"],
}, async () => {
  const temporary = await openMacDesktop({ name: "notices-tmp", port: PORTS.temporary });
  opened.push(temporary);
  await temporary.app.execute(`location.hash = "#/settings";`);
  await expect.poll(() => temporary.app.text(row)).toContain("Move Ghostly to Applications to allow them");
  expect(await invoke(temporary, "native_notification_permission", { request: true })).toBe("misplaced");
  // Answered, and nothing shown.
  expect(await invoke(temporary, "native_private_notification", { id: "e2e-1", body: "New message" })).toBe(true);
  await temporary.stop();
  opened.pop();

  const placed = await openMacDesktop({ name: "notices", port: PORTS.placed, folder: PLACED });
  opened.push(placed);
  const { app } = placed;
  await app.execute(`location.hash = "#/settings";`);
  // Never asked: available.
  await expect.poll(() => app.text(row)).toContain("While Ghostly is open");
  expect(await app.attribute(toggle, "aria-checked")).toBe("false");
  expect(await invoke(placed, "native_notification_permission", { request: false })).toBe("default");
  expect(await invoke(placed, "native_private_notification", { id: "e2e-2", body: "New message" })).toBe(true);
});
