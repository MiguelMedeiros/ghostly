import { defineConfig, devices } from "@playwright/test";

/**
 * The current web app against a real older release (e2e/compat/): v0.4.0, built from its tag by
 * scripts/build-compat-web.mjs (about a minute the first time, cached after that) and served beside the
 * current build. Peers meet on the test's Pkarr relay, as in the main suite: nothing leaves the machine.
 *
 *   npm run test:e2e:compat
 *   E2E_WEB_PORT=50310 E2E_COMPAT_PORT=50311 npm run test:e2e:compat
 *
 * A config of its own because the main suite would otherwise wait on the old build for every run. It runs in
 * the E2E workflow (the release gate) and nightly in E2E (full); see e2e/README.md → "Compatibility".
 */
const port = Number(process.env.E2E_WEB_PORT || 4183);
const compatPort = Number(process.env.E2E_COMPAT_PORT || 4184);
const deployed = process.env.E2E_WEB_URL;

export default defineConfig({
  testDir: "./compat",
  outputDir: "../test-results/compat",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : Number(process.env.E2E_WORKERS) || 2,
  timeout: 4 * 60_000,
  expect: { timeout: 60_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "../playwright-report-compat" }], ["github"]]
    : [["list"], ["html", { open: "never", outputFolder: "../playwright-report-compat" }]],
  use: {
    baseURL: deployed ?? `http://localhost:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 30_000,
    ...devices["Desktop Chrome"],
    launchOptions: { args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] },
  },
  metadata: { compatURL: `http://localhost:${compatPort}` },
  webServer: [
    ...(deployed ? [] : [{
      command: `npm run build:web && npx vite preview web --port ${port} --strictPort`,
      cwd: "..",
      url: `http://localhost:${port}`,
      reuseExistingServer: !process.env.CI,
      timeout: 5 * 60_000,
    }]),
    {
      command: `node scripts/build-compat-web.mjs --tag v0.4.0 --serve ${compatPort}`,
      cwd: "..",
      url: `http://localhost:${compatPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 5 * 60_000,
    },
  ],
});
