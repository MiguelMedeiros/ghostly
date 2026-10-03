import { screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { CallButtons } from "../../components/CallButtons";
import { CallOverlay } from "../../components/CallOverlay";
import { IncomingCallNotification } from "../../components/IncomingCallNotification";
import { FakeMediaStream, FakeTrack } from "../../../../../packages/react/test/fakes";
import { renderApp } from "../render";

// covers: calls.screen-share, calls.audio, calls.video, calls.mini-window, calls.end-and-answer, calls.reconnect

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

  it("says Reconnecting in place of the clock while a call gets its path back, and the clock goes on after", () => {
    const { rerender } = overlay({ callStartedAt: Date.now() - 65_000, reconnecting: true });
    const status = screen.getByTestId("call-status");
    expect(status).toHaveTextContent("Reconnecting...");
    expect(status).toHaveAttribute("data-state", "connected");
    expect(status).toHaveAttribute("data-reconnecting", "true");
    expect(status).not.toHaveTextContent(/\d\d:\d\d/);
    // Read out once, by the line a screen reader hears.
    expect(screen.getByTestId("call-state-spoken")).toHaveTextContent(/^Reconnecting\.\.\.$/);
    // The call's controls stay: it can be hung up or muted meanwhile.
    expect(screen.getByTitle("End call")).toBeEnabled();

    const props = { localStream: null, remoteStream: null, isMuted: false, isVideoOff: true, canSendVideo: true, remoteHasVideo: false, callStartedAt: Date.now() - 65_000,
      peerName: "Ana", onHangUp: vi.fn(), onToggleMute: vi.fn(), onToggleVideo: vi.fn() };
    rerender(<CallOverlay callState="connected" {...props} />);
    expect(screen.getByTestId("call-status")).not.toHaveAttribute("data-reconnecting");
    expect(screen.getByTestId("call-status")).not.toHaveTextContent("Reconnecting...");
    expect(screen.getByTestId("call-state-spoken")).toHaveTextContent(/^Connected$/);
  });
});

describe("a call ringing while you are on another (End and answer)", () => {
  it("offers End and answer and Decline only, named for a screen reader and under each button, with the keys kept in it", async () => {
    const onAcceptAudio = vi.fn(), onAcceptVideo = vi.fn(), onReject = vi.fn();
    const { user } = renderApp(<IncomingCallNotification peerName="Ana" hasVideo={false} onCall onAcceptAudio={onAcceptAudio} onAcceptVideo={onAcceptVideo} onReject={onReject} />);
    const ring = screen.getByRole("alertdialog", { name: "Ana" });
    expect(ring).toHaveAccessibleDescription("Incoming audio call... Answering ends your current call");
    expect(ring).toHaveFocus();
    // An Enter meant for the message does not end the call that is on.
    await user.keyboard("{Enter}");
    expect(onAcceptAudio).not.toHaveBeenCalled();

    const buttons = within(ring).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Decline", "End and answer"]);
    expect(buttons.map((b) => b.getAttribute("title"))).toEqual(["Decline", "End and answer"]);
    // The words are on screen too: no icon says "End and answer".
    expect(within(ring).getAllByText("End and answer")).toHaveLength(1);
    expect(within(ring).queryByRole("button", { name: /^Accept/ })).toBeNull();

    await user.tab();
    await user.tab();
    expect(buttons[1]).toHaveFocus();
    await user.tab();
    expect(buttons[0]).toHaveFocus();
    await user.tab();
    await user.keyboard("{Enter}");
    expect(onAcceptAudio).toHaveBeenCalledOnce();
    expect(onAcceptVideo).not.toHaveBeenCalled();
  });

  it("answers a video call as it came, with the camera; Decline declines", async () => {
    const onAcceptVideo = vi.fn(), onReject = vi.fn();
    const { user } = renderApp(<IncomingCallNotification peerName="Ana" hasVideo onCall onAcceptAudio={vi.fn()} onAcceptVideo={onAcceptVideo} onReject={onReject} />);
    expect(screen.getByRole("alertdialog")).toHaveAccessibleDescription("Incoming video call... Answering ends your current call");
    await user.click(screen.getByRole("button", { name: "End and answer" }));
    expect(onAcceptVideo).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Decline" }));
    expect(onReject).toHaveBeenCalledOnce();
  });

  it("goes back to the plain Accept once the call that was on has ended", () => {
    const props = { peerName: "Ana", hasVideo: true, onAcceptAudio: vi.fn(), onAcceptVideo: vi.fn(), onReject: vi.fn() };
    const { rerender } = renderApp(<IncomingCallNotification {...props} onCall />);
    rerender(<IncomingCallNotification {...props} onCall={false} />);
    const ring = screen.getByRole("alertdialog", { name: "Ana" });
    expect(ring).toHaveAccessibleDescription("Incoming video call...");
    expect(within(ring).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Decline", "Accept audio call", "Accept video call"]);
  });

  it("is said in every language", async () => {
    for (const language of ["en", "pt", "es", "fr", "it", "ja", "zh", "ar"]) {
      const calls = (await import(`../../locales/${language}/calls.json`)).default as Record<string, unknown>;
      for (const key of ["endAndAnswer", "endsCurrent", "onAnother"]) expect(calls[key], `${language} ${key}`).toEqual(expect.any(String));
    }
  });
});

describe("your own camera in the corner", () => {
  it("plays the camera's picture alone, never the microphone with it", () => {
    // Linux's microphone is a silent stand-in track; in the self view's stream it kept WebKitGTK from loading the picture.
    vi.stubGlobal("MediaStream", FakeMediaStream);
    // happy-dom's srcObject takes its own MediaStream only: what the page gives it is kept here.
    const given: unknown[] = [];
    const srcObject = vi.spyOn(HTMLMediaElement.prototype, "srcObject", "set").mockImplementation((stream) => { given.push(stream); });
    try {
      const camera = new FakeTrack("video");
      const microphone = new FakeTrack("audio");
      overlay({ isVideoOff: false, localStream: new FakeMediaStream([camera, microphone]) as unknown as MediaStream });
      expect(screen.getByTestId("call-self-view").querySelector("video")).not.toBeNull();
      expect(given).toHaveLength(1);
      expect((given[0] as FakeMediaStream).getTracks()).toEqual([camera]);
    } finally {
      srcObject.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe("the contact's sound", () => {
  it("plays from one element only, on the chosen speaker: the picture is muted", () => {
    vi.stubGlobal("MediaStream", FakeMediaStream);
    // happy-dom's srcObject takes its own MediaStream only: what the page gives each element is kept here.
    const given = new Map<HTMLMediaElement, unknown>();
    const srcObject = vi.spyOn(HTMLMediaElement.prototype, "srcObject", "set").mockImplementation(function (this: HTMLMediaElement, stream) { given.set(this, stream); });
    const sinks: string[] = [];
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { configurable: true, value: async function (this: HTMLMediaElement) { sinks.push(this.tagName); } });
    try {
      const remote = new FakeMediaStream([new FakeTrack("audio"), new FakeTrack("video")]);
      const devices = { list: { audioinput: [], videoinput: [], audiooutput: [], defaults: {}, named: true }, current: { audioinput: "", videoinput: "", audiooutput: "spk" },
        speaker: "spk", speakers: true, choose: vi.fn(), notice: null, dismiss: vi.fn(), switchBack: vi.fn() };
      overlay({ remoteStream: remote as unknown as MediaStream, remoteHasVideo: true, devices });
      const showing = [...document.querySelectorAll<HTMLMediaElement>("audio, video")].filter((element) => given.get(element) === remote);
      // The <audio> and the picture both show the contact's stream; only one may sound, or the voice comes out twice.
      expect(showing.map((element) => element.tagName)).toEqual(["AUDIO", "VIDEO"]);
      expect(showing.filter((element) => !element.muted).map((element) => element.tagName)).toEqual(["AUDIO"]);
      expect(sinks).toEqual(["AUDIO"]);
    } finally {
      srcObject.mockRestore();
      delete (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId;
      vi.unstubAllGlobals();
    }
  });
});
