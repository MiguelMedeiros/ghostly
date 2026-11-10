import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceMeta } from "@ghostly/core";
import { MessageInput } from "../../components/MessageInput";
import { renderApp } from "../render";
import { installFakeAudio, installFakeMedia, media, removeFakeMedia } from "./fakeMedia";

// covers: files.voice.record

/*
 * The voice message's microphone refused in the Android app. Android's RECORD_AUDIO dialog answered "Don't allow"
 * reaches the page as a NotAllowedError, and once Android no longer asks every press gets one at once. The line said
 * to allow it "in your browser or system settings", in an app with no browser, and offered no way there: the composer's
 * Camera in the same state says Android's settings and opens them (#5645).
 */

const tauri = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, listen: async () => () => {}, getVersion: async () => "0.4.0" }));

const onSend = vi.fn<(text: string) => Promise<string | null>>();
const onSendFile = vi.fn<(file: File, voice?: VoiceMeta) => Promise<string | null>>();
const ANDROID = "Mozilla/5.0 (Linux; Android 15; sdk_gphone64_x86_64 Build/AP3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36";
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

async function pressMic() {
  renderApp(<MessageInput onSend={onSend} onSendFile={onSendFile} />);
  fireEvent.pointerDown(screen.getByTestId("voice-record"), { pointerId: 1, pointerType: "touch", button: 0, clientX: 300, clientY: 500 });
  await wait(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  installFakeMedia();
  installFakeAudio();
  onSend.mockReset().mockResolvedValue(null);
  onSendFile.mockReset().mockResolvedValue(null);
  tauri.invoke.mockClear();
  media.deny();
});

afterEach(() => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.useRealTimers();
  removeFakeMedia();
  vi.restoreAllMocks();
});

describe("the voice message's microphone refused", () => {
  it("in the Android app: says Android's settings, and Open settings opens the app's page there", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID);
    await pressMic();

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("No access to the microphone. Allow it when Android asks, or in Android's settings for Ghostly.");
    expect(alert).not.toHaveTextContent(/browser/);
    fireEvent.click(within(alert).getByRole("button", { name: "Open settings" }));
    expect(tauri.invoke).toHaveBeenCalledWith("open_app_settings");
    expect(screen.queryByTestId("voice-bar")).not.toBeInTheDocument();
  });

  it("in a browser: the browser's line, with no Open settings", async () => {
    await pressMic();

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("No access to the microphone. Allow it in your browser or system settings.");
    expect(within(alert).queryByRole("button", { name: "Open settings" })).not.toBeInTheDocument();
  });
});
