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

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  installFakeMedia();
  installFakeAudio();
  onSend.mockReset().mockResolvedValue(null);
  onSendFile.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  removeFakeMedia();
});

/** A click on the mic, as a mouse makes it: hands-free recording. */
async function recordHandsFree() {
  renderApp(<MessageInput onSend={onSend} onSendFile={onSendFile} />);
  const mic = screen.getByTestId("voice-record");
  fireEvent.pointerDown(mic, mouse);
  await wait(0);
  fireEvent.pointerUp(mic, mouse);
  fireEvent.click(screen.getByTestId("voice-send"));
  await wait(0);
  expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-mode", "locked");
}

/** The microphone goes (a headset unplugged, the system taking it): its track ends, and the recorder stops by itself. */
async function microphoneEnds() {
  media.tracks[0].readyState = "ended";
  media.recorders[0].stop();
  await wait(0);
}

describe("a hands-free voice recording whose microphone ends", () => {
  it("keeps what was recorded, paused, and says the microphone went", async () => {
    await recordHandsFree();
    await wait(10_000);
    await microphoneEnds();
    await wait(2_000);
    expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-phase", "paused");
    expect(screen.getByTestId("voice-timer")).toHaveTextContent("0:10");
    expect(screen.getByTestId("voice-preview")).toBeEnabled();
    // It cannot record any more: Resume is off.
    expect(screen.getByTestId("voice-pause")).toBeDisabled();
    expect(screen.getByTestId("voice-hint")).toHaveTextContent("No microphone found");
  });

  it("sends what was recorded until then", async () => {
    await recordHandsFree();
    await wait(10_000);
    await microphoneEnds();
    await wait(5_000);
    fireEvent.click(screen.getByTestId("voice-send"));
    await wait(1_000);
    expect(onSendFile).toHaveBeenCalledTimes(1);
    expect(onSendFile.mock.calls[0][1]?.duration).toBe(10_000);
    expect(screen.queryByTestId("voice-bar")).toBeNull();
  });

  it("is discarded with the bin", async () => {
    await recordHandsFree();
    await wait(3_000);
    await microphoneEnds();
    fireEvent.click(screen.getByTestId("voice-delete"));
    await wait(1_000);
    expect(onSendFile).not.toHaveBeenCalled();
    expect(screen.queryByTestId("voice-bar")).toBeNull();
    expect(screen.getByTestId("voice-record")).toHaveAttribute("data-mode", "idle");
  });

  it("ending while paused keeps the time recorded before the pause", async () => {
    await recordHandsFree();
    await wait(4_000);
    fireEvent.click(screen.getByTestId("voice-pause"));
    await wait(6_000);
    await microphoneEnds();
    fireEvent.click(screen.getByTestId("voice-send"));
    await wait(1_000);
    expect(onSendFile.mock.calls[0][1]?.duration).toBe(4_000);
  });
});
