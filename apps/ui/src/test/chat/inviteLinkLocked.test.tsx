import { render, waitFor } from "@testing-library/react";
import { createChatInvite } from "@ghostly/core";
import { afterEach, expect, it, vi } from "vitest";
import { Root } from "../../Root";
import { listSessions } from "../../lib/storage";

// covers: invite.link, profiles.lock

/*
 * An invite link opened while the app is locked: the code leaves the address at once (it holds the chat's keys), but
 * nothing is written into the profile before the lock is passed. The chat is made, and opens, after it.
 */

const lock = vi.hoisted(() => ({ isLocked: true }));
vi.mock("../../contexts/LockScreenContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../contexts/LockScreenContext")>()),
  useLockScreen: () => ({
    isLocked: lock.isLocked, hasUnlocked: !lock.isLocked, retryAt: null, ringing: [],
    lock: () => {}, unlock: async () => false, resetTimer: () => {}, offerCall: () => () => {},
  }),
}));

afterEach(() => { window.location.hash = ""; lock.isLocked = true; });

it("an invite link opened while locked makes its chat only after the lock is passed", async () => {
  const code = createChatInvite().inviteCode;
  window.location.hash = `#${code}`;
  const { rerender } = render(<Root />);
  await waitFor(() => expect(window.location.hash).toBe("#/"));
  expect(listSessions()).toHaveLength(0);

  lock.isLocked = false;
  rerender(<Root />);
  await waitFor(() => expect(listSessions()).toHaveLength(1));
  const [chat] = listSessions();
  expect(chat.viaLink).toBe(true);
  await waitFor(() => expect(window.location.hash).toBe(`#/chat/${chat.id}`));
  expect(window.location.hash).not.toContain(code);
}, 60_000);
