import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, pairWithWeb, PKG, test, type AndroidApp } from "./support/android";

/**
 * Chats stay connected while the app is out of sight. Android freezes an app that runs nothing in the foreground (the
 * cached apps freezer, about 10 s after it leaves): Rust's network and the WebView's renderer stop with it, the chat's
 * link went down within seconds, and on return it had to connect again. With "Stay connected in the background" on
 * (the default) the app holds a remote-messaging foreground service with a quiet notification (ConnectionService.kt).
 *
 * How long the app stays away: E2E_ANDROID_AWAY_S (60 s by default; the PR's 1 / 5 / 15 / 30 min runs set it).
 */

const AWAY_MS = Number(process.env.E2E_ANDROID_AWAY_S || 60) * 1000;
const STEP_MS = Math.min(10_000, AWAY_MS);

const connection = (page: Page) => page.getByTestId("connection-options").filter({ visible: true }).first();
const connected = async (page: Page) => /Connected · /.test((await connection(page).getAttribute("aria-label").catch(() => null)) ?? "");

/** The app's own process and the WebView's renderer as Android has them: frozen or not, and their oom adj. */
function processState(app: AndroidApp): string {
  const dump = app.adb.tryRun("shell", "dumpsys", "activity", "processes").out;
  return dump.split(/\n {2}\*/).filter((block) => block.includes(`packageList={${PKG}}`)).map((block) => {
    const name = /sandboxed_process/.test(block) ? "renderer" : "app";
    return `${name} ${/isFrozen=true/.test(block) ? "frozen" : "running"} adj ${/oom adj:.* cur=(\d+)/.exec(block)?.[1] ?? "?"}`;
  }).join(", ") || "(gone)";
}

const serviceRuns = (app: AndroidApp) => /ConnectionService/.test(app.adb.tryRun("shell", "dumpsys", "activity", "services", PKG).out);

/** The connection service's record: in the foreground, and of which types (0x200: remoteMessaging). */
function serviceRecord(app: AndroidApp): string {
  const dump = app.adb.tryRun("shell", "dumpsys", "activity", "services", PKG).out;
  return dump.split(/\n\s*\* ServiceRecord/).find((block) => block.includes("ConnectionService")) ?? "";
}

/**
 * The app away for AWAY_MS while the web peer (always in front) watches the chat: how long the web peer saw it
 * connected, and once back, how long the app took to say Connected again.
 */
async function awayAndBack(app: AndroidApp, web: Page): Promise<{ webConnected: number; steps: number; backMs: number; seen: string[] }> {
  app.background();
  const seen: string[] = [];
  let webConnected = 0, steps = 0;
  for (let at = STEP_MS; at <= AWAY_MS; at += STEP_MS) {
    await new Promise((done) => setTimeout(done, STEP_MS));
    const live = await connected(web);
    steps++;
    if (live) webConnected++;
    seen.push(`${at / 1000}s web ${live ? "connected" : "not connected"} [${processState(app)}]${serviceRuns(app) ? " service" : ""}`);
  }
  const back = Date.now();
  app.foreground();
  await expect.poll(() => connected(app.page), { timeout: 180_000, intervals: [100] }).toBe(true);
  const backMs = Date.now() - back;
  console.log(`  [away ${AWAY_MS / 1000}s] web saw it connected ${webConnected}/${steps}, Connected again ${backMs} ms after back: ${seen.join(", ")}`);
  return { webConnected, steps, backMs, seen };
}

test.beforeEach(({}, testInfo) => testInfo.setTimeout(AWAY_MS + 8 * 60_000));

test("a chat stays connected with the app in the background", { tag: ["@feature:android.background.connected", "@gated"] }, async ({ app, webPeer }) => {
  const web = await webPeer("web-stay");
  await pairWithWeb(app, web);
  // On by default, with a chat: the service holds the app in the foreground, as remoteMessaging. (Its notification
  // shows once notifications are allowed; a `pm clear` start has not been asked, and Android runs the service anyway.)
  await expect.poll(() => serviceRuns(app), { message: "the connection service runs" }).toBe(true);
  const record = serviceRecord(app);
  expect(record, record).toMatch(/isForeground=true/);
  expect(record, record).toMatch(/types=0x0*200\b/);

  const away = await awayAndBack(app, web.page);
  test.info().annotations.push({ type: "measure", description: `on, away ${AWAY_MS / 1000}s: web connected ${away.webConnected}/${away.steps}, back ${away.backMs} ms` });
  expect(away.seen.every((step) => !/app frozen/.test(step)), `the app never froze: ${away.seen.join(", ")}`).toBe(true);
  expect(away.webConnected, `the web peer saw the chat connected all along: ${away.seen.join(", ")}`).toBe(away.steps);
  expect(away.backMs, "Connected at once on return").toBeLessThan(5_000);
});

/**
 * Battery, measured only when asked (E2E_ANDROID_BATTERY_S, the idle time): the app paired and out of sight with the
 * switch on, then off, on battery (`dumpsys battery unplug`), batterystats reset before each. Logs the app's CPU time
 * and wake lock time from `dumpsys batterystats`; nothing asserted, the emulator's power model says little in mAh.
 */
const BATTERY_MS = Number(process.env.E2E_ANDROID_BATTERY_S || 0) * 1000;

function batteryLine(app: AndroidApp): string {
  const stats = app.adb.tryRun("shell", "dumpsys", "batterystats", PKG).out;
  const pick = (pattern: RegExp) => stats.split("\n").map((line) => line.trim()).filter((line) => pattern.test(line)).slice(0, 6).join(" | ");
  return [pick(/^Wake lock .*ghostly|^Wake lock \*job|^Wakelock/i), pick(/Total cpu time|Proc tools\.ghostly\.app|CPU:/), pick(/Estimated power use|Uid u0a\d+:/)].filter(Boolean).join(" || ");
}

test("battery while idle out of sight, on and then off", { tag: ["@feature:android.background.connected", "@gated"] }, async ({ app, webPeer }, testInfo) => {
  test.skip(!BATTERY_MS, "set E2E_ANDROID_BATTERY_S to measure");
  testInfo.setTimeout(2 * BATTERY_MS + 10 * 60_000);
  const web = await webPeer("web-battery");
  await pairWithWeb(app, web);
  await expect.poll(() => serviceRuns(app)).toBe(true);
  app.adb.run("shell", "dumpsys", "battery", "unplug");
  try {
    for (const on of [true, false]) {
      if (!on) {
        await app.page.evaluate(() => { localStorage.setItem("ghostly_stay_connected", "0"); dispatchEvent(new Event("ghostly-stay-connected")); });
        await expect.poll(() => serviceRuns(app)).toBe(false);
      }
      app.adb.run("shell", "dumpsys", "batterystats", "--reset");
      app.background();
      await new Promise((done) => setTimeout(done, BATTERY_MS));
      const line = batteryLine(app);
      const live = await connected(web.page);
      app.foreground();
      console.log(`  [battery ${on ? "on" : "off"} ${BATTERY_MS / 1000}s] web connected at the end: ${live}; ${line}`);
      testInfo.annotations.push({ type: "battery", description: `${on ? "on" : "off"}: ${line}` });
      writeFileSync(testInfo.outputPath(`batterystats-${on ? "on" : "off"}.txt`), app.adb.tryRun("shell", "dumpsys", "batterystats", PKG).out);
      await expect.poll(() => connected(app.page), { timeout: 180_000 }).toBe(true);
    }
  } finally {
    app.adb.tryRun("shell", "dumpsys", "battery", "reset");
  }
});

test("off, the app stops out of sight as before, and the service is let go", { tag: ["@feature:android.background.connected", "@gated"] }, async ({ app, webPeer }) => {
  const web = await webPeer("web-stay-off");
  await pairWithWeb(app, web);
  await expect.poll(() => serviceRuns(app)).toBe(true);
  // The switch in Settings, as it keeps itself.
  await app.page.evaluate(() => { localStorage.setItem("ghostly_stay_connected", "0"); dispatchEvent(new Event("ghostly-stay-connected")); });
  await expect.poll(() => serviceRuns(app), { message: "the connection service stopped" }).toBe(false);

  // The "before" numbers: nothing asserted of them, they are what the switch changes.
  const away = await awayAndBack(app, web.page);
  test.info().annotations.push({ type: "measure", description: `off, away ${AWAY_MS / 1000}s: web connected ${away.webConnected}/${away.steps}, back ${away.backMs} ms` });
});
