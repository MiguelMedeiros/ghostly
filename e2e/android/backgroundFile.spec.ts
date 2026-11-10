import { writeFileSync } from "node:fs";
import type { Locator } from "@playwright/test";
import { chat } from "../support/fixtures";
import { expect, pairWithWeb, PKG, test, type AndroidApp } from "./support/android";

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

/**
 * Once its bytes are all across, the status line shows no percent ("Arrived, … is checking it… 209.7 MB" or "Checking
 * the file… 209.7 MB", then the size) a while before the side's own mark that it is through. Read as 0 in
 * that gap, a file at 98% looked as if it had gone back to nothing. How long that gap may last.
 */
const THROUGH_MS = 60_000;

/** One reading: the percent, 100 once through; null while the line shows none (the gap above, or "Not sent"). */
type Reading = { percent: number | null; line: string };

/** "12% of 209.7 MB · …": the percent; 100 once through; null while the line shows none. */
async function read({ status, done }: Side): Promise<Reading> {
  if (await done.isVisible()) return { percent: 100, line: "through" };
  const line = (await status.textContent({ timeout: 5_000 }).catch(() => "")) ?? "";
  const match = /(\d+)\s*%/.exec(line);
  return { percent: match ? Number(match[1]) : null, line };
}

/** The percent while under way: 0 before the line shows one ("Waiting for your contact…"). */
const underWay = async (side: Side) => (await read(side)).percent ?? 0;

const shown = ({ percent, line }: Reading) => percent === null ? `no percent ("${line}")` : `${percent}%`;

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
 * frozen it, at the end, and every reading. A line with no percent at the end, after the percents before it, is a
 * file through its bytes or one that failed: only the side's mark that it is through, within THROUGH_MS, makes it 100.
 * `late` is null when the line showed no percent already when Android would have frozen the app.
 */
async function whileAway(app: AndroidApp, side: Side, away: () => void, back: () => void): Promise<{ late: number | null; to: number; seen: string[] }> {
  away();
  const seen: string[] = [];
  let late: number | null | undefined;
  for (let at = STEP_MS; at <= AWAY_MS; at += STEP_MS) {
    await new Promise((done) => setTimeout(done, STEP_MS));
    const now = await read(side);
    if (late === undefined && at >= FREEZE_AFTER_MS) late = now.percent;
    seen.push(`${at / 1000}s ${shown(now)} [${processState(app)}]`);
  }
  const end = await read(side);
  back();
  seen.push(`end ${shown(end)}`);
  console.log(`  [away] from ${late === null ? "no percent" : `${late}%`} at ${FREEZE_AFTER_MS / 1000}s: ${seen.join(", ")}`);
  if (end.percent === null) {
    await expect.poll(() => side.done.isVisible(), { timeout: THROUGH_MS, message: `through after its percent went: ${seen.join(", ")}` }).toBe(true);
  }
  return { late: late ?? null, to: end.percent ?? 100, seen };
}

/** Moved on after Android would have frozen the app, or through. */
const movedOn = ({ late, to }: { late: number | null; to: number }) => to === 100 || (late !== null && to > late);

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
  await expect.poll(() => underWay(side), { timeout: 120_000 }).toBeGreaterThanOrEqual(1);

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
  await expect.poll(() => underWay(side), { timeout: 120_000 }).toBeGreaterThanOrEqual(1);

  const off = () => void app.adb.run("shell", "input", "keyevent", "KEYCODE_SLEEP");
  const on = () => {
    app.adb.run("shell", "input", "keyevent", "KEYCODE_WAKEUP");
    app.adb.tryRun("shell", "wm", "dismiss-keyguard");
  };
  const away = await whileAway(app, side, off, on);
  expect(movedOn(away), `moved on with the screen off: ${away.seen.join(", ")}`).toBe(true);
});

test("a file through at once leaves the app running, and the service stopped", { tag: ["@feature:android.files.background", "@gated"] }, async ({ app }) => {
  // The page's start and stop as a file of a few bytes sends them, before Android has the service in the foreground:
  // stopped then, Android ended the whole app ("did not then call Service.startForeground()").
  for (const gap of [0, 5, 20]) {
    await app.page.evaluate(async (gap) => {
      const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke(command: string, args: unknown): Promise<unknown> } }).__TAURI_INTERNALS__;
      for (let round = 0; round < 5; round++) {
        const on = invoke("keep_awake", { on: true, files: true });
        if (gap) await new Promise((done) => setTimeout(done, gap));
        await Promise.all([on, invoke("keep_awake", { on: false, files: false })]);
        await new Promise((done) => setTimeout(done, 300));
      }
    }, gap);
  }
  // Android ends an app this way a few seconds after the stop.
  await new Promise((done) => setTimeout(done, 10_000));
  expect(app.adb.tryRun("shell", "pidof", PKG).out.trim(), "the app still runs").toBe(app.pid);
  await expect.poll(() => /TransferService/.test(app.adb.tryRun("shell", "dumpsys", "activity", "services", PKG).out), { message: "the service stopped" }).toBe(false);
});
