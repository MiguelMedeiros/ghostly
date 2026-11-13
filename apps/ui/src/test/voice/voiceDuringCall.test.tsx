import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceMeta } from "@ghostly/core";
import { setCallOn } from "../../../../../packages/react/src/callRegistry";
import { MessageInput } from "../../components/MessageInput";
import { renderApp } from "../render";
import { installFakeAudio, installFakeMedia, media, removeFakeMedia } from "./fakeMedia";

// covers: files.voice.record

const onSend = vi.fn<(text: string) => Promise<string | null>>();
const onSendFile = vi.fn<(file: File, voice?: VoiceMeta) => Promise<string | null>>();
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const mouse = { pointerId: 1, pointerType: "mouse", button: 0, clientX: 300, clientY: 500 };
const touch = { pointerId: 2, pointerType: "touch", button: 0, clientX: 300, clientY: 500 };
/** A call in another chat (or this one): its own key in the app's call registry. */
const call = Symbol("call");

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
  act(() => setCallOn(call, null));
  vi.useRealTimers();
  removeFakeMedia();
  vi.restoreAllMocks();
});

describe("a voice recording when a call goes on", () => {
  it("pauses hands-free, so the call is neither recorded nor sent at the 15-minute limit", async () => {
    await recordHandsFree();
    await wait(5_000);

    act(() => setCallOn(call, () => {}));
    await wait(20 * 60_000);

    const bar = screen.getByTestId("voice-bar");
    expect(bar).toHaveAttribute("data-phase", "paused");
    expect(media.recorders[0].state).toBe("paused");
    expect(screen.getByTestId("voice-timer")).toHaveTextContent("0:05");
    expect(onSendFile).not.toHaveBeenCalled();
    // Resume waits for the call to end: pressing it then would record the call again.
    expect(screen.getByTestId("voice-pause")).toBeDisabled();

    act(() => setCallOn(call, null));
    await wait(0);
    expect(screen.getByTestId("voice-pause")).toBeEnabled();
    fireEvent.click(screen.getByTestId("voice-send"));
    await wait(0);
    expect(onSendFile).toHaveBeenCalledOnce();
    expect(onSendFile.mock.calls[0][1]?.duration).toBe(5_000);
  });

  it("turns a held recording hands-free and paused: letting go of the mic then sends nothing", async () => {
    renderApp(<MessageInput onSend={onSend} onSendFile={onSendFile} />);
    const mic = screen.getByTestId("voice-record");
    fireEvent.pointerDown(mic, touch);
    await wait(3_000);
    expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-mode", "hold");

    act(() => setCallOn(call, () => {}));
    await wait(0);
    const bar = screen.getByTestId("voice-bar");
    expect(bar).toHaveAttribute("data-mode", "locked");
    expect(bar).toHaveAttribute("data-phase", "paused");

    // The finger leaves the button that is now Send: its release, and the click after it, are not a press on Send.
    const send = screen.getByTestId("voice-send");
    fireEvent.pointerUp(send, touch);
    fireEvent.click(send);
    await wait(0);
    expect(onSendFile).not.toHaveBeenCalled();
    expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-phase", "paused");
  });

  it("records one started during a call: that one is asked for", async () => {
    act(() => setCallOn(call, () => {}));
    await recordHandsFree();
    await wait(5_000);
    expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-phase", "recording");
    fireEvent.click(screen.getByTestId("voice-send"));
    await wait(0);
    expect(onSendFile.mock.calls[0][1]?.duration).toBe(5_000);
  });
});
