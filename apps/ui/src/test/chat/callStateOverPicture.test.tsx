import { cleanup, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallOverlay } from "../../components/CallOverlay";
import { FakeMediaStream, FakeTrack } from "../../../../../packages/react/test/fakes";
import { renderApp } from "../render";
import { installFakeMedia, removeFakeMedia } from "../voice/fakeMedia";

// covers: calls.video

/**
 * The call's state line (its clock, "Reconnecting...") sits over the contact's picture in a video call. In the theme's
 * muted grey it was dark in a light theme (#5a6a74): 1.1:1 on a green picture, under 2:1 on a dim room, and the clock
 * could not be read. Over a picture it is white with a shadow, as the buttons there; with no picture, the theme's grey.
 */
const stream = (...kinds: ("audio" | "video")[]) => new FakeMediaStream(kinds.map((kind) => new FakeTrack(kind))) as unknown as MediaStream;

/** What the stylesheet gives the state line over a picture. */
const overPicture = () => {
  const css = readFileSync(join(fileURLToPath(import.meta.url), "../../../index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].filter(([, selector]) => /\.call-top p\[data-over-picture\]/.test(selector)).map(([, , body]) => body).join(";");
};

function call(props: Partial<React.ComponentProps<typeof CallOverlay>>) {
  renderApp(
    <CallOverlay callState="connected" localStream={null} remoteStream={stream("audio")} isMuted={false} isVideoOff remoteHasVideo={false}
      callStartedAt={Date.now()} peerName="Ana" onHangUp={vi.fn()} onToggleMute={vi.fn()} onToggleVideo={vi.fn()} {...props} />,
  );
  return screen.getByTestId("call-status");
}

describe("the call's state line over the contact's picture", () => {
  beforeEach(() => {
    installFakeMedia();
    vi.spyOn(HTMLMediaElement.prototype, "srcObject", "set").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    removeFakeMedia();
    localStorage.clear();
  });

  it("is white with a shadow over the picture, in the whole window and the small one", () => {
    const line = call({ remoteStream: stream("audio", "video"), remoteHasVideo: true });
    expect(line).toHaveAttribute("data-over-picture", "true");
    expect(overPicture()).toMatch(/color:\s*#fff/);
    expect(overPicture()).toMatch(/text-shadow:\s*0 1px 3px rgb\(0 0 0/);
    cleanup();
    const small = call({ remoteStream: stream("audio", "video"), remoteHasVideo: true, pinned: true });
    expect(screen.getByTestId("call-window")).toHaveAttribute("data-mini", "true");
    expect(small).toHaveAttribute("data-over-picture", "true");
  });

  it("keeps the theme's grey with no picture behind it: a voice call, or one still connecting", () => {
    expect(call({})).not.toHaveAttribute("data-over-picture");
    cleanup();
    const connecting = call({ callState: "connecting", remoteStream: stream("audio", "video"), remoteHasVideo: true });
    expect(connecting).not.toHaveAttribute("data-over-picture");
  });
});
