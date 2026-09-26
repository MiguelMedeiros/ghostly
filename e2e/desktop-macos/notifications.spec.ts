import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { forgetSharedData, openMacDesktop, type MacDesktop } from "../support/desktopMac";

/**
 * System notifications in the Desktop app on a Mac (#315). macOS answers a notification request only for an app
 * Launch Services knows, and a copy started by its binary (as this harness starts its copies)
 * is not one until it says so: the request failed, and Settings said "Not available here". The app now registers
 * its own bundle; this checks that it did, that Settings offers the switch, that a notification call is answered
 * (without the permission it shows nothing), and how Settings says the permission was refused.
 *
 * Nothing here asks macOS for the permission: that opens a dialog for the person at the Mac. The banner itself,
 * and a click on it opening its chat, are checked by hand.
 *
 *   npm run desktop:macos:build
 *   npm run test:e2e:desktop-macos -- notifications
 */

// 49720-49729: this test's ports.
const PORT = 49720;

/** The paths Launch Services has for a bundle id. */
function registered(bundleId: string): string[] {
  const script = `ObjC.import("AppKit");
    const urls = $.NSWorkspace.sharedWorkspace.URLsForApplicationsWithBundleIdentifier(${JSON.stringify(bundleId)});
    const out = []; for (let i = 0; i < urls.count; i++) out.push(urls.objectAtIndex(i).path.js);
    JSON.stringify(out);`;
  return JSON.parse(execFileSync("osascript", ["-l", "JavaScript", "-e", script], { encoding: "utf8" })) as string[];
}

let desktop: MacDesktop | undefined;
test.beforeAll(() => {
  test.skip(process.platform !== "darwin", "macOS only");
  forgetSharedData();
});
test.afterAll(async () => {
  await desktop?.stop();
  forgetSharedData();
});

test("a copy started by its binary can ask for notifications, and Settings offers them", {
  tag: ["@client:desktop", "@feature:desktop.notifications", "@feature:app.attention.notifications"],
}, async () => {
  desktop = await openMacDesktop({ name: "notices", port: PORT });
  const { app } = desktop;

  // Registered with Launch Services once the app is up, from its own folder.
  await expect.poll(() => registered(desktop!.bundleId), { timeout: 15_000 }).toContain(desktop.bundle);

  // Asked, never decided: available, not "Not available here".
  await app.execute(`location.hash = "#/settings";`);
  const row = '[data-testid="settings-system-notifications-row"]';
  await expect.poll(() => app.text(row)).toContain("While Ghostly is open");
  expect(await app.attribute('[data-testid="settings-system-notifications"]', "aria-checked")).toBe("false");
  expect(await app.executeAsync<string>(
    `const done = arguments[arguments.length - 1];
     window.__TAURI_INTERNALS__.invoke("native_notification_permission", { request: false }).then(done, (e) => done("threw: " + e));`,
  )).toBe("default");

  // Without the permission a notification is answered and shows nothing.
  expect(await app.executeAsync<unknown>(
    `const done = arguments[arguments.length - 1];
     window.__TAURI_INTERNALS__.invoke("native_private_notification", { id: "e2e-1", body: "New message" }).then(done, (e) => done("threw: " + e));`,
  )).toBe(true);

  // Refused in macOS: one line, and a button to the Notifications pane (not clicked: it opens System Settings).
  await app.execute(
    `const internals = window.__TAURI_INTERNALS__, invoke = internals.invoke.bind(internals);
     internals.invoke = (command, args, options) => command === "native_notification_permission" ? Promise.resolve("denied") : invoke(command, args, options);
     window.dispatchEvent(new Event("focus"));`,
  );
  await expect.poll(() => app.text(row)).toContain("Allow them in macOS Settings → Notifications → Ghostly");
  expect(await app.text('[data-testid="settings-notification-settings"]')).toBe("Open settings");
});
