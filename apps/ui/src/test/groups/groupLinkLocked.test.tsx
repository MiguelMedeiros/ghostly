import { act, render, screen, waitFor } from "@testing-library/react";
import { createChatInvite, createIdentity, encodeCommunityLink } from "@ghostly/core";
import { afterEach, expect, it, vi } from "vitest";
import { Root } from "../../Root";
import { fakeEngine, groupView } from "../fakeEngine";

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

// covers: groups.link.join, profiles.lock
/*
 * Links to groups already here, opened under the lock, take no place among the links that may wait: unlocked, they go to
 * the engine past the limit, and they make no group wait to be let in. Nor does a second link to a group held already (its
 * link reset: the newest is the one joined). Counted, the new group's link after them was refused as one too many,
 * "delete a group still waiting" with none waiting.
 */
it("links to groups already here, opened while locked, leave room for a new group's link", async () => {
  const id = (n: number) => `Group${String(n).padStart(17, "0")}`;
  fakeEngine.on("joinGroupByLink", ({ link }) => ({ groupId: String(link) }));
  fakeEngine.update({ groups: [0, 1, 2].map((n) => groupView({ id: id(n), profile: "community" })) });
  const link = (n: number) => encodeCommunityLink({ g: id(n), host: createIdentity().pubKeyZ32 });
  const old = link(5);
  const links = [link(0), link(1), link(2), link(3), link(4), link(5)];
  window.location.hash = `#/join/${old}`;
  const { rerender } = render(<Root />);
  await waitFor(() => expect(window.location.hash).toBe("#/"));
  for (const next of links) {
    go(`#/join/${next}`);
    await waitFor(() => expect(window.location.hash).toBe("#/"));
  }

  lock.isLocked = false;
  rerender(<Root />);
  await waitFor(() => expect(fakeEngine.callsTo("joinGroupByLink").map((c) => c.link)).toEqual(links));
  expect(screen.queryByTestId("group-link-invalid")).toBeNull();
});

// covers: groups.link.join, profiles.lock
/*
 * A newer link to a group held already (another member's link, or its link reset) that comes after a new group's link
 * refused past the limit, still under the lock: it takes the older link's place, no new one, so the refusal stays to be
 * said after the unlock. Cleared by it, the refused group was never joined and nothing said so.
 */
it("a newer link to a held group, opened after a refused one while locked, leaves the refusal said", async () => {
  const id = (n: number) => `Group${String(n).padStart(17, "0")}`;
  fakeEngine.on("joinGroupByLink", ({ link }) => ({ groupId: String(link) }));
  const link = (n: number) => encodeCommunityLink({ g: id(n), host: createIdentity().pubKeyZ32 });
  const links = [link(1), link(2), link(3), link(4), link(1)];
  window.location.hash = `#/join/${links[0]}`;
  const { rerender } = render(<Root />);
  await waitFor(() => expect(window.location.hash).toBe("#/"));
  for (const next of links.slice(1)) {
    go(`#/join/${next}`);
    await waitFor(() => expect(window.location.hash).toBe("#/"));
  }

  lock.isLocked = false;
  rerender(<Root />);
  await waitFor(() => expect(fakeEngine.callsTo("joinGroupByLink").map((c) => c.link)).toEqual([links[1], links[2], links[4]]));
  expect(screen.getByTestId("group-link-invalid-title")).toHaveTextContent("Too many group links opened");
});

// covers: groups.link.join, profiles.lock
/*
 * A link to a group already here that comes after a new group's link refused past the limit, still under the lock: it
 * goes to the engine, and the refusal stays to be said after the unlock. Cleared by it, the refused link was lost with no
 * word.
 */
it("a link to a group already here, opened after a refused one while locked, leaves the refusal said", async () => {
  const id = (n: number) => `Group${String(n).padStart(17, "0")}`;
  fakeEngine.on("joinGroupByLink", ({ link }) => ({ groupId: String(link) }));
  fakeEngine.update({ groups: [groupView({ id: id(0), profile: "community" })] });
  const link = (n: number) => encodeCommunityLink({ g: id(n), host: createIdentity().pubKeyZ32 });
  const links = [link(1), link(2), link(3), link(4), link(0)];
  window.location.hash = `#/join/${links[0]}`;
  const { rerender } = render(<Root />);
  await waitFor(() => expect(window.location.hash).toBe("#/"));
  for (const next of links.slice(1)) {
    go(`#/join/${next}`);
    await waitFor(() => expect(window.location.hash).toBe("#/"));
  }

  lock.isLocked = false;
  rerender(<Root />);
  await waitFor(() => expect(fakeEngine.callsTo("joinGroupByLink").map((c) => c.link)).toEqual([links[0], links[1], links[2], links[4]]));
  expect(screen.getByTestId("group-link-invalid-title")).toHaveTextContent("Too many group links opened");
});
