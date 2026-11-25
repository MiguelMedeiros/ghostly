import { act, render, screen, waitFor } from "@testing-library/react";
import { createChatInvite } from "@ghostly/core";
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

/** The address is set on the running page, as a browser says it (`popstate`; happy-dom says only `hashchange`). */
function go(hash: string): void {
  window.location.hash = hash;
  act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
}

// covers: groups.link.join, profiles.lock
/*
 * Several groups' links opened while locked (a tab that takes the profile over opens every link no tab answered, one
 * after the other): each is joined after the unlock, in turn, the same one once, and one past what links may join is
 * refused, said then. Only the last used to be kept.
 */
it("groups' links opened while locked are each joined after the unlock, up to the links' limit", async () => {
  const joins: unknown[] = [];
  fakeEngine.on("joinGroupByLink", (params) => { joins.push(params); return { groupId: "g1" }; });
  window.location.hash = "#/join/group2/one";
  const { rerender } = render(<Root />);
  await waitFor(() => expect(window.location.hash).toBe("#/"));
  for (const link of ["two", "one", "three", "four"]) {
    go(`#/join/group2/${link}`);
    await waitFor(() => expect(window.location.hash).toBe("#/"));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(joins).toHaveLength(0);

  lock.isLocked = false;
  rerender(<Root />);
  await waitFor(() => expect(joins).toEqual([{ link: "group2/one" }, { link: "group2/two" }, { link: "group2/three" }]));
  expect(screen.getByTestId("group-link-invalid-title")).toHaveTextContent("Too many group links opened");
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(joins).toHaveLength(3);
});

// covers: groups.link.join, profiles.lock
/*
 * A link that comes after the one refused past the limit, still under the lock (one already held again, or an invite
 * link): the refusal, not yet acted on, stays to be said after the unlock. Wiped, the refused link was lost with no word.
 */
it.each([
  ["a group's link already held", () => "#/join/group2/one"],
  ["an invite link", () => `#${createChatInvite().inviteCode}`],
])("the refusal of a group's link past the limit is still said after the unlock when %s comes next", async (_, next) => {
  const joins: unknown[] = [];
  fakeEngine.on("joinGroupByLink", (params) => { joins.push(params); return { groupId: "g1" }; });
  window.location.hash = "#/join/group2/one";
  const { rerender } = render(<Root />);
  await waitFor(() => expect(window.location.hash).toBe("#/"));
  for (const hash of ["#/join/group2/two", "#/join/group2/three", "#/join/group2/four", next()]) {
    go(hash);
    await waitFor(() => expect(window.location.hash).toBe("#/"));
  }

  lock.isLocked = false;
  rerender(<Root />);
  await waitFor(() => expect(joins).toEqual([{ link: "group2/one" }, { link: "group2/two" }, { link: "group2/three" }]));
  expect(screen.getByTestId("group-link-invalid-title")).toHaveTextContent("Too many group links opened");
});
