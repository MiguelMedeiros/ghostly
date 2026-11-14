import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string) => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

import { CallMediaProblem } from "../../components/CallMediaProblem";
import { renderApp } from "../render";

// covers: calls.media-blocked

const ANDROID = "Mozilla/5.0 (Linux; Android 15; sdk_gphone64_x86_64) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36";
const agent = navigator.userAgent;
const setAgent = (value: string) => Object.defineProperty(navigator, "userAgent", { value, configurable: true });
const inAndroidApp = () => {
  setAgent(ANDROID);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
};

afterEach(() => {
  setAgent(agent);
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  tauri.invoke.mockClear();
});

describe("a call with the microphone or camera refused", () => {
  // The Android app said "Allow them in your browser or system settings." and offered no way there; once Android no
  // longer asks, only its settings allow them again.
  it("in the Android app, says to allow them in Android's settings and opens the app's page there", async () => {
    inAndroidApp();
    const { user } = renderApp(<CallMediaProblem problem="denied" />);
    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("No access to the mic or camera");
    expect(notice).toHaveTextContent("Allow the microphone (and camera) in Android's settings for Ghostly.");
    expect(notice).not.toHaveTextContent("browser");
    await user.click(within(notice).getByRole("button", { name: "Open settings" }));
    expect(tauri.invoke).toHaveBeenCalledWith("open_app_settings");
  });

  it("in a browser on Android, keeps the browser line and offers no Open settings", () => {
    setAgent(ANDROID);
    renderApp(<CallMediaProblem problem="denied" />);
    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("Allow them in your browser or system settings.");
    expect(within(notice).queryByRole("button")).toBeNull();
  });

  it("in the Desktop app, keeps the browser line and offers no Open settings", () => {
    setAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15");
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    renderApp(<CallMediaProblem problem="denied" />);
    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("Allow them in your browser or system settings.");
    expect(within(notice).queryByRole("button")).toBeNull();
  });

  it("with none there, in the Android app, says so and offers no Open settings", () => {
    inAndroidApp();
    renderApp(<CallMediaProblem problem="unavailable" />);
    const notice = screen.getByRole("alert");
    expect(notice).not.toHaveTextContent("Android's settings");
    expect(within(notice).queryByRole("button")).toBeNull();
  });

  // A video call whose camera alone was refused, or the microphone alone: the note said "the mic or camera".
  it("names the camera when the call went on without it", () => {
    setAgent("Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0");
    renderApp(<CallMediaProblem problem="denied" of="camera" />);
    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("No access to the camera, so video is off");
    expect(notice).toHaveTextContent("Allow access in your browser or system settings.");
  });

  it("names the microphone when it was the microphone", () => {
    renderApp(<CallMediaProblem problem="unavailable" of="mic" />);
    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("No mic found");
    expect(notice).toHaveTextContent("Connect one, or close the app using it.");
  });

  it("is in every language", () => {
    inAndroidApp();
    renderApp(<CallMediaProblem problem="denied" />, { language: "pt" });
    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("Permita o microfone (e a câmera) nos ajustes do Android para o Ghostly.");
    expect(within(notice).getByRole("button", { name: "Abrir ajustes" })).toBeInTheDocument();
  });
});
