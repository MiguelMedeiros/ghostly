import { afterEach, describe, expect, it, vi } from "vitest";
import { appsEnabled, appsPlatform } from "../../lib/apps/flag";

// covers: apps.desktop-sandbox, apps.page

/* What each client's webview or browser calls itself. Desktop and the native Android app are the same frontend. */
const UA = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36",
};

/** This page as `agent` calls itself, inside Tauri (`desktop`) or in a browser. */
function as(agent: string, desktop: boolean) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(agent);
  if (desktop) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("appsPlatform: whether this client's platform runs apps", () => {
  it("is Desktop on macOS and Linux", () => {
    for (const agent of [UA.mac, UA.linux]) {
      as(agent, true);
      expect(appsPlatform()).toBe(true);
    }
  });

  it("is not Desktop on Windows, where app windows do not open yet, nor the native Android app, whose app commands are stubs", () => {
    for (const agent of [UA.windows, UA.android]) {
      as(agent, true);
      expect(appsPlatform()).toBe(false);
    }
  });

  it("leaves every browser to the web runner, on Windows and Android (the PWA too) included", () => {
    for (const agent of Object.values(UA)) {
      as(agent, false);
      expect(appsPlatform()).toBe(true);
    }
  });
});

describe("appsEnabled on those platforms", () => {
  it("is off on Desktop on Windows even in the e2e suite's build, and on in that build on macOS", () => {
    vi.stubEnv("VITE_APPS_TEST", "1");
    as(UA.windows, true);
    expect(appsEnabled()).toBe(false);
    as(UA.mac, true);
    expect(appsEnabled()).toBe(true);
  });
});
