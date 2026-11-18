import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageInput } from "../../components/MessageInput";
import { LockScreenProvider } from "../../contexts/LockScreenContext";
import { renderApp } from "../render";

// covers: chat.paired.send

/*
 * The composer's notice card hides itself after a while. A composer that goes away (the chat closed, the test's page
 * torn down) while its card is up takes that wait with it: nothing of it runs later against a page that is gone.
 */

afterEach(() => { vi.useRealTimers(); });

describe("the composer's notice card", () => {
  it("leaves no wait behind when the composer goes away with the card up", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { unmount } = renderApp(
      <LockScreenProvider><MessageInput draftId="toast-unmount" maxBytes={4} onSend={vi.fn(async () => null)} /></LockScreenProvider>,
    );
    const field = screen.getByPlaceholderText<HTMLTextAreaElement>("Message…");
    act(() => { fireEvent.change(field, { target: { value: "longer than four bytes" } }); });
    act(() => { fireEvent.keyDown(field, { key: "Enter" }); });
    expect(screen.getByText(/too long/i)).toBeTruthy();
    // The typing's own pause to save the draft is a wait too: let it run so only the card's is left.
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
