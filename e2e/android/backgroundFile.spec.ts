import { writeFileSync } from "node:fs";
import type { Locator } from "@playwright/test";
import { chat } from "../support/fixtures";
import { expect, pairWithWeb, test, type AndroidApp } from "./support/android";

/**
 * A file keeps moving while the app is out of sight: in the background (Home) or with the screen off. Android freezes
 * an app out of sight that runs nothing in the foreground (the cached apps freezer, 10 s after it leaves; Doze later),
 * which stops Rust's network and the WebView alike: a transfer stalled until the app came back. The app holds a
 * foreground service with its notification, and a partial wake lock, while a file moves (TransferService.kt).
 */

/** Over the 25 MB a receiver takes without asking, and big enough to still be moving well after the app goes away. */
const SIZE = 200 * 1024 * 1024;
/** How long the app stays away, read every STEP_MS. */
const AWAY_MS = 40_000;
const STEP_MS = 5_000;
/** Android freezes an app out of sight 10 s after it leaves: what moved before that says nothing. */
const FREEZE_AFTER_MS = 15_000;

/** The web peer's side of the file: its status line, and what shows once it is through. */
type Side = { status: Locator; done: Locator };

/** "12% of 209.7 MB · …": the percent; 100 once through; 0 while the line shows none ("Waiting for your contact…"). */
async function percent({ status, done }: Side): Promise<number> {
  if (await done.isVisible()) return 100;
  const text = (await status.textContent({ timeout: 5_000 }).catch(() => "")) ?? "";
  const match = /(\d+)\s*%/.exec(text);
  return match ? Number(match[1]) : 0;
}

/** Each of the app's processes (its own, the WebView's renderer) as Android has them: frozen or not, and its oom adj. */
function processState(app: AndroidApp): string {
  const dump = app.adb.tryRun("shell", "dumpsys", "activity", "processes").out;
  return dump.split(/\n {2}\*/).filter((block) => block.includes("packageList={tools.ghostly.app}")).map((block) => {
    const name = /sandboxed_process/.test(block) ? "renderer" : "app";
    return `${name} ${/isFrozen=true/.test(block) ? "frozen" : "running"} adj ${/oom adj:.* cur=(\d+)/.exec(block)?.[1] ?? "?"}`;
  }).join(", ") || "(gone)";
}

/**
 * The app away for AWAY_MS while `side` (the web peer's, always in front) is read: the percent once Android would have
 * frozen it, at the end, and every reading.
 */
async function whileAway(app: AndroidApp, side: Side, away: () => void, back: () => void): Promise<{ late: number; to: number; seen: string[] }> {
  away();
  const seen: string[] = [];
  let late = -1;
  for (let at = STEP_MS; at <= AWAY_MS; at += STEP_MS) {
    await new Promise((done) => setTimeout(done, STEP_MS));
    const now = await percent(side);
    if (late < 0 && at >= FREEZE_AFTER_MS) late = now;
    seen.push(`${at / 1000}s ${now}% [${processState(app)}]`);
  }
  const to = await percent(side);
  back();
  console.log(`  [away] from ${late}% at ${FREEZE_AFTER_MS / 1000}s to ${to}%: ${seen.join(", ")}`);
  return { late, to, seen };
}

/** Moved on after Android would have frozen the app, or through. */
const movedOn = ({ late, to }: { late: number; to: number }) => to === 100 || to > late;

test.beforeEach(({}, testInfo) => testInfo.setTimeout(8 * 60_000));

test("a file received keeps moving with the app in the background", { tag: ["@feature:android.files.background", "@gated"] }, async ({ app, webPeer }, testInfo) => {
  const web = await webPeer("web-bg-in");
  await pairWithWeb(app, web);

  const path = testInfo.outputPath("to-android.bin");
  writeFileSync(path, Buffer.alloc(SIZE, 7));
  await web.page.getByTestId("file-input").setInputFiles(path);
  await chat(app.peer).getByTestId("file-bubble").last().getByTestId("file-accept").click({ timeout: 90_000 });
  const row = chat(web).locator("[data-message-row]").filter({ hasText: "to-android.bin" }).last();
  const side: Side = { status: row.getByTestId("file-status"), done: row.locator('[data-testid="message-delivery"][data-delivery="delivered"]') };
  await expect.poll(() => percent(side), { timeout: 120_000 }).toBeGreaterThanOrEqual(1);

  const away = await whileAway(app, side, app.background, app.foreground);
  expect(movedOn(away), `moved on with the app in the background: ${away.seen.join(", ")}`).toBe(true);
});

test("a file sent keeps moving with the screen off", { tag: ["@feature:android.files.background", "@gated"] }, async ({ app, webPeer }) => {
  const web = await webPeer("web-bg-out");
  await pairWithWeb(app, web);

  // Made in the app's page, as the system's picker would hand it: Playwright gives a WebView over adb 50 MB at most.
  await app.page.getByTestId("file-input").evaluate((input: HTMLInputElement, size) => {
    const picked = new DataTransfer();
    picked.items.add(new File([new Uint8Array(size).fill(7)], "from-android.bin", { type: "application/octet-stream" }));
    input.files = picked.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, SIZE);
  const bubble = chat(web).getByTestId("file-bubble").filter({ hasText: "from-android.bin" }).last();
  await bubble.getByTestId("file-accept").click({ timeout: 90_000 });
  const side: Side = { status: bubble.getByTestId("file-status"), done: bubble.getByTestId("file-save") };
  await expect.poll(() => percent(side), { timeout: 120_000 }).toBeGreaterThanOrEqual(1);

  const off = () => void app.adb.run("shell", "input", "keyevent", "KEYCODE_SLEEP");
  const on = () => {
    app.adb.run("shell", "input", "keyevent", "KEYCODE_WAKEUP");
    app.adb.tryRun("shell", "wm", "dismiss-keyguard");
  };
  const away = await whileAway(app, side, off, on);
  expect(movedOn(away), `moved on with the screen off: ${away.seen.join(", ")}`).toBe(true);
});
