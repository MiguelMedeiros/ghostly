import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { fromBase64Url, verify } from "@ghostly/core";
import { DEVICE_KEY_SCRIPTS, deviceKeyBundle, type DeviceKeyAnswer } from "../support/deviceKeyBundle";

/**
 * The device signing key in a real engine (WISP 06 § Terms, § Measured, and still to measure): the app's own module
 * (`packages/browser/src/devices/signingKey.ts`) makes the key, and this checks what the engine did with it. Where the
 * engine has Ed25519 in WebCrypto the key must be non-extractable: export and wrap refused, no seed stored, and it
 * must still sign after a reload, after the browser was closed and opened again, and in a worker. Every signature is
 * verified here, outside the browser, with the library every reader uses.
 *
 * Chromium runs it in the main suite; WebKit through `npm run test:e2e:webkit` (the engine of Safari and of the
 * installed app on an iPhone; the Desktop's own WKWebView is `desktop-macos/device-signing-key.spec.ts`).
 * The page is a blank one on an origin of its own: nothing of the app is started, and no profile is touched.
 */

const ORIGIN = "https://device-key.ghostly.test";

/** The signature verifies, outside the browser, under the public key the page reported. */
function verified(answer: DeviceKeyAnswer): boolean {
  return verify(fromBase64Url(answer.signature), fromBase64Url(answer.message), fromBase64Url(answer.publicKey));
}

async function blankPage(context: BrowserContext, bundle: string): Promise<Page> {
  await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>device key</title>" }));
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(`${ORIGIN}/`);
  await page.addScriptTag({ content: bundle });
  return page;
}

test("the engine keeps a non-extractable Ed25519 device signing key: export and wrap refused, and it signs after a reload, after a browser restart and in a worker", {
  tag: ["@feature:devices.signing-key"],
}, async ({ playwright, browserName }, testInfo) => {
  const bundle = await deviceKeyBundle();
  const folder = mkdtempSync(join(tmpdir(), "ghostly-device-key-"));
  const launch = () => playwright[browserName].launchPersistentContext(folder, { headless: true });
  let context = await launch();
  try {
    let page = await blankPage(context, bundle);
    const version = context.browser()?.version() ?? await page.evaluate(() => navigator.userAgent);
    const check = await page.evaluate<{ supported: boolean; reason?: string }>(DEVICE_KEY_SCRIPTS.check);
    testInfo.annotations.push({ type: "engine", description: `${browserName} ${version}: non-extractable Ed25519 ${check.supported ? "supported" : `not supported (${check.reason})`}` });
    console.log(`[device-signing-key] ${browserName} ${version}: ${JSON.stringify(check)}`);
    expect(check).toEqual({ supported: true });

    // Made by the app's module: non-extractable, and signing.
    const made = (await page.evaluate<DeviceKeyAnswer | null>(DEVICE_KEY_SCRIPTS.use("ghostly", true)))!;
    expect(made.kind).toBe("webcrypto");
    expect(verified(made)).toBe(true);
    // What the engine stored: its own key object, not extractable, every export and a wrap refused, and no seed.
    expect(await page.evaluate(DEVICE_KEY_SCRIPTS.stored("ghostly"))).toEqual({ kind: "webcrypto", hasSeed: false, isCryptoKey: true, extractable: false, exported: [], wrapped: false });

    // After a reload: the same key, read from storage, signs.
    await page.reload();
    await page.addScriptTag({ content: bundle });
    const reloaded = (await page.evaluate<DeviceKeyAnswer | null>(DEVICE_KEY_SCRIPTS.use("ghostly", false)))!;
    expect(reloaded).toMatchObject({ kind: "webcrypto", publicKey: made.publicKey });
    expect(verified(reloaded)).toBe(true);

    // In a worker: the key is read from storage there and signs there.
    const worked = await page.evaluate<DeviceKeyAnswer | null, { source: string; use: string }>(({ source, use }) => new Promise((resolve, reject) => {
      const worker = new Worker(URL.createObjectURL(new Blob([`${source}\nself.onmessage = async () => { try { self.postMessage({ ok: await ${use} }); } catch (error) { self.postMessage({ error: String(error) }); } };`], { type: "text/javascript" })));
      worker.onmessage = (event) => { const data = event.data as { ok?: DeviceKeyAnswer | null; error?: string }; worker.terminate(); if (data.error) reject(new Error(data.error)); else resolve(data.ok ?? null); };
      worker.onerror = (event) => { reject(new Error(event.message)); };
      worker.postMessage(null);
    }), { source: bundle, use: DEVICE_KEY_SCRIPTS.use("ghostly", false) });
    expect(worked).toMatchObject({ kind: "webcrypto", publicKey: made.publicKey });
    expect(verified(worked!)).toBe(true);

    // After the browser was closed and opened again on the same storage.
    await context.close();
    context = await launch();
    page = await blankPage(context, bundle);
    const restarted = (await page.evaluate<DeviceKeyAnswer | null>(DEVICE_KEY_SCRIPTS.use("ghostly", false)))!;
    expect(restarted).toMatchObject({ kind: "webcrypto", publicKey: made.publicKey });
    expect(verified(restarted)).toBe(true);
    expect(await page.evaluate(DEVICE_KEY_SCRIPTS.stored("ghostly"))).toMatchObject({ kind: "webcrypto", extractable: false, exported: [], wrapped: false });

    // A profile with no key: a read makes none.
    expect(await page.evaluate(DEVICE_KEY_SCRIPTS.use("ghostly_other", false))).toBeNull();
  } finally {
    await context.close().catch(() => {});
    rmSync(folder, { recursive: true, force: true });
  }
});

test("the seed form of the device signing key, for an engine without Ed25519 in WebCrypto, is stored and signs the same way", {
  tag: ["@feature:devices.signing-key"],
}, async ({ playwright, browserName }) => {
  const bundle = await deviceKeyBundle();
  const folder = mkdtempSync(join(tmpdir(), "ghostly-device-key-"));
  const context = await playwright[browserName].launchPersistentContext(folder, { headless: true });
  try {
    const page = await blankPage(context, bundle);
    const made = (await page.evaluate<DeviceKeyAnswer | null>(DEVICE_KEY_SCRIPTS.use("ghostly", true, true)))!;
    expect(made.kind).toBe("seed");
    expect(verified(made)).toBe(true);
    expect(await page.evaluate(DEVICE_KEY_SCRIPTS.stored("ghostly"))).toMatchObject({ kind: "seed", hasSeed: true, extractable: null });
    await page.reload();
    await page.addScriptTag({ content: bundle });
    const reloaded = (await page.evaluate<DeviceKeyAnswer | null>(DEVICE_KEY_SCRIPTS.use("ghostly", false)))!;
    expect(reloaded).toMatchObject({ kind: "seed", publicKey: made.publicKey });
    expect(verified(reloaded)).toBe(true);
  } finally {
    await context.close().catch(() => {});
    rmSync(folder, { recursive: true, force: true });
  }
});
