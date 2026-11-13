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

/** The app's task id. With its empty taskAffinity the task reads `I=<package>/.MainActivity`, not `A=<uid>:<package>`. */
function task(app: AndroidApp): string {
  const pkg = PKG.replace(/\./g, "\\.");
  const id = app.adb.shell("dumpsys activity recents").match(new RegExp(`Task\\{\\w+ #(\\d+) type=standard (?:I=${pkg}/|A=\\d+:${pkg}\\b)`));
  if (!id) throw new Error(`no task of ${PKG} in dumpsys activity recents`);
  return id[1];
}

const splitScreen = (app: AndroidApp, command: string) => app.adb.shell(`dumpsys activity service SystemUIService WMShell splitscreen ${command}`);

/** Sets the lock's password in Settings › Privacy, which turns the lock on; the page stays there. */
async function lockOn(app: AndroidApp) {
  const { page } = app;
  await page.evaluate(() => { location.hash = "#/settings/privacy"; });
  await page.getByTestId("settings-lock").click();
  const passwords = page.getByTestId("settings-password-form").locator("input[type=password]");
  await passwords.nth(0).fill(PASSWORD);
  await passwords.nth(1).fill(PASSWORD);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByTestId("settings-lock-now")).toBeVisible();
}

/** Runs `covered` with the app in the top half beside Settings, Settings with the focus: the app's half shows only the cover. */
async function inSplitScreen(app: AndroidApp, covered: () => Promise<void>) {
  app.adb.shell("am start -W -a android.settings.SETTINGS");
  const id = task(app);
  splitScreen(app, `moveToSideStage ${id} 0`);
  try {
    await sleep(2000);
    app.adb.shell("am start -W -a android.settings.SETTINGS");
    await expect.poll(() => focused(app), { timeout: 20_000, message: "Settings has the focus" }).toContain("com.android.settings");
    await covered();
  } finally {
    app.adb.tryRun("shell", "dumpsys", "activity", "service", "SystemUIService", "WMShell", "splitscreen", "exitSplitScreen", id);
  }
}

/**
 * The texts of the app's nodes in every window's accessibility tree on screen (what TalkBack reads and presses).
 * `--compressed`: the views important for accessibility only, as a screen reader walks them; a plain dump takes every
 * view, even the cover's own line it hides (noHideDescendants).
 */
function accessibleTexts(app: AndroidApp): string[] {
  app.adb.tryRun("shell", "rm", "-f", "/sdcard/ghostly-windows.xml");
  app.adb.shell("uiautomator dump --windows --compressed /sdcard/ghostly-windows.xml");
  const xml = app.adb.shell("cat /sdcard/ghostly-windows.xml");
  return (xml.match(/<node [^>]*>/g) ?? [])
    .filter((node) => node.includes(`package="${PKG}"`))
    .flatMap((node) => [...node.matchAll(/ (?:text|content-desc)="([^"]+)"/g)].map((found) => found[1]));
}

test("with the lock on, a tap on the app's covered half in split screen brings it back and presses nothing under the cover", { tag: ["@feature:settings.lock.idle", "@gated"] }, async ({ app }) => {
  const { page } = app;
  await lockOn(app);
  const lockNow = page.getByTestId("settings-lock-now");

  await inSplitScreen(app, async () => {
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
  });
});

test("with the lock on, the page under the cover is hidden from accessibility services too, and back with the app", { tag: ["@feature:settings.lock.idle", "@gated"] }, async ({ app }) => {
  await lockOn(app);
  const PAGE_TEXT = "Send typing indicator";
  // The WebView builds its tree only once a client asks for it: the page is in it first, in front.
  await expect.poll(() => accessibleTexts(app), { timeout: 20_000, message: "the page in the accessibility tree" }).toContain(PAGE_TEXT);

  await inSplitScreen(app, async () => {
    await sleep(1500);
    // TalkBack would read the hidden settings aloud and its double tap press them, as a tap did before the cover took it.
    expect(accessibleTexts(app), "the covered page in the accessibility tree").not.toContain(PAGE_TEXT);

    // Back in front: the page is there for TalkBack again.
    app.adb.shell("am start -W -n tools.ghostly.app/.MainActivity");
    await expect.poll(() => focused(app), { timeout: 20_000, message: "the app has the focus" }).toContain(PKG);
    await expect.poll(() => accessibleTexts(app), { timeout: 20_000, message: "the page in the accessibility tree" }).toContain(PAGE_TEXT);
  });
});
