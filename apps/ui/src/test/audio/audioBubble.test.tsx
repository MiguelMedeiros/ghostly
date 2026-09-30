import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioBubble } from "../../components/audio/AudioBubble";
import { MessageBubble } from "../../components/MessageBubble";
import { VoiceBubble } from "../../components/voice/VoiceBubble";
import { servicesPlatform, type FileTransferState } from "../../lib/platform";
import type { ChatFile, ChatMessage } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: files.audio.play, files.voice.media-session

const MB = 1024 ** 2;
let n = 0;
const last = <T,>(list: T[]): T | undefined => list[list.length - 1];

const song = (patch: Partial<ChatFile> = {}): ChatFile => ({ id: `chat1-in-song${++n}`, name: "Ghost Town.mp3", size: 4.2 * MB, mime: "audio/mpeg", ...patch });

function show(file: ChatFile, transfer: FileTransferState | null = null, sender: "me" | "peer" = "peer") {
  fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: transfer ? { [file.id]: transfer } : {} });
  return renderApp(<AudioBubble file={file} sender={sender} peerName="Ana" />);
}

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
/** The element reports what a real one would once it has read the file's header. */
function loaded(duration: number) {
  const audio = screen.getByTestId("audio-element") as HTMLAudioElement;
  Object.defineProperty(audio, "duration", { configurable: true, value: duration });
  fireEvent.loadedMetadata(audio);
  return audio;
}

let canPlay: (type: string) => CanPlayTypeResult;
let play: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;
let getFile: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  canPlay = () => "maybe";
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockImplementation((type: string) => canPlay(type));
  play = vi.fn(function (this: HTMLMediaElement) { this.dispatchEvent(new Event("play")); return Promise.resolve(); });
  pause = vi.fn(function (this: HTMLMediaElement) { this.dispatchEvent(new Event("pause")); });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play as unknown as () => Promise<void>);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause as unknown as () => void);
  getFile = vi.spyOn(servicesPlatform!, "getFile").mockResolvedValue(new Blob(["mp3"], { type: "audio/mpeg" }));
  fakeEngine.on("fileAction", () => undefined);
  try { localStorage.removeItem("ghostly-voice-rate"); } catch { /* none */ }
});

afterEach(() => vi.restoreAllMocks());

describe("an audio file in the chat", () => {
  it("playing, it shows on the lock screen and the system's buttons pause it; it lets go when it ends", async () => {
    const handlers = new Map<string, ((details: { seekTime?: number }) => void) | null>();
    const session = { metadata: null as unknown, playbackState: "none", setActionHandler: (action: string, handler: ((details: { seekTime?: number }) => void) | null) => { handlers.set(action, handler); }, setPositionState: vi.fn() };
    Object.defineProperty(navigator, "mediaSession", { configurable: true, value: session });
    vi.stubGlobal("MediaMetadata", class { constructor(public init: object) {} });
    try {
      show(song());
      fireEvent.click(screen.getByTestId("audio-play"));
      await flush();
      expect(session.metadata).toMatchObject({ init: { title: "Ghost Town.mp3", artist: "Ana" } });
      expect(session.playbackState).toBe("playing");
      const audio = loaded(10);
      act(() => handlers.get("pause")!({}));
      expect(pause).toHaveBeenCalled();
      expect(session.playbackState).toBe("paused");
      fireEvent.ended(audio);
      expect(session.playbackState).toBe("none");
      expect(handlers.get("play")).toBeNull();
    } finally {
      Reflect.deleteProperty(navigator, "mediaSession");
      vi.unstubAllGlobals();
    }
  });

  it("is routed to the audio bubble by its type; a voice message keeps its own; MIDI stays a file", () => {
    const message = (file: ChatFile): ChatMessage => ({ id: `peer_${file.id}`, text: `📎 ${file.name}`, sender: "peer", timestamp: 1_700_000_000_000, file });
    fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: {} });
    const a = renderApp(<MessageBubble message={message(song())} peerPubKey="peer" />);
    expect(screen.getByTestId("audio-bubble")).toBeInTheDocument();
    a.unmount();
    const b = renderApp(<MessageBubble message={message(song({ name: "Voice message.webm", mime: "audio/webm", voice: { duration: 3000, peaks: [1, 2, 3] } }))} peerPubKey="peer" />);
    expect(screen.getByTestId("voice-bubble")).toBeInTheDocument();
    expect(screen.queryByTestId("audio-bubble")).toBeNull();
    b.unmount();
    renderApp(<MessageBubble message={message(song({ name: "tune.mid", mime: "audio/midi" }))} peerPubKey="peer" />);
    expect(screen.getByTestId("file-bubble")).toBeInTheDocument();
  });

  it("shows its name, a play button and its size before it plays, having read nothing", () => {
    show(song());
    expect(screen.getByTestId("audio-name")).toHaveTextContent("Ghost Town.mp3");
    expect(screen.getByRole("button", { name: "Play audio" })).toBeEnabled();
    expect(screen.getByTestId("audio-time")).toHaveTextContent("4.2 MB");
    expect(screen.getByTestId("audio-seek")).toBeDisabled();
    expect(screen.queryByTestId("audio-speed")).toBeNull();
    expect(getFile).not.toHaveBeenCalled();
  });

  it("plays from its bytes; the seek bar moves it; the time reads position of length", async () => {
    show(song());
    fireEvent.click(screen.getByTestId("audio-play"));
    await flush();
    const audio = loaded(225);
    expect(audio.getAttribute("src")).toMatch(/^blob:/);
    expect(play).toHaveBeenCalled();
    expect(screen.getByTestId("audio-bubble")).toHaveAttribute("data-state", "playing");
    expect(screen.getByRole("button", { name: "Pause audio" })).toBeInTheDocument();
    expect(screen.getByTestId("audio-time")).toHaveTextContent("0:00 / 3:45");
    fireEvent.change(screen.getByTestId("audio-seek"), { target: { value: "90" } });
    expect(audio.currentTime).toBe(90);
    expect(screen.getByTestId("audio-time")).toHaveTextContent("1:30 / 3:45");
    fireEvent.click(screen.getByTestId("audio-play"));
    expect(pause).toHaveBeenCalled();
    expect(screen.getByTestId("audio-bubble")).toHaveAttribute("data-state", "paused");
  });

  it("has the speed voice messages share: the pill turns it, for voice messages too", async () => {
    show(song());
    fireEvent.click(screen.getByTestId("audio-play"));
    await flush();
    const audio = loaded(60);
    const speed = screen.getByTestId("voice-speed");
    expect(speed).toHaveAttribute("data-rate", "1");
    fireEvent.click(speed);
    expect(screen.getByTestId("voice-speed")).toHaveAttribute("data-rate", "1.5");
    expect(audio.playbackRate).toBe(1.5);
    expect(localStorage.getItem("ghostly-voice-rate")).toBe("1.5");
  });

  it("one plays at a time: a voice message starting stops it, and it lets go of its bytes", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: {} });
    const voice: ChatFile & { voice: { duration: number; peaks: number[] } } = { id: "chat1-in-voice1", name: "Voice message.webm", size: 900, mime: "audio/webm", voice: { duration: 3000, peaks: [1, 2, 3] } };
    renderApp(<><AudioBubble file={song()} sender="peer" /><VoiceBubble file={voice} sender="peer" /></>);
    fireEvent.click(screen.getByTestId("audio-play"));
    await flush();
    const url = screen.getByTestId("audio-element").getAttribute("src");
    fireEvent.click(screen.getByTestId("voice-play"));
    await flush();
    expect(screen.queryByTestId("audio-element")).toBeNull();
    expect(revoke).toHaveBeenCalledWith(url);
  });

  it("a type this device does not play offers Download instead", async () => {
    canPlay = (type) => (type === "audio/flac" ? "" : "maybe");
    const saveFile = vi.spyOn(servicesPlatform!, "saveFile").mockResolvedValue(true);
    const file = song({ name: "live.flac", mime: "audio/flac" });
    show(file);
    expect(screen.getByTestId("audio-play")).toBeDisabled();
    expect(screen.getByTestId("audio-problem")).toHaveTextContent("This device can't play this audio (FLAC). Download it to listen.");
    fireEvent.click(screen.getByTestId("audio-download"));
    await waitFor(() => expect(saveFile).toHaveBeenCalledWith(file.id, "live.flac"));
  });

  it("refused by the player once started, it says so and offers Download", async () => {
    play.mockImplementationOnce(() => Promise.reject(new DOMException("no decoder", "NotSupportedError")));
    show(song());
    fireEvent.click(screen.getByTestId("audio-play"));
    await flush();
    await flush();
    expect(screen.queryByTestId("audio-element")).toBeNull();
    expect(screen.getByTestId("audio-problem")).toHaveTextContent("(MP3)");
    expect(screen.getByTestId("audio-download")).toBeInTheDocument();
  });

  // covers: files.video.stream
  it("on Desktop it plays from the platform's stream, even a large one, and lets go of it", async () => {
    getFile.mockResolvedValue(null);
    const release = vi.fn();
    const streamFile = vi.spyOn(servicesPlatform!, "streamFile").mockResolvedValue({ url: "ghostly-file://localhost/song-1", release });
    const file = song({ size: 300 * MB });
    show(file);
    fireEvent.click(screen.getByTestId("audio-play"));
    await flush();
    expect(streamFile).toHaveBeenCalledWith(file.id);
    const audio = screen.getByTestId("audio-element") as HTMLAudioElement;
    expect(audio.getAttribute("src")).toBe("ghostly-file://localhost/song-1");
    expect(screen.queryByTestId("audio-problem")).toBeNull();
    fireEvent.ended(audio);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("a stream the player refuses is played again from the file's bytes, once, from where it was", async () => {
    const release = vi.fn();
    vi.spyOn(servicesPlatform!, "streamFile").mockResolvedValue({ url: "ghostly-file://localhost/song-2", release });
    show(song());
    fireEvent.click(screen.getByTestId("audio-play"));
    await flush();
    const streamed = screen.getByTestId("audio-element") as HTMLAudioElement;
    streamed.currentTime = 3;
    fireEvent.error(streamed);
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
    const fromBytes = screen.getByTestId("audio-element") as HTMLAudioElement;
    expect(fromBytes.getAttribute("src")).toMatch(/^blob:/);
    expect(fromBytes.currentTime).toBe(3);
    expect(screen.queryByTestId("audio-problem")).toBeNull();
    // The bytes refused too: nothing more to try.
    fireEvent.error(fromBytes);
    await flush();
    expect(screen.getByTestId("audio-problem")).toHaveTextContent("(MP3)");
  });

  it("too large to hand out here, and nothing streams it: Download to listen", async () => {
    getFile.mockResolvedValue(null);
    vi.spyOn(servicesPlatform!, "streamFile").mockResolvedValue(null);
    vi.spyOn(servicesPlatform!, "saveFile").mockResolvedValue(true);
    show(song());
    fireEvent.click(screen.getByTestId("audio-play"));
    await flush();
    expect(screen.getByTestId("audio-problem")).toHaveTextContent("Too large to play here. Download it to listen.");
  });
});

describe("an audio file not here yet", () => {
  it("a large one the person has to accept shows Download <size>, and answers through the engine", async () => {
    const file = song({ size: 40 * MB });
    show(file, { state: "transferring", stage: "asking", direction: "in", transferred: 0, size: file.size, room: 12 * 1024 * MB });
    expect(screen.getByTestId("audio-accept")).toHaveTextContent("Download 40.0 MB");
    expect(screen.getByTestId("audio-room")).toHaveTextContent("Ana wants to send it · 12.0 GB free");
    expect(screen.getByTestId("audio-play")).toBeDisabled();
    fireEvent.click(screen.getByTestId("audio-accept"));
    await waitFor(() => expect(fakeEngine.callsTo("fileAction")).toEqual([{ linkId: "chat1", fileId: file.id, action: "accept" }]));
    fireEvent.click(screen.getByTestId("audio-decline"));
    await waitFor(() => expect(last(fakeEngine.callsTo("fileAction"))?.action).toBe("decline"));
  });

  it("an offer larger than the room here cannot be accepted", () => {
    const file = song({ size: 40 * MB });
    show(file, { state: "transferring", stage: "asking", direction: "in", transferred: 0, size: file.size, room: 10 * MB });
    expect(screen.getByTestId("audio-accept")).toBeDisabled();
  });

  it("while it arrives: a ring round the play button, the status, and pause/cancel", async () => {
    const file = song({ size: 10 * MB });
    show(file, { state: "transferring", direction: "in", transferred: 4 * MB, size: file.size });
    expect(screen.getByTestId("audio-progress")).toBeInTheDocument();
    expect(screen.getByTestId("audio-status")).toHaveTextContent("40% of 10.0 MB");
    expect(screen.getByTestId("audio-play")).toBeDisabled();
    expect(screen.queryByTestId("audio-save")).toBeNull();
    fireEvent.click(screen.getByTestId("audio-pause-transfer"));
    await waitFor(() => expect(last(fakeEngine.callsTo("fileAction"))?.action).toBe("pause"));
    fireEvent.click(screen.getByTestId("audio-cancel"));
    await waitFor(() => expect(last(fakeEngine.callsTo("fileAction"))?.action).toBe("cancel"));
  });

  it("one sent from here whose bytes cannot be read yet says so, and plays once it has gone", async () => {
    const file = song({ id: "chat1-out-song-early", size: 10 * MB });
    getFile.mockResolvedValue(null);
    const view = show(file, { state: "transferring", direction: "out", transferred: 4 * MB, size: file.size }, "me");
    fireEvent.click(screen.getByTestId("audio-play"));
    await flush();
    expect(screen.getByTestId("audio-problem")).toHaveTextContent("It plays once it has been sent.");
    expect(screen.getByTestId("audio-play")).toBeDisabled();
    act(() => fakeEngine.update({ transfers: { [file.id]: { state: "done", direction: "out", transferred: file.size, size: file.size } } }));
    view.rerender(<AudioBubble file={file} sender="me" peerName="Ana" />);
    expect(screen.queryByTestId("audio-problem")).toBeNull();
    expect(screen.getByTestId("audio-play")).toBeEnabled();
  });

  it("one that did not go offers the round Send again, with the reason behind its ⓘ", () => {
    const retryFile = vi.spyOn(servicesPlatform!, "retryFile").mockResolvedValue();
    const file = song({ id: "chat1-out-song" });
    show(file, { state: "failed", direction: "out", transferred: 0, size: file.size, error: "The connection dropped", retry: true }, "me");
    expect(screen.getByTestId("audio-status")).toHaveTextContent("Not sent");
    fireEvent.click(screen.getByTestId("audio-why"));
    expect(screen.getByTestId("audio-why-text")).toHaveTextContent("The connection dropped");
    fireEvent.click(screen.getByTestId("audio-retry"));
    expect(retryFile).toHaveBeenCalledWith("chat1-out-song");
  });
});
