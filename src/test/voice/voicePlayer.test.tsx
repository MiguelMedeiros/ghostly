import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { servicesPlatform } from "../../lib/platform";
import type { ChatMessage } from "../../lib/types";
import { fakeEngine } from "../fakeEngine";
import { renderApp } from "../render";
import { audio, endPlayback, installFakeAudio } from "./fakeMedia";

// covers: files.voice.play, files.voice.autoplay

const peaks = Array.from({ length: 64 }, (_, i) => (i * 37) % 256);
let n = 0;

function voice(patch: Partial<ChatMessage> = {}, duration = 7_400): ChatMessage {
  const id = `link-1-in-voice${++n}`;
  return {
    id: `peer_${n}`, text: "🎤 Voice message (0:07)", sender: "peer", timestamp: 1_700_000_000_000 + n,
    file: { id, name: "Voice message.webm", size: 1234, mime: "audio/webm", voice: { duration, peaks } },
    ...patch,
  };
}

function chat(...messages: ChatMessage[]) {
  return renderApp(<div>{messages.map((m) => <MessageBubble key={m.id} message={m} peerPubKey="peer" />)}</div>);
}

const bubbles = () => screen.getAllByTestId("voice-bubble");
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  installFakeAudio();
  vi.spyOn(servicesPlatform!, "getFile").mockImplementation(async () => new Blob(["opus"], { type: "audio/webm" }));
});

afterEach(() => vi.restoreAllMocks());

describe("a voice message in the chat", () => {
  it("shows its length and its waveform, and reads no bytes until it plays", () => {
    chat(voice());
    const bubble = screen.getByTestId("voice-bubble");
    expect(within(bubble).getByTestId("voice-time")).toHaveTextContent("0:07");
    expect(bubble.querySelectorAll(".voice-wave-base .voice-wave-bar")).toHaveLength(64);
    expect(within(bubble).getByRole("slider", { name: "Position in voice message" })).toHaveAttribute("aria-valuemax", "7");
    expect(servicesPlatform!.getFile).not.toHaveBeenCalled();
  });

  it("is a voice message only with its description: a plain audio file stays a file", () => {
    const plain = voice();
    delete plain.file!.voice;
    chat(plain);
    expect(screen.queryByTestId("voice-bubble")).not.toBeInTheDocument();
    expect(screen.getByTestId("file-bubble")).toBeInTheDocument();
  });

  it("plays and pauses", async () => {
    chat(voice());
    fireEvent.click(screen.getByRole("button", { name: "Play voice message" }));
    await flush();
    expect(audio.players).toHaveLength(1);
    expect(screen.getByTestId("voice-bubble")).toHaveAttribute("data-state", "playing");
    expect(audio.players[0]!.src).toMatch(/^blob:/);

    fireEvent.click(screen.getByRole("button", { name: "Pause voice message" }));
    expect(screen.getByTestId("voice-bubble")).toHaveAttribute("data-state", "paused");
    expect(audio.players[0]!.paused).toBe(true);
  });

  it("marks a received one unplayed until it is played, and remembers it", async () => {
    const message = voice();
    const { unmount } = chat(message);
    expect(screen.getByTestId("voice-unplayed")).toBeInTheDocument();
    expect(screen.getByTestId("voice-bubble")).toHaveAttribute("data-played", "false");
    fireEvent.click(screen.getByRole("button", { name: "Play voice message" }));
    await flush();
    expect(screen.queryByTestId("voice-unplayed")).not.toBeInTheDocument();
    unmount();

    chat(message);
    expect(screen.getByTestId("voice-bubble")).toHaveAttribute("data-played", "true");
  });

  it("never marks one's own voice messages unplayed", () => {
    chat(voice({ sender: "me", id: "me_1" }));
    expect(screen.queryByTestId("voice-unplayed")).not.toBeInTheDocument();
  });

  it("plays one at a time", async () => {
    chat(voice(), voice({ text: "between" }));
    const [first, second] = bubbles();
    fireEvent.click(within(first!).getByTestId("voice-play"));
    await flush();
    fireEvent.click(within(second!).getByTestId("voice-play"));
    await flush();
    expect(first).toHaveAttribute("data-state", "paused");
    expect(second).toHaveAttribute("data-state", "playing");
    expect(audio.players[0]!.paused).toBe(true);
  });

  it("goes on to the next voice message from the same sender, and stops at anything else", async () => {
    chat(voice(), voice(), voice({ sender: "me", id: "me_x" }), voice());
    const [first, second, mine] = bubbles();
    fireEvent.click(within(first!).getByTestId("voice-play"));
    await flush();
    endPlayback(audio.players[0]!);
    await flush();
    expect(first).toHaveAttribute("data-state", "idle");
    expect(second).toHaveAttribute("data-state", "playing");

    // The next one is this device's own: the run ends.
    endPlayback(audio.players[1]!);
    await flush();
    expect(mine).toHaveAttribute("data-state", "idle");
    expect(audio.players).toHaveLength(2);
  });

  it("does not go on past a text message", async () => {
    chat(voice(), { id: "t1", text: "hello", sender: "peer", timestamp: 1 }, voice());
    const [first, last] = bubbles();
    fireEvent.click(within(first!).getByTestId("voice-play"));
    await flush();
    endPlayback(audio.players[0]!);
    await flush();
    expect(last).toHaveAttribute("data-state", "idle");
  });

  it("changes speed for every voice message at once: 1×, 1.5×, 2×, and back", async () => {
    chat(voice(), voice());
    const [first, second] = bubbles();
    fireEvent.click(within(first!).getByTestId("voice-play"));
    await flush();
    const speed = within(first!).getByTestId("voice-speed");
    expect(speed).toHaveTextContent("1×");
    fireEvent.click(speed);
    expect(speed).toHaveTextContent("1.5×");
    expect(audio.players[0]!.playbackRate).toBe(1.5);
    fireEvent.click(speed);
    expect(speed).toHaveTextContent("2×");
    expect(audio.players[0]!.playbackRate).toBe(2);

    fireEvent.click(within(second!).getByTestId("voice-play"));
    await flush();
    expect(audio.players[1]!.playbackRate).toBe(2);
    fireEvent.click(within(second!).getByTestId("voice-speed"));
    expect(within(second!).getByTestId("voice-speed")).toHaveTextContent("1×");
  });

  it("moves to where the waveform is tapped or dragged", async () => {
    chat(voice({}, 10_000));
    const wave = screen.getByTestId("voice-waveform");
    vi.spyOn(wave, "getBoundingClientRect").mockReturnValue({ left: 100, width: 200, top: 0, height: 28, right: 300, bottom: 28, x: 100, y: 0, toJSON() {} });
    fireEvent.pointerDown(wave, { button: 0, pointerId: 1, clientX: 200 });
    expect(wave).toHaveAttribute("aria-valuenow", "5");
    expect(screen.getByTestId("voice-time")).toHaveTextContent("0:05");
    expect(wave.style.getPropertyValue("--voice-progress")).toBe("0.5");
    fireEvent.pointerMove(wave, { pointerId: 1, clientX: 250 });
    fireEvent.pointerUp(wave, { pointerId: 1, clientX: 250 });
    expect(wave).toHaveAttribute("aria-valuenow", "8");

    // It plays from there.
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    expect(audio.players[0]!.currentTime).toBeCloseTo(7.5);
  });

  it("moves with the keyboard", () => {
    chat(voice({}, 20_000));
    const wave = screen.getByTestId("voice-waveform");
    fireEvent.keyDown(wave, { key: "End" });
    expect(wave).toHaveAttribute("aria-valuenow", "20");
    fireEvent.keyDown(wave, { key: "ArrowLeft" });
    expect(wave).toHaveAttribute("aria-valuenow", "19");
    fireEvent.keyDown(wave, { key: "Home" });
    expect(wave).toHaveAttribute("aria-valuenow", "0");
  });

  it("offers the file when this device cannot play its type", async () => {
    audio.canPlay = (type) => (type === "audio/mp4" ? "" : "maybe");
    const aac = voice();
    aac.file = { ...aac.file!, mime: "audio/mp4", name: "Voice message.m4a" };
    chat(aac);
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    expect(screen.getByTestId("voice-problem")).toHaveTextContent("This device can't play this recording");
    expect(screen.getByTestId("voice-save")).toHaveAttribute("download", "Voice message.m4a");
    expect(audio.players).toHaveLength(0);
  });

  it("says so when the bytes are gone", async () => {
    vi.mocked(servicesPlatform!.getFile).mockResolvedValue(null);
    chat(voice());
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    expect(screen.getByTestId("voice-problem")).toHaveTextContent("No longer available");
  });

  it("cannot be played while it is still arriving, and shows how far it got", () => {
    const message = voice();
    fakeEngine.update({ transfers: { [message.file!.id]: { state: "transferring", transferred: 617, size: 1234 } } });
    chat(message);
    expect(screen.getByTestId("voice-play")).toBeDisabled();
    expect(screen.getByTestId("voice-status")).toHaveTextContent("50% of");
  });
});
