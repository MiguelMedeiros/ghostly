import { test as base, expect, type Page, type TestInfo } from "@playwright/test";
import { _android, type AndroidDevice } from "playwright";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { openPeer, type Peer } from "../../support/fixtures";
import { LocalRelay } from "../../support/relay";

export { expect };

/**
 * The native Android app (apps/desktop built with Tauri for Android, docs/ANDROID.md) on an emulator, driven by
 * Playwright's `_android` over adb inside the app's own WebView, as tools/scripts/android-smoke.mjs does. A test gets
 * the app with no data (`pm clear`), started as a debug e2e start (`--ez ghostly_e2e true`: no name step, never a new
 * profile's default Mainnet wallets), and its page.
 *
 * Its network never leaves the machine the tests run on, for what the specs read: the Pkarr relay lives in the test
 * process (support/relay.ts) and the emulator reaches it at 127.0.0.1 through `adb reverse`, as it reaches the e2e
 * infra's Iroh relay when GHOSTLY_IROH_RELAY_URL names one. The app takes plain HTTP relays from loopback only, so
 * 10.0.2.2 (the host as the emulator sees it) would be refused; `adb reverse` makes the host's port the emulator's own.
 * Until the debug start takes the network from extras (see `launch`), the Rust side still reaches the public Mainline
 * DHT on its own: nothing a spec checks depends on it.
 *
 *   E2E_ANDROID_APK      the APK to install once per run (otherwise the one installed is used)
 *   E2E_ANDROID_SERIAL   which device (`adb devices`), or ANDROID_SERIAL; required outside CI, since every test clears
 *                        the app's data there (on CI, the only device)
 *   E2E_ANDROID_A1=1     run the Android host specs even when the app says it has no such host yet (see `pending`)
 */

export const PKG = "tools.ghostly.app";
const ACTIVITY = `${PKG}/.MainActivity`;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** One device over adb: every command names its serial, since another session's emulator may share the adb server. */
export class Adb {
  constructor(readonly serial: string) {}

  run(...args: string[]): string {
    return execFileSync("adb", ["-s", this.serial, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  }

  /** As `run`, but a failure is its output, not an exception (`pm grant` of an undeclared permission, a missing file). */
  tryRun(...args: string[]): { ok: boolean; out: string } {
    try {
      return { ok: true, out: this.run(...args) };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message: string };
      return { ok: false, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` || failure.message };
    }
  }

  shell(command: string): string {
    return this.run("shell", command);
  }

  /** The device's lines since `logcat -c`, in the time format. */
  logcat(...filter: string[]): string {
    return this.run("logcat", "-d", "-v", "time", ...filter);
  }

  /** The emulator's port as the host's own: `adb reverse` for a TCP port on the host's loopback. */
  reverse(port: number): void {
    this.run("reverse", `tcp:${port}`, `tcp:${port}`);
  }

  unreverse(port: number): void {
    this.tryRun("reverse", "--remove", `tcp:${port}`);
  }

  pid(): string {
    return this.tryRun("shell", "pidof", PKG).out.trim();
  }
}

/**
 * The serial to drive: the one named, or on CI the only device adb lists. Outside CI it has to be named: every test
 * clears the app's data (`pm clear`), and the only device listed may be a phone or another session's emulator.
 */
function chooseSerial(): string | null {
  const named = process.env.E2E_ANDROID_SERIAL || process.env.ANDROID_SERIAL;
  if (named) return named;
  if (!process.env.CI) return null;
  let listed: string;
  try {
    listed = execFileSync("adb", ["devices"], { encoding: "utf8", timeout: 30_000 });
  } catch {
    return null;
  }
  const devices = listed.split("\n").slice(1).map((line) => line.trim().split(/\s+/)).filter(([serial, state]) => serial && state === "device").map(([serial]) => serial);
  if (devices.length > 1) throw new Error(`Several Android devices (${devices.join(", ")}): name one with E2E_ANDROID_SERIAL`);
  return devices[0] ?? null;
}

/** The app's TCP ports the emulator reaches on the host's loopback (the in-process Pkarr relay, the infra's Iroh relay). */
function portOf(url: string): number {
  const parsed = new URL(url);
  return Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
}

/** The e2e infra's Iroh relay (e2e/infra, `npm run e2e:infra:up`; CI starts it alone), when this run has one. */
export const irohRelay = (): string | undefined => process.env.GHOSTLY_IROH_RELAY_URL || undefined;

/**
 * What the Android host (A1) brings, and how the app refuses it until then. A spec about one of them asks `pending`:
 * an error that is one of these refusals skips the test (the APK under test has no such host yet) instead of failing
 * it; anything else fails. E2E_ANDROID_A1=1 turns the skip into a failure, for the run that proves A1.
 */
const PRE_A1_REFUSALS = [
  /No opener on this platform/,
  /No browser to open/,
  /No native clipboard on this platform/,
  /Not available on this platform/,
];

export function pending(error: unknown): string | null {
  const text = String((error as Error)?.message ?? error);
  return PRE_A1_REFUSALS.some((refusal) => refusal.test(text)) ? text : null;
}

/** Skips the running test when the app has no Android host for `what` yet (see `pending`), unless E2E_ANDROID_A1=1. */
export function skipUntilA1(what: string, why: string | null | false): void {
  if (!why) return;
  if (process.env.E2E_ANDROID_A1 === "1") throw new Error(`${what}: the app has no Android host for it (${why}), and E2E_ANDROID_A1=1 wants one`);
  base.skip(true, `${what} waits for the Android host (A1): ${why}`);
}

export interface AndroidApp {
  adb: Adb;
  device: AndroidDevice;
  page: Page;
  /** The app as a peer for the shared helpers (support/fixtures.ts `say`, `chat`, …). Its context is the WebView's. */
  peer: Peer;
  /** The app's process id, as `pidof` said once the page was up. */
  pid: string;
  /** Rust's own call into the page's bridge: what the app's code would call. */
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** The Home key, then back to the app (its activity brought forward, the same WebView). */
  background(): void;
  foreground(): void;
}

type WorkerFixtures = {
  /** The device, connected once for the run, with the APK installed (E2E_ANDROID_APK); null when adb lists none. */
  android: { adb: Adb; device: AndroidDevice } | null;
};

/** The device, or the test skipped: a machine with no emulator runs none of these. */
function needDevice(android: WorkerFixtures["android"]): { adb: Adb; device: AndroidDevice } {
  base.skip(!android, process.env.CI
    ? "no Android device or emulator (adb devices)"
    : "no device named: E2E_ANDROID_SERIAL=<adb serial> (the specs clear the app's data on it); see e2e/android/playwright.config.ts");
  return android!;
}

type Fixtures = {
  relay: LocalRelay;
  /** The in-process relay's URL as the app reaches it (127.0.0.1 on the emulator, `adb reverse`d to the host). */
  relayUrl: string;
  /** The app, with no data, started for this test; its Network settings on this test's relays. */
  app: AndroidApp;
  /** A web peer (Chromium on the host, the built web app) on the same relays: support/fixtures.ts `openPeer`. */
  webPeer: (name: string) => Promise<Peer>;
};

/** Installs `apk`, over the one installed when it can; a debug key from another machine needs the old one gone. */
function install(adb: Adb, apk: string): void {
  const first = adb.tryRun("install", "-r", "-t", apk);
  if (first.ok && /Success/.test(first.out)) return;
  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(first.out)) {
    adb.tryRun("uninstall", PKG);
    const again = adb.run("install", "-t", apk);
    if (/Success/.test(again)) return;
    throw new Error(`adb install ${apk}: ${again}`);
  }
  throw new Error(`adb install ${apk}: ${first.out}`);
}

/** The WebView of the app's process `pid`, not one of a process that is gone (`pm clear` kills it; the list lags). */
async function webViewPage(device: AndroidDevice, pid: number): Promise<Page> {
  const end = Date.now() + 120_000;
  while (Date.now() < end) {
    const view = device.webViews().find((v) => v.pkg() === PKG && v.pid() === pid);
    if (view) return await view.page();
    await sleep(250);
  }
  throw new Error(`No WebView of ${PKG} (pid ${pid}) over adb within 120 s`);
}

/** Starts the app as a debug e2e start: `ghostly_e2e` (MainActivity.kt), and the network for when it reads extras. */
function launch(adb: Adb, env: Record<string, string>): string {
  // `GHOSTLY_*` string extras: the network a debug e2e start should take (as the Desktop suite's environment), for
  // when MainActivity sets them; ignored until then (the app's Network settings are set from the page instead).
  const extras = Object.entries(env).flatMap(([name, value]) => ["--es", name, value]);
  const started = adb.run("shell", "am", "start", "-W", "-n", ACTIVITY, "--ez", "ghostly_e2e", "true", ...extras);
  if (!/Status: ok/.test(started)) throw new Error(`am start: ${started}`);
  return started;
}

/** Points the app at the test's relays, as a person would in Settings > Network, and reads them back. */
async function useTestNetwork(page: Page, relay: string, iroh: string | undefined): Promise<void> {
  await page.evaluate(() => { location.hash = "#/settings/network"; });
  await page.getByTestId("network-relays").fill(relay);
  if (iroh && await page.getByTestId("network-iroh-relays").count()) await page.getByTestId("network-iroh-relays").fill(iroh);
  await page.getByTestId("network-save").click();
  await expect(page.getByTestId("network-saved")).toBeVisible();
  // The app reads the Mainline DHT itself and the relays only with this on: the web peer's records are on the relay.
  const read = page.getByTestId("network-read-relays");
  if (await read.count() && !(await read.isChecked())) {
    await read.click();
    await expect(read).toBeChecked();
  }
  await page.evaluate(() => { location.hash = "#/"; });
  await expect(newChat(page)).toBeAttached();
}

/** "New chat": the list's own button on a phone (the tab bar may have one too). */
export const newChat = (page: Page) => page.locator('[title="New chat"]').filter({ visible: true }).first();

/** What a failed (or any) test leaves behind: the app's logcat lines, a screenshot of the page and of the device. */
async function collect(app: AndroidApp | null, adb: Adb, device: AndroidDevice, testInfo: TestInfo): Promise<void> {
  try {
    const logcat = adb.logcat();
    writeFileSync(testInfo.outputPath("logcat.txt"), logcat);
    const crashes = logcat.split("\n").filter((line) => /FATAL EXCEPTION|panicked at|SIGSEGV|SIGABRT/.test(line));
    if (crashes.length) testInfo.annotations.push({ type: "crash", description: crashes.slice(0, 3).join(" / ").slice(0, 600) });
    await testInfo.attach("logcat", { path: testInfo.outputPath("logcat.txt"), contentType: "text/plain" });
  } catch { /* a device gone mid-test: the screenshots may still come */ }
  try {
    if (app) await testInfo.attach("page", { body: await app.page.screenshot({ timeout: 10_000 }), contentType: "image/png" });
  } catch { /* the WebView is gone with its process */ }
  try {
    await testInfo.attach("device", { body: await device.screenshot(), contentType: "image/png" });
  } catch { /* nothing more to keep */ }
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  android: [async ({}, use) => {
    const serial = chooseSerial();
    if (!serial) {
      await use(null);
      return;
    }
    const adb = new Adb(serial);
    const apk = process.env.E2E_ANDROID_APK;
    if (apk) {
      if (!existsSync(apk)) throw new Error(`E2E_ANDROID_APK: no file at ${apk}`);
      install(adb, apk);
    } else if (!adb.tryRun("shell", "pm", "path", PKG).out.includes("package:")) {
      throw new Error(`${PKG} is not installed on ${serial}: set E2E_ANDROID_APK to the debug APK`);
    }
    const device = (await _android.devices()).find((d) => d.serial() === serial);
    if (!device) throw new Error(`Playwright sees no device ${serial}`);
    await use({ adb, device });
    await device.close().catch(() => {});
  }, { scope: "worker" }],

  relay: async ({}, use) => {
    const relay = new LocalRelay();
    await use(relay);
    relay.close();
  },

  relayUrl: async ({ relay, android }, use) => {
    const { adb } = needDevice(android);
    const url = await relay.listen();
    adb.reverse(portOf(url));
    await use(url);
    adb.unreverse(portOf(url));
  },

  app: async ({ android, relayUrl }, use, testInfo) => {
    const { adb, device } = needDevice(android);
    const iroh = irohRelay();
    if (iroh) adb.reverse(portOf(iroh));
    adb.run("shell", "am", "force-stop", PKG);
    adb.run("shell", "pm", "clear", PKG);
    adb.run("logcat", "-c");
    // Awake and unlocked: a screen left off by a test before would keep the activity from resuming.
    adb.tryRun("shell", "input", "keyevent", "KEYCODE_WAKEUP");
    adb.tryRun("shell", "wm", "dismiss-keyguard");
    let page: Page, pid: string;
    try {
      launch(adb, { GHOSTLY_PKARR_RELAYS: relayUrl, ...(iroh ? { GHOSTLY_IROH_RELAYS: iroh } : {}) });
      pid = adb.pid();
      if (!pid) throw new Error(`${PKG} is not running after am start`);
      page = await webViewPage(device, Number(pid));
      page.setDefaultTimeout(60_000);
      page.on("pageerror", (error) => console.log(`  [android] ${error.message}`));
      await expect(newChat(page), "the UI rendered").toBeAttached({ timeout: 120_000 });
      await useTestNetwork(page, relayUrl, iroh);
    } catch (error) {
      // The start itself failed: what the device said is all there is to go on.
      await collect(null, adb, device, testInfo);
      throw error;
    }
    const app: AndroidApp = {
      adb,
      device,
      page,
      peer: { name: "android", context: page.context(), page },
      pid,
      invoke: (command, args) => page.evaluate(([command, args]) => (window as unknown as { __TAURI_INTERNALS__: { invoke(c: string, a?: unknown): Promise<never> } }).__TAURI_INTERNALS__.invoke(command, args), [command, args] as const),
      background: () => void adb.run("shell", "input", "keyevent", "KEYCODE_HOME"),
      // Brought forward as the launcher's icon would (its intent and flags): the running task, not a new activity.
      foreground: () => void adb.run("shell", "am", "start", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", "-n", ACTIVITY, "-f", "0x10200000"),
    };
    await use(app);
    await collect(app, adb, device, testInfo);
    adb.tryRun("shell", "am", "force-stop", PKG);
    if (iroh) adb.unreverse(portOf(iroh));
  },

  webPeer: async ({ browser, relay, baseURL }, use) => {
    const opened: Peer[] = [];
    await use(async (name) => {
      const peer = await openPeer(browser, relay, baseURL!, name, { irohRelay: irohRelay() });
      opened.push(peer);
      return peer;
    });
    for (const peer of opened) await peer.context.close().catch(() => {});
  },
});

/**
 * The app makes a chat (New) and the web peer joins it with the invite the app shows: read from the card (the link the
 * QR holds), so pairing does not depend on the clipboard (the host spec checks that). Resolves once both are live.
 */
export async function pairWithWeb(app: AndroidApp, web: Peer): Promise<void> {
  await newChat(app.page).click();
  const link = app.page.getByTestId("invite-link");
  await expect(link).toHaveAttribute("title", /^https:\/\/ghostly\.tools\/#ghostly1/, { timeout: 120_000 });
  const invite = (await link.getAttribute("title"))!;
  const { pasteInvite } = await import("../../support/clipboard");
  await web.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
  await pasteInvite(web.page, invite);
  // Live on both sides: Iroh through the infra's relay, or WebRTC.
  for (const page of [app.page, web.page]) await expect(page.getByTestId("connection-options").filter({ visible: true }).first()).toHaveAccessibleName(/Connected · /, { timeout: 150_000 });
  for (const page of [app.page, web.page]) await expect(page.getByPlaceholder("Message…")).toBeEnabled();
}

/** Writes and sends with the Send button, as a thumb does: on a touch screen Enter may be a new line. */
export async function sayFromApp(app: AndroidApp, text: string): Promise<void> {
  await app.page.getByPlaceholder("Message…").fill(text);
  await app.page.getByRole("button", { name: "Send message", exact: true }).click();
}

/** The pairing scene's stage after New: "publishing" until the invite is written, then the stage that waits for the contact. */
export async function inviteStage(page: Page): Promise<string | null> {
  return await page.locator('[data-testid="pairing-scene"], [data-testid="pairing-glyph"]').first().getAttribute("data-stage");
}

/** `ActivityTaskManager: START u0 {…}` lines since the last `logcat -c`: every activity start the system was asked for. */
export function activityStarts(adb: Adb): string[] {
  return adb.logcat("-s", "ActivityTaskManager:I").split("\n").filter((line) => /START u0 \{/.test(line));
}
