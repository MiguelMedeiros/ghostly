import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceMeta } from "@ghostly/core";
import { MessageInput } from "../../components/MessageInput";
import { renderApp } from "../render";
import { installFakeAudio, installFakeMedia, media, removeFakeMedia } from "./fakeMedia";

// covers: files.voice.record

const onSend = vi.fn<(text: string) => Promise<string | null>>();
const onSendFile = vi.fn<(file: File, voice?: VoiceMeta) => Promise<string | null>>();
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const mouse = { pointerId: 1, pointerType: "mouse", button: 0, clientX: 300, clientY: 500 };
const ANDROID = "Mozilla/5.0 (Linux; Android 15; sdk_gphone64_x86_64 Build/AP3A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36";

/** Home, or the screen off: the page goes out of sight. */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  document.dispatchEvent(new Event("visibilitychange"));
}

async function recordHandsFree() {
  renderApp(<MessageInput onSend={onSend} onSendFile={onSendFile} />);
  const mic = screen.getByTestId("voice-record");
  fireEvent.pointerDown(mic, mouse);
  await wait(0);
  fireEvent.pointerUp(mic, mouse);
  fireEvent.click(screen.getByTestId("voice-send"));
  await wait(0);
  expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-phase", "recording");
}

beforeEach(() => {
  vi.useFakeTimers();
  installFakeMedia();
  installFakeAudio();
  onSend.mockReset().mockResolvedValue(null);
  onSendFile.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  setHidden(false);
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.useRealTimers();
  removeFakeMedia();
  vi.restoreAllMocks();
});

describe("a hands-free voice recording out of sight", () => {
  it("pauses in the Android app, where the microphone goes silent, and sends only what was recorded", async () => {
    // Android silences the microphone of an app out of sight, and the page is never told: the rest would be silence.
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ANDROID);
    await recordHandsFree();
    await wait(5_000);

    setHidden(true);
    await wait(30_000);
    setHidden(false);
    await wait(0);

    const bar = screen.getByTestId("voice-bar");
    expect(bar).toHaveAttribute("data-phase", "paused");
    expect(screen.getByTestId("voice-preview")).toBeInTheDocument();
    expect(screen.getByTestId("voice-timer")).toHaveTextContent("0:05");
    expect(media.recorders[0].state).toBe("paused");

    fireEvent.click(screen.getByTestId("voice-send"));
    await wait(0);
    expect(onSendFile).toHaveBeenCalledOnce();
    expect(onSendFile.mock.calls[0][1]?.duration).toBe(5_000);
  });

  it("keeps recording elsewhere (desktop, a browser), where the microphone still hears", async () => {
    await recordHandsFree();
    await wait(5_000);
    setHidden(true);
    await wait(30_000);
    setHidden(false);
    await wait(0);

    expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-phase", "recording");
    fireEvent.click(screen.getByTestId("voice-send"));
    await wait(0);
    expect(onSendFile.mock.calls[0][1]?.duration).toBe(35_000);
  });
});
