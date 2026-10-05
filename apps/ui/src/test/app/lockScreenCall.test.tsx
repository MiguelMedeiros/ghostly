import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LockScreen } from "../../components/LockScreen";
import type { LockedCall } from "../../contexts/LockScreenContext";
import { renderApp } from "../render";

// covers: calls.lock-ring

const lock = vi.hoisted(() => ({
  isLocked: true,
  ringing: [] as LockedCall[],
  unlock: async (password: string) => password === "spooky",
}));
vi.mock("../../contexts/LockScreenContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../contexts/LockScreenContext")>()),
  useLockScreen: () => ({ isLocked: lock.isLocked, hasUnlocked: true, retryAt: null, lock: () => {}, unlock: (p: string) => lock.unlock(p), resetTimer: () => {}, ringing: lock.ringing, offerCall: () => () => {} }),
}));

function ringing(over: Partial<LockedCall> = {}): LockedCall {
  return { id: "chat-1", name: "Casper", named: true, peerPubKey: "casper-key", hasVideo: false, onCall: false, answer: vi.fn(), decline: vi.fn(), ...over };
}

describe("a call ringing while the app is locked", () => {
  afterEach(() => { lock.ringing = []; lock.isLocked = true; });

  it("shows who calls and what kind of call, and nothing else: no password field until Answer", () => {
    lock.ringing = [ringing({ hasVideo: true })];
    renderApp(<LockScreen />);
    const card = screen.getByTestId("lock-call");
    expect(screen.getByTestId("lock-call-name")).toHaveTextContent("Casper");
    expect(screen.getByTestId("lock-call-kind")).toHaveTextContent("Incoming video call...");
    expect(card).toHaveTextContent(/^CCasperIncoming video call\.\.\.$/);
    expect(screen.queryByPlaceholderText("Password")).not.toBeInTheDocument();
    expect(screen.getByText("Ghostly is locked")).toBeInTheDocument();
    // The card has the focus, not Answer: an Enter typed a moment before does not answer.
    expect(card).toHaveFocus();
  });

  it("Decline declines and stays locked", async () => {
    const call = ringing();
    lock.ringing = [call];
    const { user } = renderApp(<LockScreen />);
    await user.click(screen.getByRole("button", { name: "Decline" }));
    expect(call.decline).toHaveBeenCalledOnce();
    expect(call.answer).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Ghostly is locked" })).toBeInTheDocument();
  });

  it("Answer asks for the password, focused; the right one answers at once", async () => {
    const call = ringing();
    lock.ringing = [call];
    const { user } = renderApp(<LockScreen />);
    await user.click(screen.getByRole("button", { name: "Answer" }));
    expect(call.answer).not.toHaveBeenCalled();
    const field = screen.getByPlaceholderText("Password");
    expect(field).toHaveFocus();
    expect(screen.getByText("Enter your password to answer")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Answer" })).toBeDisabled();
    await user.type(field, "spooky");
    await user.click(screen.getByRole("button", { name: "Answer" }));
    expect(call.answer).toHaveBeenCalledOnce();
    expect(call.decline).not.toHaveBeenCalled();
  });

  it("a wrong password keeps it ringing and says so under the field", async () => {
    const call = ringing();
    lock.ringing = [call];
    const { user } = renderApp(<LockScreen />);
    await user.click(screen.getByRole("button", { name: "Answer" }));
    await user.type(screen.getByPlaceholderText("Password"), "not it{Enter}");
    const error = await screen.findByTestId("lock-error");
    expect(error).toHaveTextContent("Incorrect password, try again");
    const field = screen.getByPlaceholderText("Password");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAttribute("aria-describedby", error.id);
    expect(field).toHaveFocus();
    expect(call.answer).not.toHaveBeenCalled();
    expect(screen.getByTestId("lock-call")).toBeInTheDocument();
    // Then the right one answers.
    await user.type(field, "spooky{Enter}");
    expect(call.answer).toHaveBeenCalledOnce();
  });

  it("a call that ends meanwhile leaves the plain lock screen", async () => {
    lock.ringing = [ringing()];
    const { user, rerender } = renderApp(<LockScreen />);
    await user.click(screen.getByRole("button", { name: "Answer" }));
    lock.ringing = [];
    act(() => rerender(<LockScreen />));
    expect(screen.queryByTestId("lock-call")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unlock" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Password")).toHaveFocus();
  });

  it("on a call already, Answer says End and answer", () => {
    lock.ringing = [ringing({ onCall: true })];
    renderApp(<LockScreen />);
    expect(screen.getByRole("button", { name: "End and answer" })).toBeInTheDocument();
    expect(screen.getByText("Answering ends your current call")).toBeInTheDocument();
  });

  it("unlocked, nothing shows: the chat's own card rings instead", () => {
    lock.isLocked = false;
    lock.ringing = [ringing()];
    renderApp(<LockScreen />);
    expect(screen.queryByTestId("lock-call")).not.toBeInTheDocument();
  });
});
