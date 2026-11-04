import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserHost } from "@ghostly/browser/host";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { UpdateProvider } from "../../contexts/UpdateContext";
import { androidApkUrl, desktopUpdates } from "../../desktop/updates";
import { saveSettings, loadSettings } from "../../lib/settings";
import { Settings } from "../../pages/Settings";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";

// covers: app.updates.desktop

/*
 * The Android app has no Tauri updater (it is granted on Desktop only), so a check there that asked for one failed
 * every time with "Command plugin:updater|check not allowed by ACL". It reads the newest version instead and offers
 * that release's APK.
 */

// `@tauri-apps/api/core` and `/app` are one stub in this config: mocked once, with both.
const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (command: string): Promise<unknown> => {
    if (command === "updater_can_install") return true;
    throw new Error(`Command ${command} not allowed by ACL`);
  }),
  getVersion: vi.fn(async () => "1.5.4"),
}));
const updater = vi.hoisted(() => ({
  check: vi.fn(async (): Promise<unknown> => {
    await tauri.invoke("plugin:updater|check");
    return null;
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, getVersion: tauri.getVersion, getIdentifier: async () => "tools.ghostly.app", listen: async () => () => {} }));
vi.mock("@tauri-apps/plugin-updater", () => updater);
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

const ANDROID_AGENT = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const realAgent = navigator.userAgent;

function feed(version: string) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ version }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function asAndroid() {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  Object.defineProperty(navigator, "userAgent", { value: ANDROID_AGENT, configurable: true });
}

beforeEach(() => {
  tauri.invoke.mockClear();
  updater.check.mockClear();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  Object.defineProperty(navigator, "userAgent", { value: realAgent, configurable: true });
  vi.unstubAllGlobals();
});

describe("the Android app's update check", () => {
  it("offers the newer release's APK, without asking the updater", async () => {
    asAndroid();
    const fetchMock = feed("1.6.0");
    expect(await desktopUpdates.check()).toEqual({
      version: "1.6.0",
      apply: "manual",
      downloadUrl: "https://github.com/MiguelMedeiros/ghostly/releases/download/v1.6.0/ghostly-1.6.0-android-arm64.apk",
    });
    expect(fetchMock).toHaveBeenCalledWith("https://ghostly.tools/latest.json", expect.anything());
    expect(updater.check).not.toHaveBeenCalled();
    expect(tauri.invoke).not.toHaveBeenCalledWith("plugin:updater|check");
  });

  it("finds nothing to offer when the newest release is the one running", async () => {
    asAndroid();
    feed("1.5.4");
    expect(await desktopUpdates.check()).toBeNull();
    expect(updater.check).not.toHaveBeenCalled();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("names the APK as the release workflow does", () => {
    expect(androidApkUrl("2.0.1")).toBe("https://github.com/MiguelMedeiros/ghostly/releases/download/v2.0.1/ghostly-2.0.1-android-arm64.apk");
  });
});

describe("the Desktop app's update check", () => {
  it("still asks Tauri's updater, and nothing else", async () => {
    const fetchMock = feed("9.9.9");
    const handle = { version: "1.6.0", body: "Notes" };
    updater.check.mockResolvedValueOnce(handle);
    expect(await desktopUpdates.check()).toEqual({ version: "1.6.0", notes: "Notes", apply: "restart", handle });
    expect(updater.check).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Settings → Updates in the Android app", () => {
  afterEach(() => { delete (fakeEngine as BrowserHost).updates; });

  function renderSettings() {
    (fakeEngine as BrowserHost).updates = desktopUpdates;
    saveSettings({ ...loadSettings(), checkForUpdates: false });
    return renderApp(
      <LockScreenProvider>
        <UpdateProvider>
          <Routes><Route path="/settings" element={<Settings />} /></Routes>
        </UpdateProvider>
      </LockScreenProvider>,
      { route: "/settings" },
    );
  }

  it("says the new version is out, with Download opening its APK", async () => {
    asAndroid();
    feed("1.6.0");
    const { user } = renderSettings();
    await user.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText("Ghostly 1.6.0 is available")).toBeInTheDocument();
    expect(screen.queryByText("Could not check for updates")).toBeNull();
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      "https://github.com/MiguelMedeiros/ghostly/releases/download/v1.6.0/ghostly-1.6.0-android-arm64.apk",
    );
  });

  it("says it is up to date on the newest version", async () => {
    asAndroid();
    feed("1.5.4");
    const { user } = renderSettings();
    await user.click(screen.getByRole("button", { name: "Check now" }));
    expect(await screen.findByText("Ghostly is up to date")).toBeInTheDocument();
    expect(screen.queryByText("Could not check for updates")).toBeNull();
  });
});
