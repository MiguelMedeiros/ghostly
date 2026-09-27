import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageBubble } from "../../components/MessageBubble";
import { VideoBubble } from "../../components/video/VideoBubble";
import { videoBox } from "../../lib/videoPlayer";
import { servicesPlatform, type FileTransferState } from "../../lib/platform";
import type { ChatFile, ChatMessage } from "../../lib/types";
import { fakeEngine, linkView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: files.video.play

const MB = 1024 ** 2;
// A JPEG's first bytes, base64url: enough to be shown as the poster.
const POSTER = "_9j_4AAQSkZJRg";
let n = 0;
const last = <T,>(list: T[]): T | undefined => list[list.length - 1];

const video = (patch: Partial<ChatFile> = {}): ChatFile => ({
  id: `chat1-in-video${++n}`, name: "ghosts.mp4", size: 35 * MB, mime: "video/mp4",
  video: { duration: 12_000, width: 1280, height: 720, poster: POSTER }, ...patch,
});

function show(file: ChatFile, transfer: FileTransferState | null = null, sender: "me" | "peer" = "peer") {
  fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: transfer ? { [file.id]: transfer } : {} });
  return renderApp(<VideoBubble file={file} sender={sender} peerName="Ana" />);
}

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

let canPlay: (type: string) => CanPlayTypeResult;
let play: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn>;
let getFile: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  canPlay = () => "maybe";
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockImplementation((type: string) => canPlay(type));
  play = vi.fn(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: false });
    return Promise.resolve();
  });
  pause = vi.fn(function (this: HTMLMediaElement) { Object.defineProperty(this, "paused", { configurable: true, value: true }); });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play as unknown as () => Promise<void>);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause as unknown as () => void);
  getFile = vi.spyOn(servicesPlatform!, "getFile").mockResolvedValue(new Blob(["mp4"], { type: "video/mp4" }));
  fakeEngine.on("fileAction", () => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("a video in the chat", () => {
  it("is routed to the video bubble by its type, with or without a description", () => {
    const message = (file: ChatFile): ChatMessage => ({ id: `peer_${file.id}`, text: "🎬 Video (0:12)", sender: "peer", timestamp: 1_700_000_000_000, file });
    fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: {} });
    const view = renderApp(<MessageBubble message={message(video())} peerPubKey="peer" />);
    expect(screen.getByTestId("video-bubble")).toBeInTheDocument();
    expect(screen.queryByTestId("file-bubble")).toBeNull();
    view.unmount();
    // From an app that sends no description: still a video, with its size where the length would be.
    renderApp(<MessageBubble message={message(video({ video: undefined }))} peerPubKey="peer" />);
    expect(screen.getByTestId("video-bubble")).toBeInTheDocument();
    expect(screen.getByTestId("video-duration")).toHaveTextContent("35.0 MB");
  });

  it("shows the sender's poster, its length and a big play button before it plays", () => {
    show(video());
    expect(screen.getByTestId("video-poster").getAttribute("src")).toBe("data:image/jpeg;base64,/9j/4AAQSkZJRg==");
    expect(screen.getByTestId("video-duration")).toHaveTextContent("0:12");
    expect(screen.getByRole("button", { name: "Play video" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Video, 0:12" })).toBeInTheDocument();
    // Nothing was read to show it.
    expect(getFile).not.toHaveBeenCalled();
    expect(screen.queryByTestId("video-player")).toBeNull();
  });

  it("plays in place when tapped, from its bytes, with the browser's controls", async () => {
    show(video());
    fireEvent.click(screen.getByTestId("video-play"));
    await flush();
    const player = screen.getByTestId("video-player") as HTMLVideoElement;
    expect(player.getAttribute("src")).toMatch(/^blob:/);
    expect(player.controls).toBe(true);
    expect(player).toHaveAttribute("playsinline");
    expect(play).toHaveBeenCalled();
    expect(screen.getByTestId("video-bubble")).toHaveAttribute("data-phase", "playing");
  });

  it("Space and Enter on the video toggle it", async () => {
    show(video());
    fireEvent.click(screen.getByTestId("video-play"));
    await flush();
    const frame = screen.getByTestId("video-frame");
    expect(frame).toHaveAttribute("tabindex", "0");
    const plays = play.mock.calls.length;
    fireEvent.keyDown(frame, { key: " " });
    expect(pause).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(frame, { key: "Enter" });
    expect(play.mock.calls.length).toBe(plays + 1);
  });

  it("one plays at a time: starting another pauses the first", async () => {
    const first = video(), second = video();
    fakeEngine.update({ links: [linkView({ id: "chat1" })], transfers: {} });
    renderApp(<><VideoBubble file={first} sender="peer" /><VideoBubble file={second} sender="peer" /></>);
    const [a, b] = screen.getAllByTestId("video-play");
    fireEvent.click(a!);
    await flush();
    const firstPlayer = screen.getByTestId("video-player");
    fireEvent.play(firstPlayer);
    fireEvent.click(b!);
    await flush();
    expect(pause.mock.contexts).toContain(firstPlayer);
    // The first let go of its bytes: only the second is loaded.
    expect(screen.getAllByTestId("video-player")).toHaveLength(1);
    expect(firstPlayer.isConnected).toBe(false);
  });

  it("when it ends, it goes back to its poster and lets go of its bytes", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    show(video());
    fireEvent.click(screen.getByTestId("video-play"));
    await flush();
    const url = screen.getByTestId("video-player").getAttribute("src");
    fireEvent.ended(screen.getByTestId("video-player"));
    expect(screen.queryByTestId("video-player")).toBeNull();
    expect(screen.getByTestId("video-poster")).toBeInTheDocument();
    expect(revoke).toHaveBeenCalledWith(url);
  });

  it("scrolled out of view it stops and lets go of its bytes; played again, it goes on from there", async () => {
    let seen: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) { seen = callback; }
      observe() {}
      disconnect() {}
    });
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    show(video());
    act(() => seen!([{ isIntersecting: true }]));
    fireEvent.click(screen.getByTestId("video-play"));
    await flush();
    const player = screen.getByTestId("video-player") as HTMLVideoElement;
    const url = player.getAttribute("src");
    player.currentTime = 7;
    act(() => seen!([{ isIntersecting: false }]));
    expect(screen.queryByTestId("video-player")).toBeNull();
    expect(pause.mock.contexts).toContain(player);
    expect(revoke).toHaveBeenCalledWith(url);
    act(() => seen!([{ isIntersecting: true }]));
    fireEvent.click(screen.getByTestId("video-play"));
    await flush();
    expect((screen.getByTestId("video-player") as HTMLVideoElement).currentTime).toBe(7);
    vi.unstubAllGlobals();
  });

  it("a type this device does not play offers Download instead of play", async () => {
    canPlay = (type) => (type === "video/webm" ? "" : "maybe");
    const saveFile = vi.spyOn(servicesPlatform!, "saveFile").mockResolvedValue(true);
    const file = video({ name: "clip.webm", mime: "video/webm" });
    show(file);
    expect(screen.queryByTestId("video-play")).toBeNull();
    expect(screen.getByTestId("video-problem")).toHaveTextContent("This device can't play this video (WebM). Download it to watch.");
    fireEvent.click(screen.getByTestId("video-download"));
    await waitFor(() => expect(saveFile).toHaveBeenCalledWith(file.id, "clip.webm"));
  });

  it("a type never served as itself (Matroska) is not handed to the player", () => {
    show(video({ name: "film.mkv", mime: "video/x-matroska" }));
    expect(screen.getByTestId("video-bubble")).toHaveAttribute("data-playable", "false");
    expect(screen.getByTestId("video-problem")).toHaveTextContent("(MKV)");
  });

  it("refused by the player once started, it says so and offers Download", async () => {
    play.mockImplementationOnce(() => Promise.reject(new DOMException("no decoder", "NotSupportedError")));
    show(video());
    fireEvent.click(screen.getByTestId("video-play"));
    await flush();
    await flush();
    expect(screen.queryByTestId("video-player")).toBeNull();
    expect(screen.getByTestId("video-problem")).toHaveTextContent("This device can't play this video (MP4). Download it to watch.");
    expect(screen.getByTestId("video-download")).toBeInTheDocument();
  });

  it("too large to hand out here (Desktop above its limit): Download to watch", async () => {
    getFile.mockResolvedValue(null);
    vi.spyOn(servicesPlatform!, "saveFile").mockResolvedValue(true);
    show(video());
    fireEvent.click(screen.getByTestId("video-play"));
    await flush();
    expect(screen.getByTestId("video-problem")).toHaveTextContent("Too large to play here. Download it to watch.");
  });
});

describe("a video not here yet", () => {
  it("a large one the person has to accept shows Download <size>, and answers through the engine", async () => {
    const file = video();
    show(file, { state: "transferring", stage: "asking", direction: "in", transferred: 0, size: file.size, room: 12 * 1024 * MB });
    expect(screen.getByTestId("video-accept")).toHaveTextContent("Download 35.0 MB");
    expect(screen.getByTestId("video-room")).toHaveTextContent("Ana wants to send it · 12.0 GB free");
    expect(screen.queryByTestId("video-play")).toBeNull();
    // The poster and length are there before a byte is.
    expect(screen.getByTestId("video-poster")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("video-accept"));
    await waitFor(() => expect(fakeEngine.callsTo("fileAction")).toEqual([{ linkId: "chat1", fileId: file.id, action: "accept" }]));
    fireEvent.click(screen.getByTestId("video-decline"));
    await waitFor(() => expect(last(fakeEngine.callsTo("fileAction"))?.action).toBe("decline"));
  });

  it("an offer larger than the room here cannot be accepted", () => {
    const file = video();
    show(file, { state: "transferring", stage: "asking", direction: "in", transferred: 0, size: file.size, room: 10 * MB });
    expect(screen.getByTestId("video-accept")).toBeDisabled();
    expect(screen.getByTestId("video-room")).toHaveTextContent("Not enough space: 10.0 MB free");
  });

  it("while it arrives: the ring with how much is here, the status, and pause/cancel", async () => {
    const file = video();
    show(file, { state: "transferring", direction: "in", transferred: 14 * MB, size: file.size });
    expect(screen.getByTestId("video-progress")).toHaveTextContent("40%");
    expect(screen.getByTestId("video-status")).toHaveTextContent("40% of 35.0 MB");
    expect(screen.queryByTestId("video-play")).toBeNull();
    expect(screen.queryByTestId("video-save")).toBeNull();
    fireEvent.click(screen.getByTestId("video-pause-transfer"));
    await waitFor(() => expect(last(fakeEngine.callsTo("fileAction"))?.action).toBe("pause"));
    fireEvent.click(screen.getByTestId("video-cancel"));
    await waitFor(() => expect(last(fakeEngine.callsTo("fileAction"))?.action).toBe("cancel"));
  });

  it("once in, it plays", () => {
    const file = video();
    const view = show(file, { state: "transferring", direction: "in", transferred: 14 * MB, size: file.size });
    act(() => fakeEngine.update({ transfers: { [file.id]: { state: "done", direction: "in", transferred: file.size, size: file.size } } }));
    view.rerender(<VideoBubble file={file} sender="peer" peerName="Ana" />);
    expect(screen.getByTestId("video-play")).toBeInTheDocument();
    expect(screen.queryByTestId("video-progress")).toBeNull();
  });

  it("one sent from here can be watched while it goes", () => {
    const file = video({ id: "chat1-out-video" });
    show(file, { state: "transferring", direction: "out", transferred: 14 * MB, size: file.size }, "me");
    expect(screen.getByTestId("video-play")).toBeInTheDocument();
    expect(screen.getByTestId("video-status")).toHaveTextContent("40% of 35.0 MB");
  });
});

describe("a video that did not go", () => {
  it("offers the round Send again, says Not sent, and keeps the reason behind its ⓘ", async () => {
    const retryFile = vi.spyOn(servicesPlatform!, "retryFile").mockResolvedValue();
    const file = video({ id: "chat1-out-failed" });
    show(file, { state: "failed", direction: "out", transferred: 0, size: file.size, error: "The connection dropped", retry: true }, "me");
    expect(screen.getByTestId("video-status")).toHaveTextContent("Not sent");
    expect(screen.queryByText("The connection dropped")).toBeNull();
    fireEvent.click(screen.getByTestId("video-why"));
    expect(screen.getByTestId("video-why-text")).toHaveTextContent("The connection dropped");
    fireEvent.click(screen.getByTestId("video-retry"));
    expect(retryFile).toHaveBeenCalledWith("chat1-out-failed");
  });

  it("a stuck one offers Ask again", async () => {
    const file = video();
    show(file, { state: "transferring", direction: "in", transferred: 14 * MB, size: file.size, stalled: true });
    fireEvent.click(screen.getByTestId("video-request"));
    await waitFor(() => expect(last(fakeEngine.callsTo("fileAction"))?.action).toBe("request"));
  });
});

describe("the video's box", () => {
  it("is as wide as a picture, a tall one capped in height", () => {
    expect(videoBox(1920, 1080)).toEqual({ width: 300, height: 169 });
    expect(videoBox(1080, 1920)).toEqual({ width: 186, height: 330 });
    // Very tall: not narrower than a thumb, shown letterboxed.
    expect(videoBox(100, 1000)).toEqual({ width: 140, height: 330 });
    // Nothing known: 16:9.
    expect(videoBox(undefined, undefined)).toEqual({ width: 300, height: 169 });
  });
});
