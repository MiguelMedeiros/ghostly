import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { device, installWebRTCFakes, type FakeMediaDevices } from "../../../../../packages/react/test/fakes";
import { MediaSettings } from "../../components/MediaSettings";
import { renderApp } from "../render";

// covers: settings.media

/*
 * Settings → Audio & video in the Android app, with the microphone or camera refused. The app has no browser, and once
 * Android stops asking ("Don't allow" twice) only Android's settings allow it again: the row says so and opens them,
 * as the composer's Camera does. A browser keeps its line, with nothing to open.
 */

const tauri = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

const ANDROID_APP = "Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36";
const ANDROID_DENIED = "Blocked. Allow the microphone and camera when Android asks, or in Android's settings for Ghostly.";
const BROWSER_DENIED = "Blocked. Allow the microphone and camera in your browser or system settings.";

let devices: FakeMediaDevices;
let uninstall: () => void;

/** The Android app: Tauri's page in Android's WebView. */
function androidApp() {
  (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID_APP);
}

beforeEach(() => {
  ({ devices, uninstall } = installWebRTCFakes());
  devices.devices = [device("audioinput", "mic", "Microphone"), device("videoinput", "cam", "Camera")];
  tauri.invoke.mockClear();
});

afterEach(() => {
  uninstall();
  delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("Settings → Audio & video with the microphone or camera refused", () => {
  it("in the Android app, the microphone's Test says to allow it in Android's settings, and Open settings opens them", async () => {
    androidApp();
    const { user } = renderApp(<MediaSettings />);
    await user.click(await screen.findByTestId("settings-microphone-test"));
    devices.userMedia[0].deny(new DOMException("denied", "NotAllowedError"));

    expect(await screen.findByTestId("settings-microphone-failed")).toHaveTextContent(ANDROID_DENIED);
    await user.click(within(screen.getByTestId("settings-microphone-row")).getByRole("button", { name: "Open settings" }));
    expect(tauri.invoke).toHaveBeenCalledWith("open_app_settings");
  });

  it("in the Android app, the camera's Preview says the same, with Open settings", async () => {
    androidApp();
    const { user } = renderApp(<MediaSettings />);
    await user.click(await screen.findByTestId("settings-camera-preview"));
    devices.userMedia[0].deny(new DOMException("denied", "NotAllowedError"));

    expect(await screen.findByTestId("settings-camera-failed")).toHaveTextContent(ANDROID_DENIED);
    expect(within(screen.getByTestId("settings-camera-row")).getByRole("button", { name: "Open settings" })).toBeInTheDocument();
    expect(within(screen.getByTestId("settings-microphone-row")).queryByRole("button", { name: "Open settings" }), "only the refused row").toBeNull();
  });

  it("in the Android app, Allow refused says the same, with Open settings", async () => {
    androidApp();
    devices.devices = [device("audioinput", "", ""), device("videoinput", "", "")];
    const { user } = renderApp(<MediaSettings />);
    await user.click(await screen.findByTestId("settings-media-allow"));
    devices.userMedia[0].deny(new DOMException("denied", "NotAllowedError"));

    expect(await screen.findByTestId("settings-media-denied")).toHaveTextContent(ANDROID_DENIED);
    await user.click(within(screen.getByTestId("settings-media-names")).getByRole("button", { name: "Open settings" }));
    expect(tauri.invoke).toHaveBeenCalledWith("open_app_settings");
  });

  it("in a browser on Android, the line stays the browser's, with nothing to open", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID_APP.replace("; wv", ""));
    const { user } = renderApp(<MediaSettings />);
    await user.click(await screen.findByTestId("settings-microphone-test"));
    devices.userMedia[0].deny(new DOMException("denied", "NotAllowedError"));

    expect(await screen.findByTestId("settings-microphone-failed")).toHaveTextContent(BROWSER_DENIED);
    expect(screen.queryByRole("button", { name: "Open settings" })).toBeNull();
  });

  it("in the Android app, a microphone that is just not there has no Open settings", async () => {
    androidApp();
    const { user } = renderApp(<MediaSettings />);
    await user.click(await screen.findByTestId("settings-microphone-test"));
    devices.userMedia[0].deny(new DOMException("gone", "NotFoundError"));

    expect(await screen.findByTestId("settings-microphone-failed")).toHaveTextContent("Could not open it. Check that Ghostly may use it.");
    expect(screen.queryByRole("button", { name: "Open settings" })).toBeNull();
  });
});
