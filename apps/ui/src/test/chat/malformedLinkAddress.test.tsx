import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Root } from "../../Root";

// covers: invite.link

/*
 * A link to the app whose address has a `%` that is not an escape (`#/chat/%`, `#/join/%E0`, `#/group/%`) is no chat
 * and no group: it leaves the address like any link the app cannot read, and the app goes on. Decoding it threw a
 * URIError in the link intakes, and the whole app showed its "Something went wrong" screen.
 */

vi.mock("../../contexts/LockScreenContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../contexts/LockScreenContext")>()),
  useLockScreen: () => ({
    isLocked: false, hasUnlocked: true, retryAt: null, ringing: [],
    lock: () => {}, unlock: async () => false, resetTimer: () => {}, offerCall: () => () => {},
  }),
}));

afterEach(() => { window.location.hash = ""; });

it.each(["#/chat/%", "#/chat/%E0%A4%A", "#/join/%E0", "#/join/group2/%zz"])("a link to %s leaves the address and the app goes on", async (hash) => {
  window.location.hash = hash;
  render(<Root />);
  await waitFor(() => expect(window.location.hash).toBe("#/"));
  expect(screen.queryByTestId("app-error")).toBeNull();
}, 60_000);

it("a group's address with such a `%` is a group the app does not have, not its error screen", async () => {
  window.location.hash = "#/group/%";
  render(<Root />);
  await new Promise((done) => setTimeout(done, 1_000));
  expect(screen.queryByTestId("app-error")).toBeNull();
}, 60_000);
