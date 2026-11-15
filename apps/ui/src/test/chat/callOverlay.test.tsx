import { act, screen, cleanup } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { CallOverlay } from "../../components/CallOverlay";
import type { CallDevices, DeviceNotice } from "../../hooks/useCallDevices";
import { EMPTY_DEVICES } from "../../lib/mediaDevices";
import { renderApp } from "../render";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeMediaStream, FakeTrack } from "../../../../../packages/react/test/fakes";
import { installFakeMedia, removeFakeMedia } from "../voice/fakeMedia";

// covers: calls.devices
describe("the call's device notice, gone with the keyboard focus on it", () => {
  /**
   * The call's device notice ("… is back", Switch back) goes away by its own buttons or by running out. With the
   * keyboard focus on it, the focus went to the page's body (a real build, both widths): a screen reader lost its
   * place in the call, and the next Tab started over. It goes to the call's Devices button instead.
   */

  const BACK: DeviceNotice = { kind: "audioinput", type: "back", name: "Headset", id: "headset" };

  let hide: (() => void) | undefined;

  function Call({ mini = false }: { mini?: boolean }) {
    const [notice, setNotice] = useState<DeviceNotice | null>(BACK);
    useEffect(() => { hide = () => setNotice(null); }, []);
    const devices: CallDevices = {
      list: EMPTY_DEVICES,
      current: { audioinput: "", videoinput: "", audiooutput: "" },
      speaker: undefined,
      speakers: false,
      choose: vi.fn(),
      notice,
      dismiss: () => setNotice(null),
      switchBack: () => setNotice(null),
      hold: () => {},
    };
    return (
      <CallOverlay callState="connected" localStream={null} remoteStream={null} isMuted={false} isVideoOff canSendVideo remoteHasVideo={false}
        callStartedAt={Date.now()} peerName="Ana" onHangUp={vi.fn()} onToggleMute={vi.fn()} onToggleVideo={vi.fn()} pinned={mini} devices={devices} />
    );
  }

  it("leaves the focus on Devices after Switch back", async () => {
    const { user } = renderApp(<Call />);
    screen.getByTestId("call-device-switch-back").focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("call-device-notice")).toBeNull();
    expect(screen.getByTestId("call-devices")).toHaveFocus();
  });

  it("leaves the focus on Devices after its close button", async () => {
    const { user } = renderApp(<Call />);
    screen.getByRole("button", { name: "Close" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("call-device-notice")).toBeNull();
    expect(screen.getByTestId("call-devices")).toHaveFocus();
  });

  it("leaves the focus on Devices when it runs out, in the small window too", () => {
    for (const mini of [false, true]) {
      const { unmount } = renderApp(<Call mini={mini} />);
      screen.getByTestId("call-device-switch-back").focus();
      act(() => hide?.());
      expect(screen.queryByTestId("call-device-notice")).toBeNull();
      expect(screen.getByTestId("call-devices"), mini ? "small window" : "whole screen").toHaveFocus();
      unmount();
    }
  });

  it("leaves the focus alone when it was not on the notice", () => {
    renderApp(<Call />);
    screen.getByTestId("call-mute").focus();
    act(() => hide?.());
    expect(screen.getByTestId("call-mute")).toHaveFocus();
  });
});

// covers: calls.video
describe("the call's state line over the contact's picture", () => {
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
