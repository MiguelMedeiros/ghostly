import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { servicesPlatform } from "../../lib/platform";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";
import { audio, decoder, endPlayback, installFakeAudio, installFakeDecoder } from "./fakeMedia";

// covers: files.voice.play

/**
 * The voice bubble when playing goes wrong, and how it is laid out. Miguel's report (after #194): on Desktop
 * every voice message said "Could not play this recording." — the CSP refused the blob — and a round mic badge
 * hung off the bubble's right edge in a narrow window.
 */
const peaks = Array.from({ length: 64 }, (_, i) => (i * 29) % 256);
let n = 0;

function voice(patch: Partial<ChatMessage> = {}, mime = "audio/webm"): ChatMessage {
  const id = `link-1-in-bubble${++n}`;
  return {
    id: `peer_b${n}`, text: "🎤 Voice message (0:04)", sender: "peer", timestamp: 1_700_000_100_000 + n,
    file: { id, name: `Voice message.${mime === "audio/mp4" ? "m4a" : "webm"}`, size: 2048, mime, voice: { duration: 4_200, peaks } },
    ...patch,
  };
}

const show = (message: ChatMessage) => renderApp(<MessageBubble message={message} peerPubKey="peer" />);
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
const refusal = (name: string) => new DOMException("The operation is not supported.", name);

async function clickPlay() {
  fireEvent.click(screen.getByTestId("voice-play"));
  for (let i = 0; i < 4; i++) await flush();
}

beforeEach(() => {
  installFakeAudio();
  installFakeDecoder();
  vi.spyOn(servicesPlatform!, "getFile").mockImplementation(async () => new Blob(["opus"], { type: "audio/webm" }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a voice message that will not play as it is", () => {
  it("plays from a WAV Web Audio decoded when <audio> refuses the recording", async () => {
    // The first source is the recording itself; only the decoded WAV plays.
    audio.refuse = () => (decoder.decoded.length === 0 ? refusal("NotSupportedError") : null);
    show(voice());
    await clickPlay();
    const bubble = screen.getByTestId("voice-bubble");
    expect(bubble).toHaveAttribute("data-state", "playing");
    expect(decoder.decoded).toHaveLength(1);
    expect(audio.players[0]!.src).toMatch(/^blob:/);
    expect(screen.queryByTestId("voice-problem")).not.toBeInTheDocument();
  });

  it("decodes straight away when the device has no player for the type at all", async () => {
    audio.canPlay = (type) => (type === "audio/mp4" ? "" : "maybe");
    show(voice({}, "audio/mp4"));
    await clickPlay();
    expect(decoder.decoded).toHaveLength(1);
    expect(screen.getByTestId("voice-bubble")).toHaveAttribute("data-state", "playing");
  });

  it("says this device can't play it, names the format, offers it to save, and keeps the reason", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    audio.refuse = () => refusal("NotSupportedError");
    decoder.decodes = false;
    show(voice());
    await clickPlay();
    const problem = screen.getByTestId("voice-problem");
    expect(problem).toHaveTextContent("This device can't play this recording (WebM). Save it to play it elsewhere.");
    expect(screen.getByTestId("voice-save")).toHaveAttribute("download", "Voice message.webm");
    expect(screen.getByTestId("voice-save").getAttribute("href")).toMatch(/^blob:/);
    // The real reason, for whoever debugs it: on the element always, in the console in dev builds.
    expect(problem.getAttribute("data-error")).toMatch(/decode/);
    const logged = warn.mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.startsWith("[voice] play(): NotSupportedError"))).toBe(true);
    expect(logged.some((line) => line.startsWith("[voice] decode"))).toBe(true);
    expect(screen.getByTestId("voice-bubble")).toHaveAttribute("data-state", "idle");
  });

  it("does not try the decoder twice: a WAV that fails too is a plain failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    audio.refuse = () => refusal("NotSupportedError");
    show(voice());
    await clickPlay();
    expect(decoder.decoded).toHaveLength(1);
    expect(screen.getByTestId("voice-problem")).toHaveTextContent("Could not play this recording.");
    expect(screen.getByTestId("voice-save")).toBeInTheDocument();
  });

  it("reports a recording that breaks off while playing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    show(voice());
    await clickPlay();
    const player = audio.players[0]!;
    Object.defineProperty(player, "error", { configurable: true, value: { code: 3, message: "PIPELINE_ERROR_DECODE" } });
    act(() => { player.dispatchEvent(new Event("error")); });
    expect(screen.getByTestId("voice-bubble")).toHaveAttribute("data-state", "idle");
    expect(screen.getByTestId("voice-problem")).toHaveTextContent("Could not play this recording.");
  });

  it("stays quiet when the engine only wants a tap (autoplay) or the play was cut short", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    audio.refuse = () => refusal("NotAllowedError");
    show(voice());
    await clickPlay();
    expect(screen.queryByTestId("voice-problem")).not.toBeInTheDocument();
    expect(decoder.decoded).toHaveLength(0);
    expect(screen.getByTestId("voice-bubble")).toHaveAttribute("data-state", "idle");

    audio.refuse = () => refusal("AbortError");
    await clickPlay();
    expect(screen.queryByTestId("voice-problem")).not.toBeInTheDocument();
  });
});

describe("the voice bubble's layout", () => {
  it("keeps everything on two lines inside the bubble: play and waveform, then mic, time and speed", async () => {
    show(voice());
    const bubble = screen.getByTestId("voice-bubble");
    // Sized by the message bubble, not the window.
    expect(bubble.className).toContain("max-w-full");
    expect(bubble.className).not.toMatch(/vw/);
    const meta = within(bubble).getByTestId("voice-meta");
    expect(within(meta).getByTestId("voice-unplayed")).toBeInTheDocument();
    expect(within(meta).getByTestId("voice-time")).toHaveTextContent("0:04");
    // No badge beside the waveform: the row holds the play button and the waveform's column only.
    const row = within(bubble).getByTestId("voice-play").parentElement!;
    expect(row.children).toHaveLength(2);

    await clickPlay();
    expect(within(meta).getByTestId("voice-speed")).toHaveTextContent("1×");
    expect(row.children).toHaveLength(2);
  });

  it("marks the mic until a received one is played; a sent one has a plain mic", async () => {
    show(voice());
    const meta = screen.getByTestId("voice-meta");
    expect(within(meta).getByRole("img", { name: "Voice message, not played yet" })).toHaveAttribute("data-testid", "voice-unplayed");
    await clickPlay();
    endPlayback(audio.players[0]!);
    await flush();
    expect(within(meta).getByRole("img", { name: "Voice message" })).toHaveAttribute("data-testid", "voice-mic");
    expect(within(meta).queryByTestId("voice-speed")).not.toBeInTheDocument();
  });

  it("a sent one never shows the unplayed mark", () => {
    show(voice({ sender: "me", id: "me_b1" }));
    expect(screen.getByTestId("voice-mic")).toBeInTheDocument();
    expect(screen.queryByTestId("voice-unplayed")).not.toBeInTheDocument();
  });
});
