import { act, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { PinnedBar } from "../../components/chat/PinnedBar";
import { replyIndex } from "../../lib/replies";
import type { ChatMessage } from "../../lib/types";
import { renderApp } from "../render";

// covers: chat.pins

/**
 * ✕ on the pinned message's bar takes the whole bar away, itself included. Pressed from the keyboard, the focus went
 * with it to the page, and the next Tab started from the top: it goes to the chat's ⋮ instead.
 */
const WIRE = "P".repeat(22);
const message: ChatMessage = { id: `peer_${WIRE}`, text: "the door code is 4321", sender: "peer", timestamp: 1_700_000_000_000 };
const index = replyIndex([message]);

function Chat() {
  const [pinned, setPinned] = useState(true);
  const options = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={options} data-testid="chat-options">⋮</button>
      <PinnedBar pin={pinned ? ({ id: WIRE, messageId: message.id } as never) : undefined} index={index} onUnpin={() => setPinned(false)} returnFocus={options} />
      <textarea data-testid="composer" />
      <button data-testid="unpin-elsewhere" onClick={() => setPinned(false)}>unpinned by the other side</button>
    </>
  );
}

describe("Unpin on the pinned message's bar, from the keyboard", () => {
  it("leaves the focus on the chat's ⋮, not on the page", () => {
    renderApp(<Chat />);
    const unpin = screen.getByTestId("pinned-unpin");
    unpin.focus();
    act(() => unpin.click());
    expect(screen.queryByTestId("pinned-bar")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("chat-options"));
  });

  it("leaves alone a focus that is elsewhere as the bar goes", () => {
    renderApp(<Chat />);
    const composer = screen.getByTestId("composer");
    composer.focus();
    act(() => screen.getByTestId("unpin-elsewhere").click());
    expect(screen.queryByTestId("pinned-bar")).toBeNull();
    expect(document.activeElement).toBe(composer);
  });

  it("takes no focus when the pin goes with the focus on the page already", () => {
    renderApp(<Chat />);
    act(() => screen.getByTestId("unpin-elsewhere").click());
    expect(screen.queryByTestId("pinned-bar")).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});
