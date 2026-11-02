import { execFileSync } from "node:child_process";
import { defineConfig, devices } from "@playwright/test";

/**
 * The current web app against real older releases (e2e/compat/): v0.4.0 (WISP 402), v1.1.4, the last release
 * without mini-apps (WISP 1200), v1.1.5, and the newest release, read from the tags, each built from its tag by
 * tools/scripts/build-compat-web.mjs (a minute or two the first time, cached after that) and served beside the current
 * build. The current build is the e2e suite's, with mini-apps on (VITE_APPS_TEST). Peers meet on the test's Pkarr
 * relay, as in the main suite: nothing leaves the machine.
 *
 *   npm run test:e2e:compat
 *   E2E_WEB_PORT=50310 E2E_COMPAT_PORT=50311 E2E_COMPAT_11_PORT=50312 E2E_COMPAT_115_PORT=50313 E2E_COMPAT_LATEST_PORT=50314 npm run test:e2e:compat
 *   E2E_COMPAT_LATEST=v1.7.2 npm run test:e2e:compat   # that release as the newest, without asking the remote
 *
 * A config of its own because the main suite would otherwise wait on the old build for every run. It runs in
 * the E2E workflow (the release gate) and nightly in E2E (full); see e2e/README.md → "Compatibility".
 */
const port = Number(process.env.E2E_WEB_PORT || 4183);
const compatPort = Number(process.env.E2E_COMPAT_PORT || 4184);
const compat11Port = Number(process.env.E2E_COMPAT_11_PORT || 4185);
const compat115Port = Number(process.env.E2E_COMPAT_115_PORT || 4186);
const compatLatestPort = Number(process.env.E2E_COMPAT_LATEST_PORT || 4187);
const deployed = process.env.E2E_WEB_URL;
// Kept in the environment: every worker loads this file again, and the specs name their tests by it (compat/release.ts).
const latest = (process.env.E2E_COMPAT_LATEST ||= execFileSync("node", ["tools/scripts/compat-latest-release.mjs"], { cwd: new URL("..", import.meta.url), encoding: "utf8" }).trim());

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
  // e2e/compat/release.ts opens a peer from `releases`.
  metadata: {
    compatURL: `http://localhost:${compatPort}`,
    releases: {
      "1.1.4": `http://localhost:${compat11Port}`,
      "1.1.5": `http://localhost:${compat115Port}`,
      [latest.replace(/^v/, "")]: `http://localhost:${compatLatestPort}`,
    },
  },
  webServer: [
    ...(deployed ? [] : [{
      command: `npm run build:web && npx vite preview apps/web --port ${port} --strictPort`,
      cwd: "..",
      url: `http://localhost:${port}`,
      reuseExistingServer: !process.env.CI,
      timeout: 5 * 60_000,
      // Mini-apps on, as in the main suite (apps/web/appsTestFlag.ts): v11.spec.ts sends an app card to v1.1.4.
      env: { VITE_APPS_TEST: "1" },
    }]),
    {
      command: `node tools/scripts/build-compat-web.mjs --tag v0.4.0 --serve ${compatPort}`,
      cwd: "..",
      url: `http://localhost:${compatPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 5 * 60_000,
    },
    {
      command: `node tools/scripts/build-compat-web.mjs --tag v1.1.4 --serve ${compat11Port}`,
      cwd: "..",
      url: `http://localhost:${compat11Port}`,
      reuseExistingServer: !process.env.CI,
      timeout: 5 * 60_000,
    },
    {
      command: `node tools/scripts/build-compat-web.mjs --tag v1.1.5 --serve ${compat115Port}`,
      cwd: "..",
      url: `http://localhost:${compat115Port}`,
      reuseExistingServer: !process.env.CI,
      timeout: 5 * 60_000,
    },
    {
      command: `node tools/scripts/build-compat-web.mjs --tag ${latest} --serve ${compatLatestPort}`,
      cwd: "..",
      url: `http://localhost:${compatLatestPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 5 * 60_000,
    },
  ],
});
