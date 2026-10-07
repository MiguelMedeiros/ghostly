import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";

// The end-to-end environment's variables (npm run e2e:infra:up writes them; GHOSTLY_IROH_RELAY_URL is the one read
// here). A variable the shell already set wins.
const infraEnv = join(import.meta.dirname, "..", "..", ".env.e2e");
if (existsSync(infraEnv)) process.loadEnvFile(infraEnv);

/**
 * End-to-end tests for the native Android app (apps/desktop built for Android, docs/ANDROID.md) on an emulator: the
 * debug APK, driven over adb inside its WebView by Playwright's `_android` (support/android.ts). Its contact is a web
 * peer, a Chromium page on this machine running the built web app, so the web server is here as in
 * e2e/playwright.config.ts; its own config, so the web and extension runs never wait on an emulator. One device, so
 * one worker. CI: .github/workflows/android-e2e.yml.
 *
 *   npm run tauri -- android build --debug --apk --target x86_64
 *   emulator -avd <an API 35 x86_64 AVD> -port 5556 -no-snapshot &
 *   E2E_ANDROID_SERIAL=emulator-5556 E2E_ANDROID_APK=<the APK under apps/desktop/gen/android/app/build/outputs/apk> \
 *     npx playwright test -c e2e/android/playwright.config.ts
 *
 * Every test clears the app's data on that device (`pm clear`): name an emulator, not a phone with a profile on it.
 *
 * GHOSTLY_IROH_RELAY_URL (the e2e infra's Iroh relay, http://127.0.0.1:47085) gives both sides Iroh through it; without
 * it a chat goes live over WebRTC only. The specs about the Android host (A1: links, clipboard, notifications, share,
 * deep links) skip while the app has none (support/android.ts `skipUntilA1`).
 */
const deployed = process.env.E2E_WEB_URL;
const port = Number(process.env.E2E_WEB_PORT || 4173);

export default defineConfig({
  testDir: ".",
  outputDir: "../../test-results/android",
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // A start after `pm clear` takes 10 to 20 s on the emulator, and an invite as long to publish (docs/ANDROID.md).
  timeout: 5 * 60_000,
  expect: { timeout: 60_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "../../test-results/android-report" }], ["github"]]
    : [["list"], ["html", { open: "never", outputFolder: "../../test-results/android-report" }]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: deployed ?? `http://localhost:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 30_000,
    serviceWorkers: "block",
    launchOptions: { args: ["--disable-features=WebRtcHideLocalIpsWithMdns", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  },
  webServer: deployed
    ? undefined
    : {
        command: `npm run build:web && npx vite preview apps/web --port ${port} --strictPort`,
        cwd: "../..",
        url: `http://localhost:${port}`,
        reuseExistingServer: !process.env.CI,
        timeout: 5 * 60_000,
      },
});
