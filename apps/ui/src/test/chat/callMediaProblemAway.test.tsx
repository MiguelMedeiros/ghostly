import "fake-indexeddb/auto";
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { saveSession } from "../../lib/storage";
import { renderApp } from "../render";

// covers: calls.media-blocked

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

/** What the call hook says, set by the test: the camera refused in a call, not the call itself, is what is tested here. */
const hook = vi.hoisted(() => ({ mediaProblem: null as "denied" | "unavailable" | null }));
vi.mock("../../hooks/useWebRTC", async () => {
  const real = await vi.importActual<typeof import("../../hooks/useWebRTC")>("../../hooks/useWebRTC");
  return {
    useWebRTC: (options: Parameters<typeof real.useWebRTC>[0]) => {
      const webrtc = real.useWebRTC(options);
      return hook.mediaProblem ? { ...webrtc, mediaProblem: hook.mediaProblem, mediaProblemId: 1, mediaProblemOf: "camera" as const } : webrtc;
    },
  };
});

const PEER = "peer".padEnd(52, "p");

/**
 * A call keeps its chat loaded while another page is on screen (Settings, another chat), with the call in its small
 * window there. Camera pressed in it, on a machine with no camera or with the camera refused, said why only in the
 * chat's own column: hidden, so the press did nothing anyone could see, and nothing was said to a screen reader.
 * It now shows over whatever is on screen, as the wait for a contact to wake does.
 */
describe("the camera's note of a call whose chat is not on screen", () => {
  const save = () => saveSession({ id: "chat-cam", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });

  it("shows over what is on screen, with its words", () => {
    save();
    hook.mediaProblem = "unavailable";
    const layer = document.createElement("div");
    document.body.append(layer);
    try {
      renderApp(<Chat sessionId="chat-cam" onCallChange={() => {}} callLayer={layer} visible={false} />);
      const note = within(layer).getByTestId("call-media-problem");
      expect(note).toHaveRole("alert");
      expect(note).toHaveTextContent("No camera found, so video is off");
      // Once: not in the hidden column as well.
      expect(screen.getAllByTestId("call-media-problem")).toHaveLength(1);
    } finally {
      layer.remove();
      hook.mediaProblem = null;
    }
  });

  it("stays at the top of the chat's column while the chat is on screen", () => {
    save();
    hook.mediaProblem = "denied";
    const layer = document.createElement("div");
    document.body.append(layer);
    try {
      renderApp(<Chat sessionId="chat-cam" onCallChange={() => {}} callLayer={layer} visible />);
      const note = screen.getByTestId("call-media-problem");
      expect(note).toHaveTextContent("No access to the camera, so video is off");
      expect(layer.contains(note)).toBe(false);
      expect(note.closest(".chat-column")).not.toBeNull();
    } finally {
      layer.remove();
      hook.mediaProblem = null;
    }
  });
});
