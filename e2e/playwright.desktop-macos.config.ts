import { defineConfig } from "@playwright/test";

/**
 * Ghostly Desktop on macOS: two copies of the real app, in the system WKWebView, driven through the test driver
 * a debug build carries (support/desktopMac.ts) — macOS has no WebDriver for WKWebView, so the Linux harness
 * (playwright.desktop.config.ts) cannot run here. No browser and no web server.
 *
 *   npm run desktop:macos:build
 *   npm run test:e2e:desktop-macos
 *
 * macOS only. See README.md → "Desktop on macOS".
 */
export default defineConfig({
  testDir: "./desktop-macos",
  outputDir: "../test-results/desktop-macos",
  // The headless CLI the bots run, built once before the workers start (support/headlessBuild.ts).
  globalSetup: "./support/headlessBuild.ts",
  // Two apps and one relay per test, on fixed ports.
  workers: 1,
  forbidOnly: !!process.env.CI,
  // No retries: this job is on probation (dev pushes and nightly), and a flake has to show as one.
  retries: 0,
  timeout: 10 * 60_000,
  // In CI the whole run has a limit too, about 5 times what a green one takes (under 3 minutes): a test's own timeout
  // runs in its worker, so a worker that hangs never reaches it. Past this Playwright stops the worker and still writes
  // the report. Not here on a Mac: the measurements that run only when asked take over an hour.
  globalTimeout: process.env.CI ? 15 * 60_000 * Number(process.env.REPEAT || 1) : 0,
  expect: { timeout: 30_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "../playwright-report-desktop-macos" }], ["github"]]
    : [["list"], ["html", { open: "never", outputFolder: "../playwright-report-desktop-macos" }]],
});
