import { defineConfig } from "@playwright/test";

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
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.CAPTURE_URL ?? "http://localhost:4332",
    actionTimeout: 30_000,
    launchOptions: {
      args: [
        // Both peers are on this machine: let ICE use plain host addresses.
        "--disable-features=WebRtcHideLocalIpsWithMdns",
        // The calls ring with Chromium's fake camera and microphone, no prompt.
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
  },
});
