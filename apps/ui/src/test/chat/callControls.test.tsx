import { screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { CallButtons } from "../../components/CallButtons";
import { CallOverlay } from "../../components/CallOverlay";
import { IncomingCallNotification } from "../../components/IncomingCallNotification";
import { renderApp } from "../render";

// covers: calls.screen-share, calls.audio, calls.video, calls.mini-window

/**
 * The chat header starts a voice or a video call, and nothing else; the screen is shared from inside a call,
 * voice or video, in the full call window and in the small one.
 */

describe("the chat header's call buttons", () => {
  it("are a voice call and a video call, with no screen share among them", async () => {
    const onCall = vi.fn();
    const { user, container } = renderApp(<CallButtons blocked={null} busy={false} onCall={onCall} />);

    expect([...container.querySelectorAll("button")].map((b) => b.dataset.testid)).toEqual(["call-audio", "call-video"]);
    expect(screen.queryByTestId("call-screen")).toBeNull();
    expect(screen.queryByRole("button", { name: /screen/i })).toBeNull();
    expect(screen.getByTestId("call-audio")).toHaveAttribute("title", "Audio call");
    expect(screen.getByTestId("call-video")).toHaveAttribute("title", "Video call");

    await user.click(screen.getByTestId("call-audio"));
    await user.click(screen.getByTestId("call-video"));
    expect(onCall.mock.calls).toEqual([[false], [true]]);
  });

  it("are off with the reason when the chat cannot call, and off during a call", () => {
    const { rerender } = renderApp(<CallButtons blocked="Calls need a live connection" busy={false} onCall={vi.fn()} />);
    for (const id of ["call-audio", "call-video"]) {
      expect(screen.getByTestId(id)).toBeDisabled();
      expect(screen.getByTestId(id)).toHaveAttribute("title", "Calls need a live connection");
    }

    rerender(<CallButtons blocked={null} busy onCall={vi.fn()} />);
    for (const id of ["call-audio", "call-video"]) expect(screen.getByTestId(id)).toBeDisabled();
  });
});

type OverlayProps = ComponentProps<typeof CallOverlay>;

function overlay(props: Partial<OverlayProps> = {}) {
  const onToggleScreenShare = vi.fn();
  const view = renderApp(
    <CallOverlay
      callState="connected"
      localStream={null}
      remoteStream={null}
      isMuted={false}
      isVideoOff
      canSendVideo
      canShareScreen
      remoteHasVideo={false}
      callStartedAt={Date.now()}
      peerName="Ana"
      onHangUp={vi.fn()}
      onToggleMute={vi.fn()}
      onToggleVideo={vi.fn()}
      onToggleScreenShare={onToggleScreenShare}
      {...props}
    />,
  );
  return { ...view, onToggleScreenShare, window: () => screen.getByTestId("call-window") };
}

describe("sharing the screen from inside a call", () => {
  it("is offered in a voice call", async () => {
    const { user, onToggleScreenShare } = overlay();
    const share = screen.getByTestId("share-screen");

    expect(share).toBeEnabled();
    expect(share).toHaveAttribute("title", "Share screen");
    expect(share).toHaveAccessibleName("Share screen");
    expect(share).toHaveAttribute("aria-pressed", "false");
    await user.click(share);
    expect(onToggleScreenShare).toHaveBeenCalledOnce();
  });

  it("is offered in a video call", () => {
    overlay({ isVideoOff: false });
    expect(screen.getByTestId("share-screen")).toBeEnabled();
    expect(screen.getByTitle("Turn camera off")).toBeInTheDocument();
  });

  it("while sharing, says Stop sharing, tells you so, and shows the camera as off", () => {
    overlay({ isVideoOff: false, isScreenSharing: true });

    const share = screen.getByTestId("share-screen");
    expect(share).toHaveAttribute("title", "Stop sharing");
    expect(share).toHaveAccessibleName("Stop sharing");
    expect(share).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("call-sharing")).toHaveTextContent("You're sharing your screen");
    // The screen took the camera's place: the camera button turns it back on.
    expect(screen.getByTitle("Turn camera on")).toBeInTheDocument();
  });

  it("tells you when the other side is sharing theirs", () => {
    overlay({ remoteHasVideo: true, remoteIsScreenSharing: true });
    expect(screen.getByTestId("call-sharing")).toHaveTextContent("Ana is sharing their screen");
    expect(screen.getByTestId("call-sharing")).toHaveAttribute("data-peer", "true");
  });

  it("says nothing about sharing when nobody is", () => {
    overlay({ remoteHasVideo: true, isVideoOff: false });
    expect(screen.queryByTestId("call-sharing")).toBeNull();
  });

  it("is off, with the reason, when the call cannot carry a screen", async () => {
    const { user, onToggleScreenShare } = overlay({ canShareScreen: false, screenShareUnavailable: "Your contact's app cannot show a screen in this call" });
    const share = screen.getByTestId("share-screen");

    expect(share).toBeDisabled();
    expect(share).toHaveAttribute("title", "Your contact's app cannot show a screen in this call");
    await user.click(share);
    expect(onToggleScreenShare).not.toHaveBeenCalled();
  });

  it("is not there at all where no screen can be captured (phones)", () => {
    overlay({ canShareScreen: false, screenShareUnavailable: null });
    expect(screen.queryByTestId("share-screen")).toBeNull();
    // The camera still is.
    expect(screen.getByTitle("Turn camera on")).toBeInTheDocument();
  });

  it("explains why a share failed", () => {
    overlay({ screenShareError: "Screen sharing is blocked. Allow screen recording for this app in your system's privacy settings." });
    expect(screen.getByRole("alert")).toHaveTextContent("Allow screen recording");
  });

  it("is in the small window too, with the notice, when the call follows you out of its chat", async () => {
    const onReturnToChat = vi.fn();
    const { user, onToggleScreenShare, window } = overlay({ pinned: true, onReturnToChat, isScreenSharing: true, isVideoOff: false });

    expect(window()).toHaveAttribute("data-mini", "true");
    const share = within(window()).getByTestId("share-screen");
    expect(share).toHaveAttribute("title", "Stop sharing");
    expect(within(window()).getByTestId("call-sharing")).toHaveTextContent("You're sharing your screen");
    await user.click(share);
    expect(onToggleScreenShare).toHaveBeenCalledOnce();
  });

  it("waits for the call to connect", () => {
    overlay({ callState: "offering", canShareScreen: false, isScreenSharing: false });
    expect(screen.queryByTestId("share-screen")).toBeNull();
    expect(screen.queryByTestId("call-sharing")).toBeNull();
  });
});

describe("a call for a screen reader and the keys", () => {
  it("rings as a dialog named for the caller: the focus in it, not on Accept, the keys kept in it, back where it was after", async () => {
    const before = document.createElement("textarea");
    document.body.append(before);
    before.focus();
    const onAcceptAudio = vi.fn();
    const { user, unmount } = renderApp(<IncomingCallNotification peerName="Ana" hasVideo onAcceptAudio={onAcceptAudio} onAcceptVideo={vi.fn()} onReject={vi.fn()} />);
    const ring = screen.getByRole("alertdialog", { name: "Ana" });
    expect(ring).toHaveAccessibleDescription("Incoming video call...");
    expect(ring).toHaveAttribute("aria-modal", "true");
    expect(ring).toHaveFocus();
    // An Enter meant for the message does not answer.
    await user.keyboard("{Enter}");
    expect(onAcceptAudio).not.toHaveBeenCalled();
    const buttons = within(ring).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Decline", "Accept audio call", "Accept video call"]);
    await user.tab();
    await user.tab();
    await user.tab();
    expect(buttons[2]).toHaveFocus();
    await user.tab();
    expect(buttons[0]).toHaveFocus();
    unmount();
    expect(before).toHaveFocus();
    before.remove();
  });

  it("says the call's state in words as it moves on, never the running clock", () => {
    const { rerender } = overlay({ callState: "offering" });
    // Calling... is the state line itself, read out as it changes; nothing says it twice.
    expect(screen.getByTestId("call-status")).toHaveAttribute("role", "status");
    expect(screen.getByTestId("call-status")).toHaveTextContent("Calling...");
    expect(screen.getAllByText("Calling...")).toHaveLength(1);
    expect(screen.getByTestId("call-state-spoken")).toHaveTextContent(/^$/);
    const props = { localStream: null, remoteStream: null, isMuted: false, isVideoOff: true, canSendVideo: true, remoteHasVideo: false, callStartedAt: Date.now() - 65_000,
      peerName: "Ana", onHangUp: vi.fn(), onToggleMute: vi.fn(), onToggleVideo: vi.fn() };
    rerender(<CallOverlay callState="connected" {...props} />);
    // Connected: said once; the line becomes the clock and stops being read out.
    expect(screen.getByTestId("call-state-spoken")).toHaveAttribute("role", "status");
    expect(screen.getByTestId("call-state-spoken")).toHaveTextContent(/^Connected$/);
    expect(screen.getByTestId("call-status")).not.toHaveAttribute("role");
  });
});
