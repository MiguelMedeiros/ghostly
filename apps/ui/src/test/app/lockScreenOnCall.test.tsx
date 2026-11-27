import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LockScreen } from "../../components/LockScreen";
import type { LockedCall } from "../../contexts/LockScreenContext";
import { useCallOnLockScreen, type CallUnderLock } from "../../lib/callUnderLock";
import { renderApp } from "../render";

// covers: calls.lock

const lock = vi.hoisted(() => ({
  isLocked: true,
  ringing: [] as LockedCall[],
  unlock: vi.fn(async (password: string) => password === "spooky"),
}));
vi.mock("../../contexts/LockScreenContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../contexts/LockScreenContext")>()),
  useLockScreen: () => ({ isLocked: lock.isLocked, hasUnlocked: true, retryAt: null, lock: () => {}, unlock: (p: string) => lock.unlock(p), resetTimer: () => {}, ringing: lock.ringing, offerCall: () => () => {}, callEndSaid: "" }),
}));

function onCall(over: Partial<CallUnderLock> = {}): CallUnderLock {
  return { id: "chat-1", name: "Casper", named: true, peerPubKey: "casper-key", state: "connected", startedAt: Date.now() - 65_000, muted: false, toggleMute: vi.fn(), end: vi.fn(), ...over };
}

/** The chat whose call is on, as `Chat` registers it (`useCallOnLockScreen`), and the lock screen over it. */
function Screen({ call }: { call: CallUnderLock | null }) {
  useCallOnLockScreen(call);
  return <LockScreen />;
}

const panel = () => screen.getByTestId("lock-on-call");
const field = () => screen.getByPlaceholderText("Password");

describe("locked during a call", () => {
  afterEach(() => { lock.ringing = []; lock.isLocked = true; lock.unlock.mockClear(); vi.useRealTimers(); });

  it("shows whom the call is with and its time, Mute and End call, and nothing else of the chat; the password stays", () => {
    renderApp(<Screen call={onCall()} />);
    const name = screen.getByTestId("lock-on-call-name");
    expect(name).toHaveTextContent("Casper");
    // In its own direction: "Casper!" in the Arabic app read "!Casper".
    expect(name.querySelector("bdi")).toHaveTextContent("Casper");
    expect(screen.getByTestId("lock-on-call-time")).toHaveTextContent("01:05");
    expect(panel()).toHaveTextContent(/^On a call with \u2068Casper\u2069CCasper01:05MuteEnd call$/);
    expect(screen.getByRole("group", { name: "On a call with \u2068Casper\u2069" })).toBe(panel());
    expect(screen.getByText("Ghostly is locked")).toBeInTheDocument();
    expect(screen.getByText("Enter your password to unlock")).toBeInTheDocument();
    expect(field()).toHaveFocus();
    expect(screen.getByRole("button", { name: "Unlock" })).toBeInTheDocument();
    // The lock screen says it is on a call as it opens.
    expect(screen.getByRole("dialog", { name: "Ghostly is locked" })).toHaveAccessibleDescription("On a call with \u2068Casper\u2069");
  });

  it("its time goes on while it is shown", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date", "performance"] });
    renderApp(<Screen call={onCall()} />);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByTestId("lock-on-call-time")).toHaveTextContent("02:05");
  });

  it("before it connects, and with its path lost, it says so in place of the time", () => {
    const { rerender } = renderApp(<Screen call={onCall({ state: "calling", startedAt: null })} />);
    expect(screen.getByTestId("lock-on-call-time")).toHaveTextContent("Calling...");
    rerender(<Screen call={onCall({ state: "connecting", startedAt: null })} />);
    expect(screen.getByTestId("lock-on-call-time")).toHaveTextContent("Connecting...");
    rerender(<Screen call={onCall({ state: "reconnecting" })} />);
    expect(screen.getByTestId("lock-on-call-time")).toHaveTextContent("Reconnecting...");
  });

  it("Mute mutes without the password, and the app stays locked", async () => {
    const call = onCall();
    const { user, rerender } = renderApp(<Screen call={call} />);
    const mute = screen.getByRole("button", { name: "Mute" });
    await user.click(mute);
    expect(call.toggleMute).toHaveBeenCalledOnce();
    expect(call.end).not.toHaveBeenCalled();
    expect(lock.unlock).not.toHaveBeenCalled();
    rerender(<Screen call={{ ...call, muted: true }} />);
    // Named for what it does next, as the call window's button.
    expect(screen.getByRole("button", { name: "Unmute" })).toBe(mute);
    expect(screen.getByRole("dialog", { name: "Ghostly is locked" })).toBeInTheDocument();
  });

  it("End call hangs up without the password; the panel goes, the lock stays, the focus back on the password", async () => {
    const call = onCall();
    const { user, rerender } = renderApp(<Screen call={call} />);
    await user.click(screen.getByRole("button", { name: "End call" }));
    expect(call.end).toHaveBeenCalledOnce();
    expect(lock.unlock).not.toHaveBeenCalled();
    rerender(<Screen call={null} />);
    expect(screen.queryByTestId("lock-on-call")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Ghostly is locked" })).toBeInTheDocument();
    expect(field()).toHaveFocus();
  });

  it("an Enter in the password field unlocks, never ends or mutes the call", async () => {
    const call = onCall();
    const { user } = renderApp(<Screen call={call} />);
    await user.type(field(), "spooky{Enter}");
    expect(lock.unlock).toHaveBeenCalledWith("spooky");
    expect(call.end).not.toHaveBeenCalled();
    expect(call.toggleMute).not.toHaveBeenCalled();
  });

  it("the keyboard goes Mute, End call, the password, Unlock: in the order they are drawn", async () => {
    const { user } = renderApp(<Screen call={onCall()} />);
    expect(field()).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "End call" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Mute" })).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(field()).toHaveFocus();
  });

  it("a group's call says Leave call, under the group's name", async () => {
    const call = onCall({ id: "group-1", name: "Ghost Crew", group: true, peerPubKey: undefined });
    const { user } = renderApp(<Screen call={call} />);
    expect(screen.getByTestId("lock-on-call-name")).toHaveTextContent("Ghost Crew");
    await user.click(screen.getByRole("button", { name: "Leave call" }));
    expect(call.end).toHaveBeenCalledOnce();
  });

  it("a call ringing meanwhile shows instead, as it would with no call on", () => {
    lock.ringing = [{ id: "chat-2", name: "Wraith", named: true, hasVideo: false, onCall: true, answer: vi.fn(), decline: vi.fn() }];
    renderApp(<Screen call={onCall()} />);
    expect(screen.getByTestId("lock-call")).toBeInTheDocument();
    expect(screen.queryByTestId("lock-on-call")).not.toBeInTheDocument();
  });

  it("unlocked, nothing shows: the call's own window is there", () => {
    lock.isLocked = false;
    renderApp(<Screen call={onCall()} />);
    expect(screen.queryByTestId("lock-on-call")).not.toBeInTheDocument();
  });

  it("in Arabic, its words are the Arabic ones", () => {
    renderApp(<Screen call={onCall()} />, { language: "ar" });
    expect(screen.getByRole("group", { name: "في مكالمة مع \u2068Casper\u2069" })).toBeInTheDocument();
  });
});
