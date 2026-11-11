import { act, render, screen, waitFor } from "@testing-library/react";
import { createChatInvite } from "@ghostly/core";
import { afterEach, expect, it, vi } from "vitest";
import { Root } from "../../Root";
import { listSessions } from "../../lib/storage";
import { axeViolations } from "../axe";

// covers: invite.invalid, invite.link, profiles.lock

/*
 * An invite link the app refuses (here a damaged one: its end cut off) opened while the app is locked: it leaves the address at once,
 * but the refusal is said once the lock is passed, not under the lock screen where nobody reads it. Locked or not, the
 * notice stays until it is closed (its ×, Escape), as a group link's refusal does, and the focus goes back where it was.
 */

const lock = vi.hoisted(() => ({ isLocked: true }));
vi.mock("../../contexts/LockScreenContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../contexts/LockScreenContext")>()),
  useLockScreen: () => ({
    isLocked: lock.isLocked, hasUnlocked: !lock.isLocked, retryAt: null, ringing: [],
    lock: () => {}, unlock: async () => false, resetTimer: () => {}, offerCall: () => () => {},
  }),
}));

afterEach(() => { vi.useRealTimers(); window.location.hash = ""; lock.isLocked = true; });

/** What a code with characters missing reads as: its checksum fails. */
const REFUSAL = "This code has a typo. Check it, or ask for the code again.";

/** A fresh invite's code with its end cut off: a damaged link. */
const damaged = () => createChatInvite().inviteCode.slice(0, -5);

/** The address is set on the running page. */
function go(hash: string): void {
  window.location.hash = hash;
  // A browser says a fragment navigation with `popstate` (what the router listens to); happy-dom says only `hashchange`.
  act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
}

/** Escape pressed where the focus is. The notice listens from an effect: press until it is heard. */
async function escape(): Promise<void> {
  await waitFor(() => {
    act(() => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(screen.queryByTestId("invite-link-invalid")).toBeNull();
  });
}

it("a damaged link opened while locked is said after the unlock, and stays past 6 s until Escape closes it", async () => {
  window.location.hash = `#/${damaged()}`;
  const { rerender } = render(<Root />);
  await waitFor(() => expect(window.location.hash).toBe("#/"));
  // Long enough for a notice drawn at once (under the lock screen) to show.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByTestId("invite-link-invalid")).toBeNull();

  // From the unlock on, the clock is the test's: a notice that hid itself after 6 s would be gone below.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  lock.isLocked = false;
  rerender(<Root />);
  await act(async () => {});
  expect(screen.getByTestId("invite-link-invalid")).toHaveTextContent(REFUSAL);
  act(() => { vi.advanceTimersByTime(10_000); });
  vi.useRealTimers();
  const notice = screen.getByTestId("invite-link-invalid");
  expect(notice).toHaveTextContent(REFUSAL);
  expect(notice).toHaveAttribute("role", "alert");
  expect(screen.getByTestId("invite-link-invalid-close")).toHaveAccessibleName("Close");
  expect(await axeViolations(notice.parentElement!)).toEqual([]);

  await escape();
  expect(listSessions()).toEqual([]);
}, 60_000);

it("unlocked, a refused link's notice stays past 6 s, its × closes it and the focus goes back where it was", async () => {
  lock.isLocked = false;
  render(<Root />);
  await screen.findByTestId("sidebar");
  // Where the focus was when the link came: a control the link's trip through the router leaves in place (the
  // sidebar's own buttons are drawn anew on the way home).
  const before = document.body.appendChild(document.createElement("button"));
  act(() => before.focus());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  go(`#/${damaged()}`);
  await act(async () => {});
  expect(screen.getByTestId("invite-link-invalid")).toHaveTextContent(REFUSAL);
  act(() => { vi.advanceTimersByTime(10_000); });
  vi.useRealTimers();
  expect(screen.getByTestId("invite-link-invalid")).toHaveTextContent(REFUSAL);

  // Enter on the ×: the focus is on it when it goes.
  const close = screen.getByTestId("invite-link-invalid-close");
  act(() => { close.focus(); close.click(); });
  expect(screen.queryByTestId("invite-link-invalid")).toBeNull();
  expect(document.activeElement).toBe(before);

  // Escape, from the notice's own ×, gives the focus back too.
  go(`#/${damaged()}`);
  await screen.findByTestId("invite-link-invalid");
  act(() => screen.getByTestId("invite-link-invalid-close").focus());
  await escape();
  expect(document.activeElement).toBe(before);
  before.remove();
}, 60_000);

it("a good invite opened while locked still makes its chat after the unlock, with no refusal", async () => {
  window.location.hash = `#${createChatInvite().inviteCode}`;
  const { rerender } = render(<Root />);
  await waitFor(() => expect(window.location.hash).toBe("#/"));
  expect(listSessions()).toHaveLength(0);

  lock.isLocked = false;
  rerender(<Root />);
  await waitFor(() => expect(listSessions()).toHaveLength(1));
  await waitFor(() => expect(window.location.hash).toBe(`#/chat/${listSessions()[0].id}`));
  expect(screen.queryByTestId("invite-link-invalid")).toBeNull();
}, 60_000);
