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
  // Two apps and one relay per test, on fixed ports.
  workers: 1,
  forbidOnly: !!process.env.CI,
  // No retries: this job is on probation (dev pushes and nightly), and a flake has to show as one.
  retries: 0,
  timeout: 10 * 60_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "../playwright-report-desktop-macos" }], ["github"]]
    : [["list"], ["html", { open: "never", outputFolder: "../playwright-report-desktop-macos" }]],
});
