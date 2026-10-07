import { defineConfig, devices } from "@playwright/test";

/**
 * The web app in WebKit: the engine of Safari, of the iPhone's installed app and of the macOS desktop app's WebView.
 * Only the specs that depend on what WebKit does differently with storage and files (where a stored Blob can be
 * read, the origin-private file system, a download from a file in storage): profile backups to a file. And the
 * mini-app sandbox (apps-sandbox.spec.ts): the runner has to hold in every engine the web app runs in.
 *
 *   npm run test:e2e:webkit
 *   E2E_WEB_PORT=50310 npm run test:e2e:webkit
 *
 * A config of its own: the main suite's fixtures and specs are written for Chromium (fake media devices, clipboard
 * permissions), and its CI installs Chromium only. Run it locally when you touch backups; see e2e/README.md.
 */
const port = Number(process.env.E2E_WEB_PORT || 4173);
const deployed = process.env.E2E_WEB_URL;

export default defineConfig({
  testDir: "./web",
  testMatch: ["profile-backup-file.spec.ts", "device-signing-key.spec.ts", "apps-sandbox.spec.ts", "apps-chess.spec.ts"],
  outputDir: "../test-results/webkit",
  globalSetup: "./support/headlessBuild.ts",
  // One test at a time: Playwright's WebKit keeps one origin-private file system per origin for every browser profile
  // it opens, so two tests at once would write and delete each other's files (each test empties it as it starts).
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 3 * 60_000,
  expect: { timeout: 60_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Safari"],
    baseURL: deployed ?? `http://localhost:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 30_000,
    serviceWorkers: "block",
  },
  webServer: deployed
    ? undefined
    : {
        command: `npm run build:web && npx vite preview apps/web --port ${port} --strictPort`,
        cwd: "..",
        url: `http://localhost:${port}`,
        reuseExistingServer: !process.env.CI,
        timeout: 5 * 60_000,
        // The mini-app sandbox spec runs apps through the e2e build's hook (apps/web/appsTestFlag.ts).
        env: { VITE_APPS_TEST: "1" },
      },
});
