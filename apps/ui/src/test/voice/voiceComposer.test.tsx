import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VOICE_LIMITS, type VoiceMeta } from "@ghostly/core";
import { MessageInput } from "../../components/MessageInput";
import { chooseDevice } from "../../lib/mediaDevices";
import { MICROPHONE_MESSAGES } from "../../lib/voiceRecorder";
import { renderApp } from "../render";
import { installFakeAudio, installFakeMedia, media, recordableTypes, removeFakeMedia } from "./fakeMedia";

// covers: files.voice.record, settings.media

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
  it("records from the microphone chosen in Settings → Audio & video, or the default when none is", async () => {
    chooseDevice("audioinput", { id: "mic-headset", label: "AirPods" });
    composer();
    await press();
    expect(media.getUserMedia).toHaveBeenCalledWith({ audio: expect.objectContaining({ echoCancellation: true, deviceId: { ideal: "mic-headset" } }) });
    fireEvent.pointerUp(mic(), touch);
    await wait(0);

    chooseDevice("audioinput", null);
    await press();
    expect(media.getUserMedia).toHaveBeenLastCalledWith({ audio: expect.objectContaining({ deviceId: undefined }) });
  });

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
    expect(screen.getByTestId("voice-send")).toHaveAccessibleName("Send");
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

  it("keeps recording when an edit fills the field meanwhile, and the contact stops seeing \"recording\" once it is sent", async () => {
    const onTyping = vi.fn();
    const edit = { key: "m1", text: "fixed words", snippet: "fixed words", onSave: vi.fn(async () => null), onClose: vi.fn() };
    const view = composer({ onTyping });
    await press(mouse);
    fireEvent.pointerUp(mic(), mouse);
    fireEvent.click(screen.getByTestId("voice-send"));
    await wait(2_000);
    expect(onTyping).toHaveBeenLastCalledWith(true, "recording");

    view.rerender(<MessageInput onSend={onSend} onSendFile={onSendFile} onTyping={onTyping} edit={edit} />);
    await wait(0);
    expect(screen.getByTestId("voice-bar")).toBeInTheDocument();
    expect(media.released()).toBe(false);

    fireEvent.click(screen.getByTestId("voice-send"));
    await wait(0);
    expect(onSendFile).toHaveBeenCalledOnce();
    expect(onTyping).toHaveBeenLastCalledWith(false, "recording");
    // The edit's words wait in the field, with its Send.
    expect(screen.getByPlaceholderText("Message…")).toHaveValue("fixed words");
  });

  it("tells the contact the recording stopped when the composer goes away mid-recording", async () => {
    const onTyping = vi.fn();
    const view = composer({ onTyping });
    await press(mouse);
    fireEvent.pointerUp(mic(), mouse);
    fireEvent.click(screen.getByTestId("voice-send"));
    await wait(1_000);
    expect(onTyping).toHaveBeenLastCalledWith(true, "recording");
    view.unmount();
    expect(media.released()).toBe(true);
    expect(onTyping).toHaveBeenLastCalledWith(false, "recording");
  });

  it("pauses without counting the pause, plays what is recorded so far, and resumes", async () => {
    await locked();
    await wait(2_000);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-phase", "paused");
    expect(media.recorders[0]!.state).toBe("paused");
    expect(screen.getByTestId("voice-preview-wave")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("voice-preview"));
    await wait(500);
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeInTheDocument();

    await wait(10_000);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(media.recorders[0]!.state).toBe("recording");
    await wait(1_000);
    fireEvent.click(screen.getByTestId("voice-send"));
    await wait(0);
    // One recording throughout: paused and resumed, never restarted.
    expect(media.recorders).toHaveLength(1);
    expect(onSendFile).toHaveBeenCalledOnce();
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

/** A real mouse click on the send button: press, let go, then the click the engine adds. */
async function clickSend() {
  const button = screen.getByTestId("voice-send");
  fireEvent.pointerDown(button, mouse);
  fireEvent.pointerUp(button, mouse);
  fireEvent.click(button);
  await wait(0);
}

describe("one press sends (Miguel: \"I have to click send twice\")", () => {
  it("click locks, then one click sends exactly one message", async () => {
    composer();
    await press(mouse);
    fireEvent.pointerUp(mic(), mouse);
    fireEvent.click(screen.getByTestId("voice-send"));
    await wait(2_000);
    expect(onSendFile).not.toHaveBeenCalled();
    await clickSend();
    expect(onSendFile).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("voice-bar")).not.toBeInTheDocument();
    expect(mic()).toHaveAccessibleName("Record a voice message");
  });

  it("a slide-up lock whose click never comes does not swallow the first click on send", async () => {
    composer();
    await press(mouse);
    const button = mic();
    fireEvent.pointerMove(button, { ...mouse, clientY: 400 });
    // Let go far above the button: no click follows the gesture.
    fireEvent.pointerUp(button, { ...mouse, clientY: 400 });
    await wait(2_000);
    await clickSend();
    expect(onSendFile).toHaveBeenCalledOnce();
  });

  it("Space sends after a slide-up lock too", async () => {
    composer();
    await press(mouse);
    const button = mic();
    fireEvent.pointerMove(button, { ...mouse, clientY: 400 });
    fireEvent.pointerUp(button, { ...mouse, clientY: 400 });
    await wait(2_000);
    const send = screen.getByTestId("voice-send");
    // A key press on a button: keydown, then the click, with no pointer.
    fireEvent.keyDown(send, { key: " " });
    fireEvent.click(send);
    await wait(0);
    expect(onSendFile).toHaveBeenCalledOnce();
  });

  it("sends as the press ends even if the click is lost, and never twice", async () => {
    composer();
    await press(mouse);
    fireEvent.pointerUp(mic(), mouse);
    fireEvent.click(screen.getByTestId("voice-send"));
    await wait(2_000);
    const send = screen.getByTestId("voice-send");
    fireEvent.pointerDown(send, mouse);
    fireEvent.pointerUp(send, mouse);
    // A second, impatient click while the first is being sent.
    fireEvent.click(send);
    fireEvent.pointerDown(send, mouse);
    fireEvent.pointerUp(send, mouse);
    fireEvent.click(send);
    await wait(0);
    expect(onSendFile).toHaveBeenCalledOnce();
    // Nothing was started by the extra click either.
    expect(screen.queryByTestId("voice-bar")).not.toBeInTheDocument();
  });

  it("a press that leaves the send button and comes back later sends nothing; the next click does", async () => {
    composer();
    fireEvent.click(mic());
    await wait(2_000);
    const send = screen.getByTestId("voice-send");
    fireEvent.pointerDown(send, mouse);
    fireEvent.pointerLeave(send, mouse);
    fireEvent.pointerUp(send, mouse);
    await wait(0);
    expect(onSendFile).not.toHaveBeenCalled();
    expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-mode", "locked");
    await clickSend();
    expect(onSendFile).toHaveBeenCalledOnce();
  });

  it("a slow click while the microphone is still waking up records hands-free instead of throwing it away", async () => {
    let answer!: () => void;
    const ready = new Promise<void>((resolve) => { answer = resolve; });
    const real = media.getUserMedia.getMockImplementation()!;
    media.getUserMedia.mockImplementation(async (constraints) => { await ready; return real(constraints); });
    composer();
    const button = mic();
    fireEvent.pointerDown(button, mouse);
    await wait(350);
    fireEvent.pointerUp(button, mouse);
    fireEvent.click(button);
    expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-mode", "locked");
    answer();
    await wait(2_000);
    expect(screen.getByTestId("voice-bar")).toHaveAttribute("data-phase", "recording");
    await clickSend();
    expect(onSendFile).toHaveBeenCalledOnce();
  });

  it("a send pressed before the microphone answers is kept, not a silent discard", async () => {
    let answer!: () => void;
    const ready = new Promise<void>((resolve) => { answer = resolve; });
    const real = media.getUserMedia.getMockImplementation()!;
    media.getUserMedia.mockImplementation(async (constraints) => { await ready; return real(constraints); });
    composer();
    fireEvent.click(mic());
    await wait(0);
    await clickSend();
    expect(screen.getByTestId("voice-send")).toHaveAttribute("aria-busy", "true");
    answer();
    await wait(0);
    // Nothing had been recorded yet: it says so rather than vanishing.
    expect(screen.getByTestId("voice-hint")).toHaveTextContent("Too short to send");
    expect(screen.queryByTestId("voice-bar")).not.toBeInTheDocument();
    expect(media.released()).toBe(true);
  });

  it("a held mouse still sends on release, once", async () => {
    composer();
    await press(mouse);
    await wait(2_000);
    fireEvent.pointerUp(mic(), mouse);
    fireEvent.click(mic());
    await wait(0);
    expect(onSendFile).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("voice-bar")).not.toBeInTheDocument();
  });
});

describe("what each state shows", () => {
  it("hold: the lock handle opens, and shuts as the finger nears it", async () => {
    composer();
    await press();
    const hint = screen.getByTestId("voice-lock-hint");
    expect(hint).toHaveAttribute("data-near", "false");
    fireEvent.pointerMove(mic(), { ...touch, clientY: 450 });
    expect(hint).toHaveAttribute("data-near", "true");
  });

  it("locked: the mic is the send button at once, with Discard and Pause beside it, each with a tooltip", async () => {
    composer();
    fireEvent.click(mic());
    const send = screen.getByTestId("voice-send");
    expect(send).toHaveAccessibleName("Send");
    expect(send).toHaveAttribute("title", "Send");
    await wait(1_000);
    for (const name of ["Discard", "Pause", "Send"]) expect(screen.getByRole("button", { name })).toHaveAttribute("title", name);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    for (const name of ["Discard", "Play", "Resume", "Send"]) expect(screen.getByRole("button", { name })).toHaveAttribute("title", name);
  });

  it("a slide to cancel ends in the bin, which then goes", async () => {
    composer();
    await press();
    await wait(1_000);
    fireEvent.pointerMove(mic(), { ...touch, clientX: 150 });
    expect(screen.getByTestId("voice-binned")).toBeInTheDocument();
    await wait(1_000);
    expect(screen.queryByTestId("voice-binned")).not.toBeInTheDocument();
  });
});

describe("Esc", () => {
  async function lockedFor(ms: number) {
    composer();
    fireEvent.click(mic());
    await wait(ms);
  }

  it("discards a short recording at once", async () => {
    await lockedFor(2_000);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByTestId("voice-bar")).not.toBeInTheDocument();
    expect(media.released()).toBe(true);
  });

  it("asks first after a few seconds, paused meanwhile; Keep (or Esc again) carries on recording", async () => {
    await lockedFor(4_000);
    fireEvent.keyDown(document.body, { key: "Escape" });
    const dialog = screen.getByRole("alertdialog", { name: "Discard voice message?" });
    expect(dialog).toBeInTheDocument();
    expect(media.recorders[0]!.state).toBe("paused");
    expect(screen.getByTestId("voice-confirm-keep")).toHaveFocus();
    // Enter does not send from behind the question.
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(onSendFile).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(media.recorders[0]!.state).toBe("recording");

    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByTestId("voice-confirm-keep"));
    expect(media.recorders[0]!.state).toBe("recording");
    await wait(1_000);
    await clickSend();
    expect(onSendFile).toHaveBeenCalledOnce();
    expect(media.recorders).toHaveLength(1);
  });

  it("Discard in the question throws it away", async () => {
    await lockedFor(4_000);
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByTestId("voice-confirm-discard"));
    expect(screen.queryByTestId("voice-bar")).not.toBeInTheDocument();
    expect(media.released()).toBe(true);
    expect(onSendFile).not.toHaveBeenCalled();
  });

  it("stays paused after Keep when it was paused before", async () => {
    await lockedFor(4_000);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByTestId("voice-confirm-keep"));
    expect(media.recorders[0]!.state).toBe("paused");
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
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
