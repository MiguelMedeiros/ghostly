import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";

// The end-to-end environment's variables (npm run e2e:infra:up writes them; see e2e/infra/env.mjs). Loaded
// before anything reads the environment; a variable the shell already set wins.
const infraEnv = join(import.meta.dirname, "..", ".env.e2e");
if (existsSync(infraEnv)) process.loadEnvFile(infraEnv);

const { OIDC_TEST_ISSUER } = await import("./support/oidcIssuer");

/**
 * End-to-end tests for Ghostly: real browsers, the shipped build, no servers.
 * Peers find each other through a Pkarr relay that lives in the test process
 * (see support/relay.ts), so nothing here needs the network except the tests
 * tagged @network (the public Cashu test mint, the public relays).
 *
 *   npm run e2e                       # everything, against a fresh build of the web app
 *   npm run e2e -- --grep-invert @network
 *   E2E_WEB_URL=https://app.ghostly.tools npm run e2e -- --project web   # a deployed app
 *   npm run e2e:ui                    # watch and debug
 *   npm run e2e:full                  # every gated suite too, against e2e/infra (see e2e/README.md)
 */
const deployed = process.env.E2E_WEB_URL;
const port = Number(process.env.E2E_WEB_PORT || 4173);

export default defineConfig({
  testDir: ".",
  outputDir: "../test-results/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  // Two peers find each other by polling every few seconds: messages take seconds, not milliseconds.
  timeout: 3 * 60_000,
  expect: { timeout: 60_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "../playwright-report" }], ["github"]] : [["list"], ["html", { open: "never", outputFolder: "../playwright-report" }]],
  use: {
    baseURL: deployed ?? `http://localhost:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 30_000,
  },
  projects: [
    {
      name: "web",
      testDir: "./web",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: [
            // Every peer is on this machine: let ICE use plain host addresses.
            "--disable-features=WebRtcHideLocalIpsWithMdns",
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
            // getDisplayMedia without a person to pick the source.
            "--auto-select-desktop-capture-source=Entire screen",
          ],
        },
      },
    },
    {
      name: "extension",
      testDir: "./extension",
      // One persistent profile per peer, extension loaded: slower, and they share this machine's ports.
      fullyParallel: false,
    },
  ],
  webServer: deployed
    ? undefined
    : {
        command: `npm run build:web && npx vite preview web --port ${port} --strictPort`,
        cwd: "..",
        url: `http://localhost:${port}`,
        reuseExistingServer: !process.env.CI,
        timeout: 5 * 60_000,
        // The suite's build knows the local OIDC issuer (support/oidcIssuer.ts) and carries the SDK example's
        // adapters (web/sdk-plugin.spec.ts); a release build does neither.
        env: { VITE_OIDC_TEST_ISSUER: OIDC_TEST_ISSUER, GHOSTLY_PLUGINS: "examples/sdk-adapter/src/index.ts" },
      },
});
