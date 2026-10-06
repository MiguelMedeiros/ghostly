import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { forgetSharedData, openMacDesktop, type MacDesktop } from "../support/desktopMac";

/**
 * The Ghostly window on a Mac: closing it hides it and the app keeps running (the page, its peer and its timers go
 * on), the Dock icon brings it back, and the app menu's New Chat and Settings… open a chat and Settings, showing the
 * window first when it was hidden (apps/desktop/src/app_window.rs).
 *
 * The app under test never takes the focus (it stays out of the Dock), so no real Cmd+W, Dock click or key press
 * reaches it. The driver sends a close request as the close button does (`POST /close`), and runs the Dock's and the
 * menu's handlers (`POST /reopen`, `POST /menu`); `GET /window` reads whether the window is on screen. A person
 * checks Cmd+W, Cmd+N, Cmd+, and the Dock click by hand.
 *
 *   npm run desktop:macos:build
 *   npm run test:e2e:desktop-macos -- window-close
 */

// 49775-49779: this test's ports.
const PORTS = { app: 49775 };

let desktop: MacDesktop | undefined;
test.beforeAll(() => {
  test.skip(process.platform !== "darwin", "macOS only");
  forgetSharedData();
});
test.afterAll(async () => {
  await desktop?.stop();
  forgetSharedData();
});

test("closing the window hides it and the app runs on; the Dock and the menu bring it back", {
  tag: ["@client:desktop", "@feature:desktop.window"],
}, async ({}, testInfo) => {
  desktop = await openMacDesktop({ name: "window", port: PORTS.app });
  const { app } = desktop;
  const visible = async () => (await app.windowState()).visible;
  const hash = () => app.execute<string>(`return location.hash;`);
  // The app is up once it has drawn its home.
  await expect.poll(() => app.text('[title="New chat"]'), { timeout: 90_000 }).not.toBeNull();
  expect(await visible()).toBe(true);

  await test.step("closed, the window goes out of sight and the page runs on", async () => {
    await app.execute(`window.__ticks = 0; window.__ticker = setInterval(() => { window.__ticks += 1; }, 1000);`);
    await app.close();
    await expect.poll(visible).toBe(false);
    expect(await app.windows()).toContain("main");
    const before = await app.execute<number>(`return window.__ticks;`);
    await new Promise((done) => setTimeout(done, 5_000));
    const ticks = (await app.execute<number>(`return window.__ticks;`)) - before;
    const shown = await app.execute<string>(`return document.visibilityState;`);
    writeFileSync(testInfo.outputPath("hidden-page.txt"), `1 s timer ticks in 5 s hidden: ${ticks}\ndocument.visibilityState: ${shown}\n`);
    await testInfo.attach("hidden-page.txt", { path: testInfo.outputPath("hidden-page.txt"), contentType: "text/plain" });
    // WebKit may slow a hidden page's timers down; it must not stop them.
    expect(ticks).toBeGreaterThanOrEqual(2);
    await app.execute(`clearInterval(window.__ticker);`);
  });

  await test.step("a click on the Dock icon brings it back", async () => {
    await app.reopen();
    await expect.poll(visible).toBe(true);
  });

  await test.step("Settings… in the app menu opens Settings", async () => {
    expect(await app.menu("ghostly-settings")).toBe(true);
    await expect.poll(hash).toBe("#/settings");
  });

  await test.step("New Chat in the app menu, with the window closed, shows it with a new chat", async () => {
    await app.close();
    await expect.poll(visible).toBe(false);
    expect(await app.menu("ghostly-new-chat")).toBe(true);
    await expect.poll(visible).toBe(true);
    await expect.poll(hash, { timeout: 30_000 }).toMatch(/^#\/chat\//);
  });

  await test.step("the menu's other items are not the page's", async () => {
    expect(await app.menu("quit")).toBe(false);
    expect(await visible()).toBe(true);
  });
});
