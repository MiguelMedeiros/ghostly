import { expect, test } from "@playwright/test";
import { fromBase64Url, verify } from "@ghostly/core";
import { DEVICE_KEY_SCRIPTS, deviceKeyBundle, type DeviceKeyAnswer } from "../support/deviceKeyBundle";
import { forgetSharedData, openMacDesktop, type MacDesktop } from "../support/desktopMac";

/**
 * The device signing key in the Desktop's own WebView on a Mac (WISP 06 § Terms, § Measured, and still to measure):
 * WKWebView as Tauri hosts it, which Playwright's WebKit is not. The app's own key module runs in the Ghostly window
 * (`support/deviceKeyBundle.ts`), and this checks what WKWebView did with the key: made non-extractable, export and wrap
 * refused, no seed stored, and still signing after the page reloads and after the app is quit and opened again. Every
 * signature is verified here, outside the app. The key goes under a profile name of its own; the app's profile is not
 * touched.
 *
 *   npm run desktop:macos:build
 *   npm run test:e2e:desktop-macos -- device-signing-key
 */

// 49780-49784: this test's ports.
const PORTS = { app: 49780 };
const PROFILE = "ghostly-device-key-check";

const verified = (answer: DeviceKeyAnswer) => verify(fromBase64Url(answer.signature), fromBase64Url(answer.message), fromBase64Url(answer.publicKey));

/** Runs the app's key module and one of the scripts in the Ghostly window, and answers what it answered. */
async function inApp<T>(desktop: MacDesktop, script: string): Promise<T> {
  const bundle = await deviceKeyBundle();
  const answer = await desktop.app.executeAsync<{ value?: T; error?: string }>(
    `const done = arguments[arguments.length - 1];
     ${bundle}
     Promise.resolve(${script}).then((value) => done({ value }), (error) => done({ error: String(error && error.stack || error) }));`,
  );
  if (answer.error) throw new Error(answer.error);
  return answer.value as T;
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

test("the Desktop's WKWebView keeps a non-extractable Ed25519 device signing key, which signs after a reload and after the app is opened again", {
  tag: ["@client:desktop", "@feature:devices.signing-key"],
}, async ({}, testInfo) => {
  desktop = await openMacDesktop({ name: "device-key", port: PORTS.app });
  const engine = await desktop.app.execute<{ agent: string; secure: boolean; origin: string }>(`return { agent: navigator.userAgent, secure: window.isSecureContext, origin: location.origin };`);
  const check = await inApp<{ supported: boolean; reason?: string }>(desktop, DEVICE_KEY_SCRIPTS.check);
  testInfo.annotations.push({ type: "engine", description: `WKWebView (${engine.origin}, secure ${engine.secure}) ${engine.agent}: ${JSON.stringify(check)}` });
  console.log(`[device-signing-key] WKWebView ${engine.origin} secure=${engine.secure} ${engine.agent}: ${JSON.stringify(check)}`);
  expect(check).toEqual({ supported: true });

  const made = (await inApp<DeviceKeyAnswer | null>(desktop, DEVICE_KEY_SCRIPTS.use(PROFILE, true)))!;
  expect(made.kind).toBe("webcrypto");
  expect(verified(made)).toBe(true);
  expect(await inApp(desktop, DEVICE_KEY_SCRIPTS.stored(PROFILE))).toEqual({ kind: "webcrypto", hasSeed: false, isCryptoKey: true, extractable: false, exported: [], wrapped: false });

  // The page reloads: the key is read from storage and signs.
  await desktop.app.execute(`location.reload();`);
  await expect.poll(async () => { try { return await desktop!.app.execute<string>(`return document.readyState;`); } catch { return "reloading"; } }, { timeout: 30_000 }).toBe("complete");
  const reloaded = (await inApp<DeviceKeyAnswer | null>(desktop, DEVICE_KEY_SCRIPTS.use(PROFILE, false)))!;
  expect(reloaded).toMatchObject({ kind: "webcrypto", publicKey: made.publicKey });
  expect(verified(reloaded)).toBe(true);

  // The app quits and opens again, on the storage it left.
  await desktop.stop({ keep: true });
  desktop = await openMacDesktop({ name: "device-key", port: PORTS.app, keepData: true });
  const reopened = (await inApp<DeviceKeyAnswer | null>(desktop, DEVICE_KEY_SCRIPTS.use(PROFILE, false)))!;
  expect(reopened).toMatchObject({ kind: "webcrypto", publicKey: made.publicKey });
  expect(verified(reopened)).toBe(true);
  expect(await inApp(desktop, DEVICE_KEY_SCRIPTS.stored(PROFILE))).toMatchObject({ kind: "webcrypto", extractable: false, exported: [], wrapped: false });
});
