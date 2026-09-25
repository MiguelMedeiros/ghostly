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
  use: { baseURL: url ?? `http://localhost:${port}` },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } }, testIgnore: /phone/ },
    { name: "phone", use: { ...devices["Pixel 7"] }, testMatch: /phone.*\.spec\.ts$/ },
  ],
  webServer: url
    ? undefined
    : { command: `npx next start -p ${port}`, cwd: "..", url: `http://localhost:${port}`, reuseExistingServer: false, timeout: 60_000 },
});
