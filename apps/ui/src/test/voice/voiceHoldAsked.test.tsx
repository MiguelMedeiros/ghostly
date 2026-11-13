import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceMeta } from "@ghostly/core";
import { MessageInput } from "../../components/MessageInput";
import { renderApp } from "../render";
import { installFakeAudio, installFakeMedia, media, removeFakeMedia } from "./fakeMedia";

// covers: files.voice.record

/**
 * The iPhone's web app (iOS asks for the microphone again at each launch) and any browser that asks first: its question
 * comes up over the page while the mic is held. On iOS the touch then never ends for the page (no pointerup, no
 * pointercancel), so the recording ran on in hold mode with no finger on it and no way to send: it looked like it
 * recorded, and letting go sent nothing. Where the question does take the touch (a cancel, or a release to answer it),
 * the press was thrown away and the microphone allowed for nothing.
 */

const onSend = vi.fn<(text: string) => Promise<string | null>>();
const onSendFile = vi.fn<(file: File, voice?: VoiceMeta) => Promise<string | null>>();
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const touch = { pointerId: 1, pointerType: "touch", button: 0, clientX: 300, clientY: 500 };
const mic = () => screen.getByTestId("voice-record");

let answer: () => void;
/** The microphone answers only once `answer()` is called: the person is reading the browser's question. */
function askingMicrophone() {
  const ready = new Promise<void>((resolve) => { answer = resolve; });
  const real = media.getUserMedia.getMockImplementation()!;
  media.getUserMedia.mockImplementation(async (constraints) => { await ready; return real(constraints); });
}

function permission(state: PermissionState | "unsupported") {
  const query = state === "unsupported"
    ? vi.fn(async () => { throw new TypeError("'microphone' is not a valid value for enumeration PermissionName."); })
    : vi.fn(async () => ({ state }) as PermissionStatus);
  Object.defineProperty(navigator, "permissions", { configurable: true, value: { query } });
  return query;
}

async function tapSend() {
  const send = screen.getByTestId("voice-send");
  fireEvent.pointerDown(send, { ...touch, pointerId: 2 });
  fireEvent.pointerUp(send, { ...touch, pointerId: 2 });
  fireEvent.click(send);
  await wait(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  installFakeMedia();
  installFakeAudio();
  onSend.mockReset().mockResolvedValue(null);
  onSendFile.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  removeFakeMedia();
  Reflect.deleteProperty(navigator, "permissions");
  vi.restoreAllMocks();
});

describe("holding the mic while the browser asks for the microphone", () => {
  it("records hands-free once allowed when the touch never ends for the page (iPhone web app), and a tap sends it", async () => {
    const query = permission("prompt");
    askingMicrophone();
    renderApp(<MessageInput onSend={onSend} onSendFile={onSendFile} />);
    fireEvent.pointerDown(mic(), touch);
    await wait(0);
    // The question is up; the finger lifts to answer it, and the page hears nothing of it.
    await wait(2_500);
    answer();
    await wait(0);
    const bar = screen.getByTestId("voice-bar");
    expect(bar).toHaveAttribute("data-mode", "locked");
    expect(bar).toHaveAttribute("data-phase", "recording");
    expect(query).toHaveBeenCalledWith({ name: "microphone" });
    await wait(3_000);
    await tapSend();
    expect(onSendFile).toHaveBeenCalledOnce();
    expect(onSendFile.mock.calls[0][1]!.duration).toBeGreaterThanOrEqual(3_000);
    expect(screen.queryByTestId("voice-bar")).not.toBeInTheDocument();
  });

  it("keeps the recording, hands-free, when the question takes the touch", async () => {
    permission("prompt");
    askingMicrophone();
    renderApp(<MessageInput onSend={onSend} onSendFile={onSendFile} />);
    fireEvent.pointerDown(mic(), touch);
    await wait(150);
    fireEvent.pointerCancel(mic(), touch);
    await wait(0);
    expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-mode", "locked");
    answer();
    await wait(2_000);
    expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-phase", "recording");
    expect(media.released()).toBe(false);
    await tapSend();
    expect(onSendFile).toHaveBeenCalledOnce();
  });

  it("keeps the recording, hands-free, when the finger lets go to answer the question", async () => {
    permission("prompt");
    askingMicrophone();
    renderApp(<MessageInput onSend={onSend} onSendFile={onSendFile} />);
    fireEvent.pointerDown(mic(), touch);
    await wait(900);
    fireEvent.pointerUp(mic(), touch);
    await wait(0);
    expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-mode", "locked");
    expect(screen.queryByTestId("voice-hint")).not.toBeInTheDocument();
    answer();
    await wait(2_000);
    await tapSend();
    expect(onSendFile).toHaveBeenCalledOnce();
  });

  it("a refused question still says so and records nothing", async () => {
    permission("prompt");
    media.deny();
    renderApp(<MessageInput onSend={onSend} onSendFile={onSendFile} />);
    fireEvent.pointerDown(mic(), touch);
    await wait(0);
    expect(screen.getByRole("alert")).toHaveTextContent("No access to the microphone");
    expect(screen.queryByTestId("voice-bar")).not.toBeInTheDocument();
  });

  it("without the Permissions API, a microphone that took a person's time to answer records hands-free too", async () => {
    permission("unsupported");
    askingMicrophone();
    renderApp(<MessageInput onSend={onSend} onSendFile={onSendFile} />);
    fireEvent.pointerDown(mic(), touch);
    await wait(2_000);
    answer();
    await wait(0);
    expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-mode", "locked");
    await wait(2_000);
    await tapSend();
    expect(onSendFile).toHaveBeenCalledOnce();
  });

  it("a microphone already allowed is held and sent on release as before", async () => {
    permission("granted");
    renderApp(<MessageInput onSend={onSend} onSendFile={onSendFile} />);
    fireEvent.pointerDown(mic(), touch);
    await wait(0);
    expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-mode", "hold");
    await wait(2_000);
    fireEvent.pointerUp(mic(), touch);
    await wait(0);
    expect(onSendFile).toHaveBeenCalledOnce();
  });
});
