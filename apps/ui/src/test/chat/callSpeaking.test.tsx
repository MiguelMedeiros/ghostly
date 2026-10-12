import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallOverlay } from "../../components/CallOverlay";
import { FakeMediaStream, FakeTrack } from "../../../../../packages/react/test/fakes";
import { renderApp } from "../render";
import { installFakeMedia, media, removeFakeMedia } from "../voice/fakeMedia";

// covers: calls.speaking

/**
 * Who is speaking in a call: the contact's avatar says `data-speaking` and carries the level of their voice, which
 * the stylesheet draws as a ring. `media.level` is what the analyser on their stream "hears".
 */

const voice = () => new FakeMediaStream([new FakeTrack("audio")]) as unknown as MediaStream;

function call(props: Partial<React.ComponentProps<typeof CallOverlay>> = {}) {
  const view = (more: typeof props = {}) => (
    <CallOverlay
      callState="connected"
      localStream={null}
      remoteStream={voice()}
      isMuted={false}
      isVideoOff
      remoteHasVideo={false}
      callStartedAt={Date.now()}
      peerName="Ana"
      onHangUp={vi.fn()}
      onToggleMute={vi.fn()}
      onToggleVideo={vi.fn()}
      {...props}
      {...more}
    />
  );
  const { rerender } = renderApp(view());
  return { rerender: (more: typeof props) => rerender(view(more)) };
}

const avatar = () => screen.getByTestId("call-peer-avatar");
const hear = (level: number, ms = 80) => {
  media.level = level;
  act(() => { vi.advanceTimersByTime(ms); });
};

describe("who is speaking in a call", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installFakeMedia();
    // happy-dom's srcObject takes its own MediaStream only.
    vi.spyOn(HTMLMediaElement.prototype, "srcObject", "set").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    removeFakeMedia();
    vi.useRealTimers();
  });

  it("marks the contact's avatar while they speak, with the level of their voice", () => {
    call();
    hear(0);
    expect(avatar()).toHaveAttribute("data-speaking", "false");

    hear(0.1);
    expect(avatar()).toHaveAttribute("data-speaking", "true");
    expect(avatar().style.getPropertyValue("--voice-level")).toBe("0.40");
    hear(0.2);
    expect(avatar().style.getPropertyValue("--voice-level")).toBe("0.80");
  });

  it("keeps the mark between words, and drops it when they stop", () => {
    call();
    hear(0.1);
    hear(0, 240);
    expect(avatar()).toHaveAttribute("data-speaking", "true");
    hear(0, 400);
    expect(avatar()).toHaveAttribute("data-speaking", "false");
    expect(avatar().style.getPropertyValue("--voice-level")).toBe("0");
  });

  it("takes a breath or a fan for silence", () => {
    call();
    hear(0.01);
    expect(avatar()).toHaveAttribute("data-speaking", "false");
  });

  it("is on the small window's avatar too", () => {
    call({ pinned: true, onReturnToChat: vi.fn() });
    expect(screen.getByTestId("call-window")).toHaveAttribute("data-mini", "true");
    hear(0.1);
    expect(avatar()).toHaveAttribute("data-speaking", "true");
  });

  it("marks nobody before the call connects, or on a stream with no sound", () => {
    const { rerender } = call({ callState: "connecting" });
    hear(0.1);
    expect(avatar()).not.toHaveAttribute("data-speaking");

    // A Linux Desktop call: the sound stays in Rust, the page's stream is the picture alone.
    rerender({ callState: "connected", remoteStream: new FakeMediaStream([new FakeTrack("video")]) as unknown as MediaStream });
    hear(0.1);
    expect(avatar()).not.toHaveAttribute("data-speaking");
  });
});
