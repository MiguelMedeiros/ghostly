import { expect, test } from "@playwright/test";
import { forgetSharedData, openMacDesktop, type MacDesktop } from "../support/desktopMac";

/**
 * The Desktop app's title bar on a Mac follows the app's Light / Dark choice in Settings, not the system's
 * appearance; Auto (System) gives it back to the system. The page asks Tauri for the window's theme
 * (`plugin:window|set_theme`, apps/ui/src/lib/windowTheme.ts), which on a Mac is the app's NSAppearance: the test
 * driver reads the theme the window has (`GET /window`). Light and Dark are both chosen, so one of them differs from
 * the Mac's own appearance whichever it is. With Auto the window matches what the page reads from the system.
 *
 * How the title bar looks is checked by hand.
 *
 *   npm run desktop:macos:build
 *   npm run test:e2e:desktop-macos -- title-bar-theme
 */

// 49770-49774: this test's ports.
const PORTS = { app: 49770 };

/** Presses Light, Dark or Auto in Settings → Appearance → Mode. */
const choose = (desktop: MacDesktop, label: "Light" | "Dark" | "Auto") => desktop.app.execute(
  `const button = [...document.querySelectorAll('[role="group"][aria-label="Mode"] button')].find((b) => b.textContent.trim() === arguments[0]);
   if (!button) throw new Error("No " + arguments[0] + " button in Settings");
   button.click();`,
  label,
);

const theme = async (desktop: MacDesktop) => (await desktop.app.windowState()).theme;

let desktop: MacDesktop | undefined;
test.beforeAll(() => {
  test.skip(process.platform !== "darwin", "macOS only");
  forgetSharedData();
});
test.afterAll(async () => {
  await desktop?.stop();
  forgetSharedData();
});

test("the title bar takes the app's Light or Dark, and the system's with Auto", {
  tag: ["@client:desktop", "@feature:app.theme.title-bar"],
}, async () => {
  desktop = await openMacDesktop({ name: "title-bar", port: PORTS.app });
  // A new profile is Dark from the start, whatever the Mac's appearance.
  await expect.poll(() => theme(desktop!), { timeout: 30_000 }).toBe("dark");

  await desktop.app.execute(`location.hash = "#/settings";`);
  await expect.poll(() => desktop!.app.text('[role="group"][aria-label="Mode"]')).not.toBeNull();

  await choose(desktop, "Light");
  await expect.poll(() => theme(desktop!)).toBe("light");
  await choose(desktop, "Dark");
  await expect.poll(() => theme(desktop!)).toBe("dark");

  await choose(desktop, "Auto");
  const system = () => desktop!.app.execute<string>(`return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";`);
  await expect.poll(async () => (await theme(desktop!)) === (await system())).toBe(true);
  // The page is drawn in the same appearance as the window around it. The page follows a moment after the window.
  const page = () => desktop!.app.execute<string>(`return document.documentElement.getAttribute("data-theme");`);
  await expect.poll(async () => (await page()) === (await theme(desktop!))).toBe(true);
});
