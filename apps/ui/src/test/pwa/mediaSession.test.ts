import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimMediaSession, mediaSessionPosition, mediaSessionState, releaseMediaSession } from "../../lib/mediaSession";

// covers: files.voice.media-session

type Handler = (details: { seekTime?: number; seekOffset?: number }) => void;
const handlers = new Map<string, Handler | null>();
const session = {
  metadata: null as unknown,
  playbackState: "none",
  setActionHandler: vi.fn((action: string, handler: Handler | null) => { handlers.set(action, handler); }),
  setPositionState: vi.fn(),
};
const player = () => ({ title: "Voice message", artist: "Ana", play: vi.fn(), pause: vi.fn(), seekTo: vi.fn(), next: vi.fn() });

beforeEach(() => {
  handlers.clear();
  session.metadata = null;
  session.playbackState = "none";
  session.setPositionState.mockClear();
  Object.defineProperty(navigator, "mediaSession", { configurable: true, value: session });
  vi.stubGlobal("MediaMetadata", class { constructor(public init: object) {} });
});
afterEach(() => {
  releaseMediaSession("a");
  releaseMediaSession("b");
  Reflect.deleteProperty(navigator, "mediaSession");
  vi.unstubAllGlobals();
});

describe("a voice message on the lock screen and the media keys", () => {
  it("shows what plays, and the system's buttons drive it", () => {
    const a = player();
    claimMediaSession("a", a);
    expect(session.metadata).toMatchObject({ init: { title: "Voice message", artist: "Ana" } });
    expect(session.playbackState).toBe("playing");
    handlers.get("pause")!({});
    handlers.get("play")!({});
    handlers.get("seekto")!({ seekTime: 4 });
    handlers.get("nexttrack")!({});
    expect(a.pause).toHaveBeenCalled();
    expect(a.play).toHaveBeenCalled();
    expect(a.seekTo).toHaveBeenCalledWith(4);
    expect(a.next).toHaveBeenCalled();
  });

  it("skips back and forward from where it is, inside the recording", () => {
    const a = player();
    claimMediaSession("a", a);
    mediaSessionPosition("a", 3, 10, 1.5);
    expect(session.setPositionState).toHaveBeenLastCalledWith({ duration: 10, playbackRate: 1.5, position: 3 });
    handlers.get("seekbackward")!({});
    expect(a.seekTo).toHaveBeenLastCalledWith(0);
    handlers.get("seekforward")!({ seekOffset: 10 });
    expect(a.seekTo).toHaveBeenLastCalledWith(10);
  });

  it("the one playing last owns it: an earlier one cannot change or clear it", () => {
    claimMediaSession("a", player());
    claimMediaSession("b", player());
    mediaSessionState("a", "paused");
    expect(session.playbackState).toBe("playing");
    releaseMediaSession("a");
    expect(session.playbackState).toBe("playing");
    releaseMediaSession("b");
    expect(session.playbackState).toBe("none");
    expect(session.metadata).toBeNull();
    expect(handlers.get("play")).toBeNull();
  });

  it("does nothing where there is no Media Session", () => {
    Reflect.deleteProperty(navigator, "mediaSession");
    expect(() => { claimMediaSession("a", player()); mediaSessionPosition("a", 1, 2); releaseMediaSession("a"); }).not.toThrow();
  });
});
