import { defineConfig, devices } from "@playwright/test";

/**
 * The web app in Firefox, for the specs whose answer depends on each engine: the mini-app sandbox
 * (apps-sandbox.spec.ts, WISP 1200), and a contact's shared app opened on the web (services-web-open.spec.ts: Firefox's
 * `Request` has no body stream, so the services worker reads what the app sends another way). The main suite's fixtures
 * are written for Chromium, and CI installs Chromium only, so it runs locally:
 *
 *   npx playwright install firefox
 *   E2E_WEB_PORT=50310 npx playwright test -c e2e/playwright.firefox.config.ts
 */
const port = Number(process.env.E2E_WEB_PORT || 4173);
const deployed = process.env.E2E_WEB_URL;

export default defineConfig({
  testDir: "./web",
  testMatch: ["apps-sandbox.spec.ts", "apps-chess.spec.ts", "services-web-open.spec.ts"],
  outputDir: "../test-results/firefox",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 3 * 60_000,
  expect: { timeout: 60_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Firefox"],
    baseURL: deployed ?? `http://localhost:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 30_000,
    serviceWorkers: "block",
    // Firefox leaves loopback out of WebRTC: the listeners are on 127.0.0.1, and the control must reach them.
    launchOptions: { firefoxUserPrefs: { "media.peerconnection.ice.loopback": true } },
  },
  webServer: deployed
    ? undefined
    : {
        command: `npm run build:web && npx vite preview apps/web --port ${port} --strictPort`,
        cwd: "..",
        url: `http://localhost:${port}`,
        reuseExistingServer: !process.env.CI,
        timeout: 5 * 60_000,
        // A contact's shared app opens on `<label>.localhost`, as in the main suite (e2e/playwright.config.ts).
        env: { VITE_APPS_TEST: "1", VITE_SERVICES_HOST: `http://*.localhost:${port}`, VITE_SERVICES_APP_ORIGIN: `http://localhost:${port}` },
      },
});
