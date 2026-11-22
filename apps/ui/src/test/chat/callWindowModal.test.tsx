import "fake-indexeddb/auto";
import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CallOverlay } from "../../components/CallOverlay";
import type { CallDevices } from "../../hooks/useCallDevices";
import { EMPTY_DEVICES } from "../../lib/mediaDevices";
import { Chat } from "../../pages/Chat";
import { saveSession } from "../../lib/storage";
import { renderApp } from "../render";

// covers: calls.mini-window, calls.media-blocked, calls.devices

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

/** What the call hook says, set by the test: a call on, the camera refused in it, the microphone paused by the system. */
const hook = vi.hoisted(() => ({ mediaProblem: null as "denied" | null, micPaused: false }));
vi.mock("../../hooks/useWebRTC", async () => {
  const real = await vi.importActual<typeof import("../../hooks/useWebRTC")>("../../hooks/useWebRTC");
  return {
    useWebRTC: (options: Parameters<typeof real.useWebRTC>[0]) => {
      const webrtc = { ...real.useWebRTC(options), callState: "connected" as const, micPaused: hook.micPaused };
      return hook.mediaProblem ? { ...webrtc, mediaProblem: hook.mediaProblem, mediaProblemId: 1, mediaProblemOf: "camera" as const } : webrtc;
    },
  };
});

const PEER = "peer".padEnd(52, "p");

const devices: CallDevices = {
  list: EMPTY_DEVICES,
  current: { audioinput: "", videoinput: "", audiooutput: "" },
  speaker: undefined,
  speakers: false,
  choose: vi.fn(),
  notice: null,
  dismiss: vi.fn(),
  switchBack: vi.fn(),
  hold: () => {},
};

function Call({ pinned = false }: { pinned?: boolean }) {
  return (
    <CallOverlay callState="connected" localStream={null} remoteStream={null} isMuted={false} isVideoOff canSendVideo remoteHasVideo={false}
      callStartedAt={Date.now()} peerName="Ana" onHangUp={vi.fn()} onToggleMute={vi.fn()} onToggleVideo={vi.fn()} pinned={pinned} devices={devices} />
  );
}

afterEach(() => {
  hook.mediaProblem = null;
  hook.micPaused = false;
  localStorage.removeItem("ghostly_call_mini");
});

/**
 * The whole-screen call window takes the focus and keeps Tab inside, over the chat it covers, but a screen reader's
 * browse mode (NVDA/JAWS arrows, VoiceOver's VO+arrows) walked out of it into the chat list, the chat and its composer,
 * which the eye cannot see. It is modal for a screen reader too, and so whatever it shows has to be inside it.
 */
describe("the whole-screen call window, for a screen reader", () => {
  it("is a modal dialog named for the contact; the small window is not", () => {
    const { unmount } = renderApp(<Call />);
    const whole = screen.getByTestId("call-window");
    expect(whole).toHaveRole("dialog");
    expect(whole).toHaveAttribute("aria-modal", "true");
    expect(whole).toHaveAccessibleName("Ana");
    unmount();

    // Away from its chat, or made small: the chat beside it is in use.
    renderApp(<Call pinned />);
    const small = screen.getByTestId("call-window");
    expect(small).toHaveAttribute("data-mini", "true");
    expect(small).not.toHaveAttribute("aria-modal");
    expect(small).not.toHaveAttribute("role");
  });

  it("opens its device menu inside itself, and the small window's on the page", async () => {
    const { user, unmount } = renderApp(<Call />);
    await user.click(screen.getByTestId("call-devices"));
    expect(screen.getByTestId("call-window")).toContainElement(screen.getByTestId("call-devices-menu"));
    unmount();

    renderApp(<Call pinned />);
    await user.click(screen.getByTestId("call-devices"));
    expect(screen.getByTestId("call-window")).not.toContainElement(screen.getByTestId("call-devices-menu"));
  });

  const save = () => saveSession({ id: "chat-modal", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
  const inLayer = (run: (layer: HTMLElement) => void) => {
    const layer = document.createElement("div");
    document.body.append(layer);
    try {
      renderApp(<Chat sessionId="chat-modal" onCallChange={() => {}} callLayer={layer} visible />);
      run(layer);
    } finally {
      layer.remove();
    }
  };

  // A video call that went on as a voice call: beside the modal window, its alert was never said.
  it("says a camera refused mid-call from inside itself", () => {
    save();
    hook.mediaProblem = "denied";
    inLayer(() => {
      const note = screen.getByTestId("call-media-problem");
      expect(note).toHaveRole("alert");
      expect(note).toHaveTextContent("No access to the camera, so video is off");
      expect(screen.getByTestId("call-window")).toContainElement(note);
      expect(screen.getAllByTestId("call-media-problem")).toHaveLength(1);
    });
  });

  it("says the microphone paused by the system from inside itself", () => {
    save();
    hook.micPaused = true;
    inLayer(() => {
      const note = screen.getByTestId("call-mic-paused");
      expect(note).toHaveRole("status");
      expect(screen.getByTestId("call-window")).toContainElement(note);
      expect(screen.getAllByTestId("call-mic-paused")).toHaveLength(1);
    });
  });

  it("leaves the small window's notices beside it, over the page", () => {
    save();
    hook.mediaProblem = "denied";
    localStorage.setItem("ghostly_call_mini", "1");
    inLayer((layer) => {
      const note = within(layer).getByTestId("call-media-problem");
      expect(screen.getByTestId("call-window")).toHaveAttribute("data-mini", "true");
      expect(screen.getByTestId("call-window")).not.toContainElement(note);
    });
  });

  // How the call ended is said beside the window, but only once the window is gone: while it is up, it says nothing.
  it("has nothing of the call's end to say while it is up", () => {
    save();
    inLayer(() => {
      expect(screen.getByTestId("call-window")).toHaveAttribute("aria-modal", "true");
      expect(screen.getByTestId("call-end-spoken")).toBeEmptyDOMElement();
    });
  });
});
