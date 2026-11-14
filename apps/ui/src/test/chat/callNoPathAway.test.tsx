import "fake-indexeddb/auto";
import { act, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Chat } from "../../pages/Chat";
import { saveSession } from "../../lib/storage";
import { renderApp } from "../render";

// covers: calls.no-path

vi.mock("../../lib/sounds", () => ({ playSound: vi.fn(() => () => {}), startRinging: vi.fn(() => () => {}), installAudioGestures: () => () => {}, warmSound: () => {} }));

/** What the call hook says of the chat's last call, set by the test: the call itself is not what is tested here. */
const hook = vi.hoisted(() => ({ noPath: false, callState: "idle", dismissed: 0 }));
vi.mock("../../hooks/useWebRTC", async () => {
  const real = await vi.importActual<typeof import("../../hooks/useWebRTC")>("../../hooks/useWebRTC");
  return {
    useWebRTC: (options: Parameters<typeof real.useWebRTC>[0]) => {
      const webrtc = real.useWebRTC(options);
      return { ...webrtc, noPath: hook.noPath, callState: hook.callState, dismissNoPath: () => { hook.dismissed++; } };
    },
  };
});

const PEER = "peer".padEnd(52, "p");

/**
 * A call that found no path ends in a chat `App` may let go of at once: one the person left while it rang (the small
 * call window over Settings, or another chat) is loaded only while its call is on. The note about a VPN or firewall
 * went with it: the person never learned why the call failed, nor where a TURN server is set. It now stays with the
 * chat, and shows when the chat is opened again, until closed or the next call starts.
 */
describe("the no-path note of a call that ended in a chat let go of", () => {
  const props = { sessionId: "chat-np", onCallChange: () => {}, callLayer: null };
  const save = () => saveSession({ id: "chat-np", profile: "paired-chat/1", mySeedB64: "c2VlZA", peerPubKeyB64: PEER, encKeyB64: "a2V5", label: "Ana", messages: [], createdAt: 1_700_000_000_000 });

  it("shows when the chat is opened again, until closed", async () => {
    save();
    Object.assign(hook, { noPath: true, callState: "idle" });
    const first = renderApp(<Chat {...props} visible={false} />);
    expect(screen.getByTestId("call-no-path")).toBeInTheDocument();
    // The call is over: `App` unloads the chat, and a new page of it starts with a hook that knows nothing of it.
    first.unmount();
    hook.noPath = false;

    const again = renderApp(<Chat {...props} visible />);
    expect(await screen.findByTestId("call-no-path")).toHaveTextContent("The call couldn't connect");
    await again.user.click(screen.getByTestId("call-no-path-close"));
    expect(screen.queryByTestId("call-no-path")).toBeNull();
    again.unmount();

    // Closed is closed: not back the next time either.
    renderApp(<Chat {...props} visible />);
    expect(screen.queryByTestId("call-no-path")).toBeNull();
  });

  it("goes when the chat's next call starts", async () => {
    save();
    Object.assign(hook, { noPath: true, callState: "idle" });
    renderApp(<Chat {...props} visible={false} />).unmount();
    hook.noPath = false;

    const again = renderApp(<Chat {...props} visible />);
    expect(await screen.findByTestId("call-no-path")).toBeInTheDocument();
    hook.callState = "offering";
    again.rerender(<Chat {...props} visible />);
    await act(async () => {});
    expect(screen.queryByTestId("call-no-path")).toBeNull();
  });

  /**
   * It stays until closed, so it never covers the header: on a phone the overlay over the top hid back, the name,
   * the calls and ⋮, and the next call could not start from there. It is a line under the header, in the column's flow.
   */
  it("sits under the chat's header, never over its back button, calls or ⋮", async () => {
    save();
    Object.assign(hook, { noPath: true, callState: "idle" });
    renderApp(<Chat {...props} visible />);
    const note = await screen.findByTestId("call-no-path");
    const header = screen.getByTestId("chat-back").closest(".header-safe")!;
    expect(header).not.toBeNull();
    expect(note).not.toHaveClass("top-notice");
    expect(header.contains(note)).toBe(false);
    // After the header in the column, with the back button, the calls and ⋮ before it.
    expect(header.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const control of [screen.getByTestId("chat-back"), screen.getByTestId("chat-options"), ...within(header as HTMLElement).getAllByRole("button", { name: /call/i })])
      expect(header.contains(control)).toBe(true);
    // Before the messages: the top of the column, not the end of the list.
    expect(note.compareDocumentPosition(document.querySelector("[data-message-list]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
