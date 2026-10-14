import { act, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallOverlay } from "../../components/CallOverlay";
import { FakeMediaStream, FakeTrack } from "../../../../../packages/react/test/fakes";
import { renderApp } from "../render";
import { installFakeMedia, media, removeFakeMedia } from "../voice/fakeMedia";
import { setCallLevels } from "../../lib/voiceLevels";

// covers: calls.speaking

/**
 * Who is speaking in a call: each side's avatar (the contact's, and yours in a voice call) says `data-speaking` and
 * carries the level of its voice, which the stylesheet draws as a ring. `media.level` is what the analyser on their stream "hears".
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
    expect(avatar().style.getPropertyValue("--voice-level")).toBe("0.4");
    hear(0.2, 320);
    expect(avatar().style.getPropertyValue("--voice-level")).toBe("0.8");
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

  it("moves the ring in tenths, and leaves it alone while the voice wavers by hundredths", async () => {
    call();
    hear(0.14);
    expect(avatar().style.getPropertyValue("--voice-level")).toBe("0.6");
    // A steady voice: every write, even of the same value, would repaint the call window.
    const writes: string[] = [];
    const watch = new MutationObserver((seen) => writes.push(...seen.map((one) => one.attributeName!)));
    watch.observe(avatar(), { attributes: true });
    for (const level of [0.142, 0.14, 0.142, 0.14, 0.142, 0.14]) hear(level);
    await Promise.resolve();
    expect(writes).toEqual([]);

    hear(0.2);
    await Promise.resolve();
    expect(avatar().style.getPropertyValue("--voice-level")).toBe("0.8");
    expect(writes).toEqual(["style"]);
    watch.disconnect();
  });

  it("holds each width of the ring a while, so a talking voice redraws it a few times a second at most", async () => {
    call();
    hear(0.05);
    hear(0.225);
    const writes: string[] = [];
    const watch = new MutationObserver((seen) => writes.push(...seen.map((one) => one.attributeName!)));
    watch.observe(avatar(), { attributes: true });
    // Syllables: the level swings between 0.2 and 0.9 at every tick, for two seconds.
    for (let tick = 0; tick < 25; tick++) hear(tick % 2 ? 0.225 : 0.05);
    await Promise.resolve();
    watch.disconnect();
    expect(avatar()).toHaveAttribute("data-speaking", "true");
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.length).toBeLessThanOrEqual(7);
  });

  it("draws the ring with no transition, which would restart at every new level", () => {
    const css = readFileSync(join(fileURLToPath(import.meta.url), "../../../index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const avatarRules = [...css.matchAll(/([^{}]*\.call-avatar[^{}]*)\{([^{}]*)\}/g)].map(([, , body]) => body);
    expect(avatarRules.length).toBeGreaterThan(0);
    for (const body of avatarRules) expect(body).not.toMatch(/transition/);
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

  it("shows your own side beside the contact's in a voice call, ringed by your microphone", () => {
    call({ localStream: voice(), remoteStream: null });
    const you = screen.getByTestId("call-self-avatar");
    expect(you.parentElement).toHaveTextContent("You");
    expect(you).toHaveAttribute("data-muted", "false");
    hear(0.1);
    expect(you).toHaveAttribute("data-speaking", "true");
    expect(you.style.getPropertyValue("--voice-level")).toBe("0.4");
    // The contact's stream has no sound here: only your side is marked.
    expect(avatar()).not.toHaveAttribute("data-speaking");
  });

  it("keeps your ring quiet while you are muted, whatever the microphone hears", () => {
    const { rerender } = call({ localStream: voice(), remoteStream: null });
    hear(0.1);
    expect(screen.getByTestId("call-self-avatar")).toHaveAttribute("data-speaking", "true");

    rerender({ isMuted: true });
    hear(0.2);
    expect(screen.getByTestId("call-self-avatar")).toHaveAttribute("data-muted", "true");
    expect(screen.getByTestId("call-self-avatar")).not.toHaveAttribute("data-speaking");

    rerender({ isMuted: false });
    hear(0.2);
    expect(screen.getByTestId("call-self-avatar")).toHaveAttribute("data-speaking", "true");
  });

  it("takes both levels from the call itself where the page cannot hear it (Linux Desktop)", () => {
    // There the microphone's track is a silent stand-in and a voice call has no stream of the contact.
    const microphone = new FakeTrack("audio");
    const said = { own: [] as ((level: number) => void)[], peer: [] as ((level: number) => void)[] };
    const stopped = vi.fn();
    const side = (of: "own" | "peer") => (heard: (level: number) => void) => {
      said[of].push(heard);
      heard(0);
      return () => stopped(of);
    };
    setCallLevels(microphone as unknown as MediaStreamTrack, { own: side("own"), peer: side("peer") });
    const { rerender } = call({ localStream: new FakeMediaStream([microphone]) as unknown as MediaStream, remoteStream: null });
    const you = screen.getByTestId("call-self-avatar");

    // Whatever an analyser would read of the silent track, it is not asked.
    hear(0.2);
    expect(avatar()).toHaveAttribute("data-speaking", "false");
    expect(you).toHaveAttribute("data-speaking", "false");

    said.peer[0](0.5);
    hear(0.2);
    expect(avatar()).toHaveAttribute("data-speaking", "true");
    expect(avatar().style.getPropertyValue("--voice-level")).toBe("0.5");
    expect(you).toHaveAttribute("data-speaking", "false");
    said.own[0](0.3);
    hear(0.2);
    expect(you.style.getPropertyValue("--voice-level")).toBe("0.3");

    // A level is said once and holds until the next: the contact goes on speaking, then stops.
    hear(0.2, 800);
    expect(avatar()).toHaveAttribute("data-speaking", "true");
    said.peer[0](0);
    hear(0.2, 800);
    expect(avatar()).toHaveAttribute("data-speaking", "false");

    // Muted, your side stops listening.
    rerender({ isMuted: true });
    expect(stopped).toHaveBeenCalledWith("own");
    expect(you).not.toHaveAttribute("data-speaking");
  });

  it("leaves your avatar out where your picture shows, and before the call connects", () => {
    const { rerender } = call({ localStream: voice(), isVideoOff: false });
    expect(screen.queryByTestId("call-self-avatar")).toBeNull();
    rerender({ isVideoOff: true, callState: "connecting" });
    expect(screen.queryByTestId("call-self-avatar")).toBeNull();
  });
});
