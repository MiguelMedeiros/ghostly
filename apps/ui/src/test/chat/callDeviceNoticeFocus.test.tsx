import { act, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CallOverlay } from "../../components/CallOverlay";
import type { CallDevices, DeviceNotice } from "../../hooks/useCallDevices";
import { EMPTY_DEVICES } from "../../lib/mediaDevices";
import { renderApp } from "../render";

// covers: calls.devices

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

describe("the call's device notice, gone with the keyboard focus on it", () => {
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
