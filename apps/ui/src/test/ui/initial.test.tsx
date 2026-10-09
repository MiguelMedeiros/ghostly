import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Avatar } from "../../components/Avatar";
import { CallOverlay } from "../../components/CallOverlay";
import { IncomingCallNotification } from "../../components/IncomingCallNotification";
import { initial } from "../../lib/initial";
import { renderApp } from "../render";

// covers: chats.list.rows, calls.audio, calls.video

/** A round avatar without a picture shows the name's first character, whole. */

describe("a name's initial", () => {
  it("is the first character as a person sees it, in upper case", () => {
    expect(initial("ana")).toBe("A");
    expect(initial("école")).toBe("É");
    expect(initial("مريم")).toBe("م");
    expect(initial("")).toBe("");
  });

  it("is a whole emoji, never the first half of one", () => {
    expect(initial("🦊 Raposa")).toBe("🦊");
    expect(initial("𝓐na")).toBe("𝓐");
    // One picture made of several: a family, a flag, a hand with its skin tone.
    expect(initial("👩‍👩‍👧 home")).toBe("👩‍👩‍👧");
    expect(initial("🇧🇷 Bia")).toBe("🇧🇷");
    expect(initial("👋🏽 hi")).toBe("👋🏽");
  });

  it("keeps a letter with the marks written after it", () => {
    expect(initial("école")).toBe("É");
  });
});

describe("the avatars of a contact named with an emoji first", () => {
  const name = "🦊 Raposa";

  it("the chat's round avatar shows the emoji", () => {
    const { container } = renderApp(<Avatar label={name} />);
    expect(container.textContent).toBe("🦊");
  });

  it("the incoming call shows the emoji", () => {
    renderApp(<IncomingCallNotification peerName={name} hasVideo onAcceptAudio={vi.fn()} onAcceptVideo={vi.fn()} onReject={vi.fn()} />);
    const circle = screen.getByTestId("incoming-call").querySelector("[aria-hidden=true]")!;
    expect(circle.textContent).toBe("🦊");
  });

  it("the call screen shows the emoji", () => {
    const { baseElement } = renderApp(
      <CallOverlay callState="offering" localStream={null} remoteStream={null} isMuted={false} isVideoOff remoteHasVideo={false}
        callStartedAt={null} peerName={name} onHangUp={vi.fn()} onToggleMute={vi.fn()} onToggleVideo={vi.fn()} />,
    );
    expect(baseElement.querySelector(".call-avatar")!.textContent).toBe("🦊");
  });
});
