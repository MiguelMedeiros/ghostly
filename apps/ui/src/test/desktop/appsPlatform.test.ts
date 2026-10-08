import { afterEach, describe, expect, it, vi } from "vitest";

// covers: apps.desktop-sandbox, apps.page

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
  listen: async () => () => {},
  getIdentifier: async () => "tools.ghostly.app",
  convertFileSrc: (path: string) => path,
  Channel: class {},
}));

import { desktopAppsOptions } from "../../desktop/host";
import { appsAvailable, appsPlatform } from "../../lib/apps/flag";

/* What each client's webview or browser calls itself. Desktop and the native Android app are the same frontend. */
const UA = {
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
};

afterEach(() => vi.unstubAllEnvs());

describe("appsPlatform: whether this client's platform runs apps", () => {
  it("is Desktop on macOS and Linux", () => {
    expect(appsPlatform(UA.mac, true)).toBe(true);
    expect(appsPlatform(UA.linux, true)).toBe(true);
  });

  it("is not Desktop on Windows, where app windows do not open yet", () => {
    expect(appsPlatform(UA.windows, true)).toBe(false);
  });

  it("is not the native mobile app (Android, or iOS), whose app commands are stubs", () => {
    expect(appsPlatform(UA.android, true)).toBe(false);
    expect(appsPlatform(UA.iphone, true)).toBe(false);
  });

  it("leaves every browser to the web runner: Windows, Android (the TWA too), the iPhone", () => {
    for (const agent of Object.values(UA)) expect(appsPlatform(agent, false)).toBe(true);
  });
});

describe("appsAvailable with the platform rule", () => {
  const on = { enabled: true, platform: true, runner: "ghostly-app://localhost/", opener: async () => {}, runnerPolicy: true } as const;
  it("is off where the platform runs no apps, whatever else holds", () => {
    expect(appsAvailable(on)).toBe("on");
    expect(appsAvailable({ ...on, platform: false })).toBe("off");
    expect(appsAvailable({ ...on, platform: false, runnerPolicy: undefined })).toBe("off");
  });
});

describe("the Desktop engine's apps option", () => {
  it("is off on Windows and in the native mobile app, even in the e2e suite's build", () => {
    vi.stubEnv("VITE_APPS_TEST", "1");
    expect(desktopAppsOptions(UA.windows, true)).toEqual({ apps: false });
    expect(desktopAppsOptions(UA.android, true)).toEqual({ apps: false });
    expect(desktopAppsOptions(UA.iphone, true)).toEqual({ apps: false });
  });

  it("is the e2e build's test store on macOS and Linux, and the flag's default otherwise", () => {
    vi.stubEnv("VITE_APPS_TEST", "1");
    for (const agent of [UA.mac, UA.linux]) {
      const options = desktopAppsOptions(agent, true);
      expect(options.apps).toBe(true);
      expect(typeof options.appFetch).toBe("function");
    }
    vi.stubEnv("VITE_APPS_TEST", "");
    expect(desktopAppsOptions(UA.mac, true)).toEqual({});
    expect(desktopAppsOptions(UA.linux, true)).toEqual({});
  });
});
