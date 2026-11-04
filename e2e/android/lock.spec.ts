import { type AndroidApp, PKG, expect, test } from "./support/android";

/**
 * The app lock on Android: MainActivity's cover goes over the page while the app is not the focused window
 * (SwitcherPicture.covered). In split screen that is the app's half while the other app has the focus.
 */

const PASSWORD = "spooky-lock";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** The window with the system's focus, as `dumpsys window` says. */
const focused = (app: AndroidApp) => (app.adb.shell("dumpsys window displays").match(/mCurrentFocus=.*/) ?? [""])[0];

/** The app's bounds on the screen (its half in split screen): left, top, right, bottom. */
function bounds(app: AndroidApp): number[] {
  const section = app.adb.shell("dumpsys window windows").split(/\n(?= {2}Window #)/).find((part) => part.includes(`${PKG}/${PKG}.MainActivity`)) ?? "";
  const rect = section.match(/mBounds=Rect\((\d+), (\d+) - (\d+), (\d+)\)/);
  if (!rect) throw new Error(`the app's window has no bounds in dumpsys window: ${section.slice(0, 800)}`);
  return rect.slice(1, 5).map(Number);
}

function task(app: AndroidApp): string {
  const id = app.adb.shell("dumpsys activity recents").match(new RegExp(`Task\\{\\w+ #(\\d+) type=standard A=\\d+:${PKG.replace(/\./g, "\\.")}`));
  if (!id) throw new Error(`no task of ${PKG} in dumpsys activity recents`);
  return id[1];
}

const splitScreen = (app: AndroidApp, command: string) => app.adb.shell(`dumpsys activity service SystemUIService WMShell splitscreen ${command}`);

test("with the lock on, a tap on the app's covered half in split screen brings it back and presses nothing under the cover", { tag: ["@feature:settings.lock.idle", "@gated"] }, async ({ app }) => {
  const { page } = app;
  await page.evaluate(() => { location.hash = "#/settings/privacy"; });
  await page.getByTestId("settings-lock").click();
  const passwords = page.getByTestId("settings-password-form").locator("input[type=password]");
  await passwords.nth(0).fill(PASSWORD);
  await passwords.nth(1).fill(PASSWORD);
  await page.getByRole("button", { name: "Set password" }).click();
  const lockNow = page.getByTestId("settings-lock-now");
  await expect(lockNow).toBeVisible();

  // The app in the top half beside Settings, Settings with the focus: the app's half shows only the cover.
  app.adb.shell("am start -W -a android.settings.SETTINGS");
  const id = task(app);
  splitScreen(app, `moveToSideStage ${id} 0`);
  try {
    await sleep(2000);
    app.adb.shell("am start -W -a android.settings.SETTINGS");
    await expect.poll(() => focused(app), { timeout: 20_000, message: "Settings has the focus" }).toContain("com.android.settings");

    // A tap on the blank half, right where Lock now is under the cover.
    await lockNow.evaluate((el) => el.scrollIntoView({ block: "center" }));
    const box = await lockNow.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, dpr: window.devicePixelRatio, height: window.innerHeight };
    });
    // The WebView ends at the half's bottom (the content view has no bottom padding in the top half).
    const [left, , , bottom] = bounds(app);
    app.adb.shell(`input tap ${Math.round(left + box.x * box.dpr)} ${Math.round(bottom - (box.height - box.y) * box.dpr)}`);

    await expect.poll(() => focused(app), { timeout: 20_000, message: "the tap gives the app the focus" }).toContain(PKG);
    await sleep(1500);
    await expect(page.getByText("Ghostly is locked"), "the tap reached Lock now under the cover").toHaveCount(0);
    await expect(lockNow).toBeVisible();
  } finally {
    app.adb.tryRun("shell", "dumpsys", "activity", "service", "SystemUIService", "WMShell", "splitscreen", "exitSplitScreen", id);
  }
});
