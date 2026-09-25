import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VOICE_LIMITS, type VoiceMeta } from "@ghostly/core";
import { MessageInput } from "../../components/MessageInput";
import { MICROPHONE_MESSAGES } from "../../lib/voiceRecorder";
import { renderApp } from "../render";
import { installFakeAudio, installFakeMedia, media, recordableTypes, removeFakeMedia } from "./fakeMedia";

// covers: files.voice.record

const onSend = vi.fn<(text: string) => Promise<string | null>>();
const onSendFile = vi.fn<(file: File, voice?: VoiceMeta) => Promise<string | null>>();

function composer(props: Partial<Parameters<typeof MessageInput>[0]> = {}) {
  return renderApp(<MessageInput onSend={onSend} onSendFile={onSendFile} {...props} />);
}

const mic = () => screen.getByTestId("voice-record");
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const touch = { pointerId: 1, pointerType: "touch", button: 0, clientX: 300, clientY: 500 };
const mouse = { ...touch, pointerType: "mouse" };

async function press(init = touch) {
  fireEvent.pointerDown(mic(), init);
  // The microphone answers.
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
  vi.restoreAllMocks();
});

describe("the mic in the composer", () => {
  it("takes the send button's place while there is nothing to send", () => {
    composer();
    expect(mic()).toHaveAccessibleName("Record a voice message");
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Message…"), { target: { value: "hi" } });
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
    expect(screen.queryByTestId("voice-record")).not.toBeInTheDocument();
  });

  it("is not offered where nothing can record, nor where files cannot be sent", () => {
    removeFakeMedia();
    composer();
    expect(screen.queryByTestId("voice-record")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
  });

  it("is not offered without a way to send files (a group)", () => {
    renderApp(<MessageInput onSend={onSend} />);
    expect(screen.queryByTestId("voice-record")).not.toBeInTheDocument();
  });

  it("says why when a voice message cannot be sent in this chat, without touching the microphone", async () => {
    composer({ fileUnavailable: "Update both peers to send files" });
    await press();
    expect(screen.getByRole("alert")).toHaveTextContent("Update both peers to send files");
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(screen.queryByTestId("voice-bar")).not.toBeInTheDocument();
  });
});

describe("hold to record", () => {
  it("records while held and sends on release: a WebM file with its length and waveform", async () => {
    composer();
    await press();
    const bar = screen.getByTestId("voice-bar");
    expect(bar).toHaveAttribute("data-mode", "hold");
    expect(screen.getByTestId("voice-slide")).toHaveTextContent("Slide to cancel");
    expect(screen.getByTestId("voice-lock-hint")).toBeInTheDocument();
    expect(media.getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ echoCancellation: true }) });
    expect(media.recorders[0]!.options).toEqual({ mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: VOICE_LIMITS.audioBitsPerSecond });

    await wait(3_000);
    expect(screen.getByTestId("voice-timer")).toHaveTextContent("0:03");
    fireEvent.pointerUp(mic(), touch);
    await wait(0);

    expect(onSendFile).toHaveBeenCalledOnce();
    const [file, voice] = onSendFile.mock.calls[0]!;
    expect(file.type).toBe("audio/webm");
    expect(file.name).toMatch(/^Voice message \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.webm$/);
    expect(voice!.duration).toBeGreaterThanOrEqual(2_900);
    expect(voice!.duration).toBeLessThanOrEqual(3_100);
    expect(voice!.peaks).toHaveLength(VOICE_LIMITS.bars);
    // A steady tone: every bar at full height.
    expect(new Set(voice!.peaks)).toEqual(new Set([255]));
    // The microphone is given back as soon as the recording ends.
    expect(media.released()).toBe(true);
    expect(screen.queryByTestId("voice-bar")).not.toBeInTheDocument();
  });

  it("records AAC in MP4 where that is all the engine has (older WKWebView)", async () => {
    recordableTypes("audio/mp4");
    composer();
    await press();
    await wait(1_000);
    fireEvent.pointerUp(mic(), touch);
    await wait(0);
    const [file] = onSendFile.mock.calls[0]!;
    expect(file.type).toBe("audio/mp4");
    expect(file.name).toMatch(/\.m4a$/);
  });

  it("cancels when the finger slides away sideways", async () => {
    composer();
    await press();
    await wait(1_000);
    fireEvent.pointerMove(mic(), { ...touch, clientX: 240 });
    expect(screen.getByTestId("voice-bar")).toBeInTheDocument();
    fireEvent.pointerMove(mic(), { ...touch, clientX: 150 });
    expect(screen.queryByTestId("voice-bar")).not.toBeInTheDocument();
    fireEvent.pointerUp(mic(), { ...touch, clientX: 150 });
    await wait(0);
    expect(onSendFile).not.toHaveBeenCalled();
    expect(media.released()).toBe(true);
  });

  it("locks when the finger slides up, and keeps recording after it lets go", async () => {
    composer();
    await press();
    const button = mic();
    fireEvent.pointerMove(button, { ...touch, clientY: 400 });
    // Locked: the same button, now the one that sends.
    expect(button).toHaveAttribute("data-testid", "voice-send");
    fireEvent.pointerUp(button, { ...touch, clientY: 400 });
    await wait(2_000);
    expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-mode", "locked");
    expect(onSendFile).not.toHaveBeenCalled();
    expect(screen.getByTestId("voice-send")).toHaveAccessibleName("Send voice message");
    expect(media.released()).toBe(false);
  });

  it("answers a tap with how it works, and records nothing", async () => {
    composer();
    await press();
    await wait(100);
    fireEvent.pointerUp(mic(), touch);
    await wait(0);
    expect(screen.getByTestId("voice-hint")).toHaveTextContent("Hold to record, release to send");
    expect(onSendFile).not.toHaveBeenCalled();
    expect(media.released()).toBe(true);
    await wait(3_000);
    expect(screen.queryByTestId("voice-hint")).not.toBeInTheDocument();
  });

  it("gives the microphone back when the system takes the gesture", async () => {
    composer();
    await press();
    fireEvent.pointerCancel(mic(), touch);
    expect(screen.queryByTestId("voice-bar")).not.toBeInTheDocument();
    expect(media.released()).toBe(true);
  });
});

describe("hands-free (locked) recording", () => {
  async function locked() {
    composer();
    await press(mouse);
    fireEvent.pointerUp(mic(), mouse);
    fireEvent.click(screen.getByTestId("voice-send"));
    await wait(0);
    return screen.getByTestId("voice-bar");
  }

  it("starts with a mouse click, and the click itself sends nothing", async () => {
    const bar = await locked();
    expect(bar).toHaveAttribute("data-mode", "locked");
    expect(onSendFile).not.toHaveBeenCalled();
    for (const id of ["voice-delete", "voice-pause", "voice-send"]) expect(screen.getByTestId(id)).toBeInTheDocument();
  });

  it("sends with the send button", async () => {
    await locked();
    await wait(2_000);
    fireEvent.click(screen.getByTestId("voice-send"));
    await wait(0);
    expect(onSendFile).toHaveBeenCalledOnce();
    expect(media.released()).toBe(true);
  });

  it("sends with Enter, once, wherever the focus is", async () => {
    await locked();
    await wait(2_000);
    const send = screen.getByTestId("voice-send");
    expect(send).toHaveFocus();
    fireEvent.keyDown(send, { key: "Enter" });
    await wait(0);
    expect(onSendFile).toHaveBeenCalledOnce();
  });

  it("deletes with Esc or the bin, and gives the microphone back", async () => {
    await locked();
    await wait(1_000);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByTestId("voice-bar")).not.toBeInTheDocument();
    expect(media.released()).toBe(true);

    await press(mouse);
    fireEvent.pointerUp(mic(), mouse);
    await wait(500);
    fireEvent.click(screen.getByTestId("voice-delete"));
    await wait(0);
    expect(screen.queryByTestId("voice-bar")).not.toBeInTheDocument();
    expect(media.released()).toBe(true);
    expect(onSendFile).not.toHaveBeenCalled();
  });

  it("pauses without counting the pause, plays what is recorded so far, and resumes", async () => {
    await locked();
    await wait(2_000);
    fireEvent.click(screen.getByRole("button", { name: "Pause recording" }));
    expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-phase", "paused");
    expect(media.recorders[0]!.state).toBe("paused");
    expect(screen.getByTestId("voice-preview-wave")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("voice-preview"));
    await wait(500);
    expect(screen.getByRole("button", { name: "Pause preview" })).toBeInTheDocument();

    await wait(10_000);
    fireEvent.click(screen.getByRole("button", { name: "Resume recording" }));
    expect(media.recorders[0]!.state).toBe("recording");
    await wait(1_000);
    fireEvent.click(screen.getByTestId("voice-send"));
    await wait(0);
    const [, voice] = onSendFile.mock.calls[0]!;
    // Two seconds, a pause of ten, one more second.
    expect(voice!.duration).toBeGreaterThanOrEqual(2_900);
    expect(voice!.duration).toBeLessThan(4_000);
  });

  it("starts from the keyboard, since there is nothing to hold", async () => {
    composer();
    // A key press on a button is a click with no pointer before it.
    fireEvent.click(mic());
    await wait(1_000);
    expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-mode", "locked");
    fireEvent.keyDown(document.body, { key: "Enter" });
    await wait(0);
    expect(onSendFile).toHaveBeenCalledOnce();
  });

  it(`stops at ${VOICE_LIMITS.maxDurationMs / 60_000} minutes and sends what it has`, async () => {
    await locked();
    await wait(VOICE_LIMITS.maxDurationMs + 200);
    expect(onSendFile).toHaveBeenCalledOnce();
    const [, voice] = onSendFile.mock.calls[0]!;
    expect(voice!.duration).toBeLessThanOrEqual(VOICE_LIMITS.maxDurationMs);
    expect(voice!.duration).toBeGreaterThan(VOICE_LIMITS.maxDurationMs - 1_000);
    expect(media.released()).toBe(true);
  });
});

describe("the microphone refused", () => {
  it("explains how to allow it", async () => {
    media.deny();
    composer();
    await press();
    expect(screen.getByRole("alert")).toHaveTextContent(MICROPHONE_MESSAGES.denied);
    expect(screen.queryByTestId("voice-bar")).not.toBeInTheDocument();
  });

  it("says when there is no microphone to use", async () => {
    media.deny("NotFoundError");
    composer();
    await press();
    expect(screen.getByRole("alert")).toHaveTextContent(MICROPHONE_MESSAGES.unavailable);
  });

  it("gives the microphone back if it answers after the finger has already let go", async () => {
    let answer!: (stream: MediaStream) => void;
    media.getUserMedia.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    composer();
    fireEvent.pointerDown(mic(), touch);
    await wait(500);
    fireEvent.pointerUp(mic(), touch);
    await wait(0);
    const track = { readyState: "live", stop: vi.fn() };
    answer({ getTracks: () => [track] } as unknown as MediaStream);
    await wait(0);
    expect(track.stop).toHaveBeenCalled();
    expect(onSendFile).not.toHaveBeenCalled();
  });
});
