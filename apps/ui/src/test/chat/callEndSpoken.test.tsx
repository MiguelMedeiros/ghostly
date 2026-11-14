import "fake-indexeddb/auto";
import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { saveSession } from "../../lib/storage";
import type { CallEventType } from "../../lib/types";
import { renderApp } from "../render";

// covers: calls.decline

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

/**
 * The call's state, set by the test, and the chat's own `addCallEventMessage`, as the real hook calls it: the line a
 * call leaves is the chat's, the call itself is not what is tested here.
 */
const hook = vi.hoisted(() => ({
  callState: "idle",
  noPath: false,
  noAnswer: false,
  mediaProblem: null as null | "denied",
  mediaProblemOf: "both" as "mic" | "camera" | "both",
  line: null as null | ((type: CallEventType, hasVideo: boolean) => string | void),
}));
vi.mock("../../hooks/useWebRTC", async () => {
  const real = await vi.importActual<typeof import("../../hooks/useWebRTC")>("../../hooks/useWebRTC");
  return {
    useWebRTC: (options: Parameters<typeof real.useWebRTC>[0]) => {
      const webrtc = real.useWebRTC(options);
      hook.line = options.addCallEventMessage as typeof hook.line;
      return { ...webrtc, callState: hook.callState, noPath: hook.noPath, noAnswer: hook.noAnswer, mediaProblem: hook.mediaProblem, mediaProblemOf: hook.mediaProblemOf };
    },
  };
});

const PEER = "peer".padEnd(52, "p");
const props = { sessionId: "chat-end", onCallChange: () => {}, callLayer: null };
const save = () => saveSession({ id: "chat-end", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });
const spoken = () => screen.getByTestId("call-end-spoken");

/** The call on ends with the line `type`, and the hook goes back to idle, as useWebRTC's hang-up does. */
async function ends(view: ReturnType<typeof renderApp>, type: CallEventType, hasVideo = false) {
  await act(async () => { hook.line!(type, hasVideo); });
  hook.callState = "idle";
  view.rerender(<Chat {...props} visible />);
  await act(async () => {});
}

/**
 * A call's window and its ring are where a screen reader hears a call: "Calling...", "Connected". When the contact
 * declined, hung up or stopped calling, they went, the focus went back to the call button, and nothing said why: the
 * chat's call lines are not read out (MessageAnnouncer). The line the call left is said, once, as it ends.
 */
describe("a call's end, said to a screen reader", () => {
  beforeEach(() => { save(); Object.assign(hook, { callState: "idle", noPath: false, noAnswer: false, mediaProblem: null, mediaProblemOf: "both", line: null }); });

  it("says the contact declined our call, hung up, or stopped calling", async () => {
    hook.callState = "offering";
    const view = renderApp(<Chat {...props} visible />);
    expect(spoken()).toHaveAttribute("role", "status");
    expect(spoken()).toHaveTextContent("");
    await ends(view, "call_rejected");
    expect(spoken()).toHaveTextContent("Audio call declined");

    hook.callState = "connected";
    view.rerender(<Chat {...props} visible />);
    await ends(view, "call_ended", true);
    expect(spoken()).toHaveTextContent("Video call ended");

    hook.callState = "incoming";
    view.rerender(<Chat {...props} visible />);
    await ends(view, "call_missed");
    expect(spoken()).toHaveTextContent("Missed audio call");
  });

  it("says nothing for a call held back while no call was on, nor what a notice of its own already says", async () => {
    const view = renderApp(<Chat {...props} visible />);
    // A burst's call held back (QUICK_REDIAL_MS): it never rang, and it is not news.
    await act(async () => { hook.line!("call_missed", false); });
    view.rerender(<Chat {...props} visible />);
    await act(async () => {});
    expect(spoken()).toHaveTextContent("");

    // Our call rang out: "No answer" says it (role status).
    hook.callState = "offering";
    view.rerender(<Chat {...props} visible />);
    await ends(view, "call_unanswered");
    expect(spoken()).toHaveTextContent("");

    // No path: the note says it (role alert).
    hook.callState = "connecting";
    view.rerender(<Chat {...props} visible />);
    hook.noPath = true;
    await ends(view, "call_failed");
    expect(spoken()).toHaveTextContent("");
  });

  it("says how a call that went on without the camera ended, while the camera's notice is up; a microphone's failure says it itself", async () => {
    // A video call whose camera was refused goes on as a voice call: its notice is not why the call ended.
    hook.callState = "offering";
    hook.mediaProblem = "denied";
    hook.mediaProblemOf = "camera";
    const view = renderApp(<Chat {...props} visible />);
    await ends(view, "call_rejected");
    expect(spoken()).toHaveTextContent("Audio call declined");

    // A call that could not use the microphone failed for it: its notice says so.
    hook.callState = "offering";
    hook.mediaProblemOf = "mic";
    view.rerender(<Chat {...props} visible />);
    await ends(view, "call_failed");
    expect(spoken()).toHaveTextContent("");
  });

  it("is in the person's language", async () => {
    hook.callState = "offering";
    const view = renderApp(<Chat {...props} visible />, { language: "pt" });
    await ends(view, "call_rejected");
    expect(spoken().textContent).not.toBe("");
    expect(spoken().textContent).not.toContain("declined");
  });
});
