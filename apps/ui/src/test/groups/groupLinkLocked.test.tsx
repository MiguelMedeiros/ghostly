import { render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Root } from "../../Root";
import { fakeEngine } from "../fakeEngine";

// covers: groups.link.join, profiles.lock

/*
 * A group's link opened while the app is locked again (it was unlocked once): the link leaves the address at once, but
 * the engine joins nothing before the lock is passed again. The group is joined, once, after it.
 */

const lock = vi.hoisted(() => ({ isLocked: true }));
vi.mock("../../contexts/LockScreenContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../contexts/LockScreenContext")>()),
  useLockScreen: () => ({
    isLocked: lock.isLocked, hasUnlocked: true, retryAt: null, ringing: [],
    lock: () => {}, unlock: async () => false, resetTimer: () => {}, offerCall: () => () => {},
  }),
}));

afterEach(() => { window.location.hash = ""; lock.isLocked = true; });

it("a group's link opened while locked again joins only after the lock is passed", async () => {
  const joins: unknown[] = [];
  fakeEngine.on("joinGroupByLink", (params) => { joins.push(params); return { groupId: "g1" }; });
  window.location.hash = "#/join/group2/abc";
  const { rerender } = render(<Root />);
  await waitFor(() => expect(window.location.hash).toBe("#/"));
  // Long enough for the engine call an unguarded join makes at once.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(joins).toHaveLength(0);

  lock.isLocked = false;
  rerender(<Root />);
  await waitFor(() => expect(joins).toEqual([{ link: "group2/abc" }]));
});
