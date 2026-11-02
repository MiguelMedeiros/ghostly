import { defineConfig, devices } from "@playwright/test";

/**
 * The site's own browser checks. Against a running site: WEBSITE_URL=http://localhost:4400 npm run test:e2e.
 * Without WEBSITE_URL they serve the build (npm run build first) on port 4401.
 */
const url = process.env.WEBSITE_URL;
const port = 4401;

export default defineConfig({
  testDir: ".",
  testMatch: /\.spec\.ts$/,
  outputDir: "../test-results",
  timeout: 60_000,
  workers: 2,
  fullyParallel: true,
  reporter: [["list"]],
  forbidOnly: !!process.env.CI,
  // A failure leaves its page as it was (error-context.md beside it), which CI keeps: one seen once is still readable.
  // Not a trace: recording one for every test made the scene specs about a fifth slower.
  use: { baseURL: url ?? `http://localhost:${port}`, screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } }, testIgnore: /phone/ },
    { name: "phone", use: { ...devices["Pixel 7"] }, testMatch: /phone.*\.spec\.ts$/ },
  ],
  webServer: url
    ? undefined
    : { command: `npx next start -p ${port}`, cwd: "..", url: `http://localhost:${port}`, reuseExistingServer: false, timeout: 60_000 },
});
