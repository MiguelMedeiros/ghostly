import { chromium } from "@playwright/test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, openPeer, type Peer } from "./fixtures";
import { test as base } from "./fixtures";

const dist = join(import.meta.dirname, "..", "..", "extension", "dist");

/** Where the extension asks what the newest release is (extension/src/updates.ts). */
export const LATEST_URL = "https://ghostly.tools/latest.json";

/**
 * The built extension, with the localhost permission granted up front: Chrome's
 * permission prompt cannot be clicked by automation. Everything else is the shipped code.
 */
function prepareExtension(work: string): string {
  if (!existsSync(join(dist, "manifest.json"))) throw new Error("extension/dist is missing: run `npm run build:extension` first (`npm run e2e` does)");
  const dir = join(work, "extension");
  cpSync(dist, dir, { recursive: true });
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.host_permissions = manifest.optional_host_permissions;
  delete manifest.optional_host_permissions;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

type Fixtures = {
  /** Ghostly Browser in a Chromium profile of its own; `ignoreHTTPSErrors` reaches its offscreen engine too. */
  extensionPeer: (name: string, options?: { ignoreHTTPSErrors?: boolean }) => Promise<Peer>;
  /** Ghostly on the web, for talking to the extension across hosts. */
  webPeer: (name: string) => Promise<Peer>;
};

export const test = base.extend<Fixtures>({
  extensionPeer: async ({ relay }, use) => {
    const work = mkdtempSync(join(tmpdir(), "ghostly-e2e-"));
    const extensionDir = prepareExtension(work);
    const opened: Peer[] = [];
    await use(async (name, options = {}) => {
      const context = await chromium.launchPersistentContext(join(work, name), {
        channel: "chromium",
        headless: !process.env.HEADED,
        ...(options.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}),
        viewport: { width: 1280, height: 720 },
        args: [
          `--disable-extensions-except=${extensionDir}`,
          `--load-extension=${extensionDir}`,
          "--disable-features=WebRtcHideLocalIpsWithMdns",
          "--use-fake-device-for-media-stream",
          "--use-fake-ui-for-media-stream",
          "--auto-select-desktop-capture-source=Entire screen",
          // The context option covers pages, not the extension's offscreen document, where its engine runs.
          ...(options.ignoreHTTPSErrors ? ["--ignore-certificate-errors"] : []),
        ],
      });
      // The update check is the one request that would leave this machine. Answer
      // it with the version that is running, so a test only sees one when it says so.
      const running = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8")).version;
      await context.route(LATEST_URL, (route) =>
        route.fulfill({
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: JSON.stringify({ version: running }),
        }),
      );

      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
      const extensionId = new URL(worker.url()).host;
      const page = await context.newPage();
      page.on("pageerror", (error) => console.log(`  [${name}] ${error.message}`));
      await page.goto(`chrome-extension://${extensionId}/app.html#/settings`);
      // The peer lives in an offscreen document, out of reach of request interception: point it at the relay instead.
      await page.getByTestId("network-relays").fill(await relay.listen());
      await page.getByTestId("network-save").click();
      await expect(page.getByText("Saved", { exact: true })).toBeVisible();
      await page.goto(`chrome-extension://${extensionId}/app.html#/`);
      await expect(page.getByTitle("New Chat")).toBeVisible();
      const peer = { name, context, page };
      opened.push(peer);
      return peer;
    });
    for (const peer of opened) await peer.context.close().catch(() => {});
    rmSync(work, { recursive: true, force: true });
  },
  webPeer: async ({ relay, baseURL }, use) => {
    const browser = await chromium.launch({
      channel: "chromium",
      headless: !process.env.HEADED,
      args: ["--disable-features=WebRtcHideLocalIpsWithMdns", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    });
    await use((name) => openPeer(browser, relay, baseURL!, name));
    await browser.close();
  },
});

export { expect };
