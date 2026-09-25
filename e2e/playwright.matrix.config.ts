import { defineConfig, devices } from "@playwright/test";
import { OIDC_TEST_ISSUER } from "./support/oidcIssuer";

/**
 * The combination matrix (e2e/matrix/): generated scenarios, each one a pair of
 * people on a combination of clients, delivery, wallet, identity, groups,
 * profile, locale and viewport. Run it through `npm run e2e:matrix`, which
 * builds, loads `.env.e2e` and passes `--only`, `--shard` and the rest here.
 *
 * Its own config, not a project of playwright.config.ts: it serves its own
 * build on its own port (47300, never the shared 4173) and reports the matrix
 * on its own (matrix/reporter.ts).
 */
const deployed = process.env.E2E_WEB_URL;
const port = Number(process.env.MATRIX_WEB_PORT ?? 47300);

export default defineConfig({
  testDir: "./matrix",
  testMatch: "*.spec.ts",
  outputDir: "../test-results/matrix",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // A retry would hide exactly what the matrix is for: a combination that fails.
  retries: 0,
  workers: Number(process.env.MATRIX_WORKERS) || (process.env.CI ? 3 : 2),
  // A scenario is a whole story (pair, talk, pay, go offline, restore): minutes, not seconds.
  timeout: 8 * 60_000,
  expect: { timeout: 60_000 },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "../playwright-report-matrix" }],
    ["./matrix/reporter.ts", { outputDir: "../test-results/matrix-summary" }],
    ...(process.env.CI ? [["github"] as ["github"], ["blob", { outputDir: "../blob-report-matrix" }] as ["blob", { outputDir: string }]] : []),
  ],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: deployed ?? `http://localhost:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 30_000,
    launchOptions: {
      args: [
        "--disable-features=WebRtcHideLocalIpsWithMdns",
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
  },
  webServer: deployed
    ? undefined
    : {
        command: `npm run build:web && npx vite preview web --port ${port} --strictPort`,
        cwd: "..",
        url: `http://localhost:${port}`,
        reuseExistingServer: !process.env.CI,
        timeout: 5 * 60_000,
        // The same build the suite tests: the local OIDC issuer and the SDK example's adapters.
        env: { VITE_OIDC_TEST_ISSUER: OIDC_TEST_ISSUER, GHOSTLY_PLUGINS: "examples/sdk-adapter/src/index.ts" },
      },
});
