import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LockScreen } from "../../components/LockScreen";
import { LockScreenProvider, useRingOnLockScreen, type LockedCall } from "../../contexts/LockScreenContext";
import { renderApp } from "../render";

// covers: calls.lock-ring

/** A chat whose call rings (or not): what `Chat` does with `useRingOnLockScreen`. */
function RingingChat({ call }: { call: LockedCall | null }) {
  useRingOnLockScreen(call);
  return null;
}

const call = (over: Partial<LockedCall> = {}): LockedCall =>
  ({ id: "chat-1", name: "Casper", named: true, hasVideo: false, onCall: false, answer: vi.fn(), decline: vi.fn(), ...over });

describe("a chat's ringing call reaches the lock screen", () => {
  afterEach(() => localStorage.clear());

  it("shows while the chat rings, follows what it shows, and goes when it stops; the latest answer is the one pressed", async () => {
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ lockScreen: { enabled: true, passwordHash: "x", timeoutMinutes: 5 } }));
    const first = call();
    const { rerender, user } = renderApp(<LockScreenProvider><LockScreen /><RingingChat call={first} /></LockScreenProvider>);
    expect(screen.getByTestId("lock-call-name")).toHaveTextContent("Casper");

    // A new render of the chat (new functions, same call): the screen keeps the card, and presses the latest.
    const again = call();
    rerender(<LockScreenProvider><LockScreen /><RingingChat call={again} /></LockScreenProvider>);
    await user.click(screen.getByRole("button", { name: "Decline" }));
    expect(again.decline).toHaveBeenCalledOnce();
    expect(first.decline).not.toHaveBeenCalled();

    // The name changes (the contact's face came): the card follows.
    rerender(<LockScreenProvider><LockScreen /><RingingChat call={call({ name: "Slimer" })} /></LockScreenProvider>);
    expect(screen.getByTestId("lock-call-name")).toHaveTextContent("Slimer");

    act(() => rerender(<LockScreenProvider><LockScreen /><RingingChat call={null} /></LockScreenProvider>));
    expect(screen.queryByTestId("lock-call")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlock" })).toBeInTheDocument();
  });
});
