import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BROWSER_ARGS } from "./helpers";

// The shared regtest environment's variables (npm run e2e:infra:use -- --host one writes them): the
// wallets are funded from there. A variable the shell already set wins.
const infraEnv = join(import.meta.dirname, "../../..", ".env.e2e");
if (existsSync(infraEnv)) process.loadEnvFile(infraEnv);

/**
 * Marketing screenshots of the web client, taken by the three specs beside this file.
 * Serve the built app first, then point CAPTURE_URL at it (see README.md):
 *
 *   npm run build:web && npx vite preview web --port 4332 --strictPort
 *   SHOTS=website/public/screenshots/current CAPTURE_URL=http://localhost:4332 \
 *     npx playwright test -c website/scripts/capture/playwright.config.ts
 */
export default defineConfig({
  testDir: ".",
  testMatch: /\.spec\.ts$/,
  outputDir: "../../../test-results/capture",
  // A spec walks two peers through most of the app; the wallet waits on public mints.
  timeout: 12 * 60_000,
  expect: { timeout: 60_000 },
  // Each test drives several people at once; other sessions share this machine.
  workers: Number(process.env.CAPTURE_WORKERS) || 2,
  reporter: [["list"]],
  use: {
    baseURL: process.env.CAPTURE_URL ?? "http://localhost:4380",
    actionTimeout: 30_000,
    launchOptions: { args: BROWSER_ARGS },
  },
});
