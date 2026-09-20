import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests for Ghostly Desktop: the real bundled app, driven through
 * WebDriver by `tauri-driver` (see support/desktop.ts). No browser, no web
 * server, no network — so it is a config of its own rather than a third
 * project in playwright.config.ts, whose web server every project would pay for.
 *
 *   npm run tauri -- build --debug --no-bundle
 *   npm run test:e2e:desktop
 *
 * Linux and Windows only: macOS has no WebDriver for WKWebView. See README.md.
 */
export default defineConfig({
  testDir: "./desktop",
  outputDir: "../test-results/desktop",
  // One app, one window, one machine.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // The app boots a peer before the UI settles: seconds, not milliseconds.
  timeout: 3 * 60_000,
  expect: { timeout: 60_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "../playwright-report-desktop" }], ["github"]]
    : [["list"], ["html", { open: "never", outputFolder: "../playwright-report-desktop" }]],
});
