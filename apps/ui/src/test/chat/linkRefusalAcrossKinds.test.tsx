import { act, render, screen, waitFor } from "@testing-library/react";
import { createChatInvite } from "@ghostly/core";
import { afterEach, expect, it } from "vitest";
import { Root } from "../../Root";
import { listSessions } from "../../lib/storage";
import { fakeEngine } from "../fakeEngine";

// covers: invite.invalid, invite.link, groups.link.join

/*
 * A link's refusal stays until closed, or until the next link comes: that one answers for itself. The next link may be
 * of the other kind (an invite after a group's link, a group's link after an invite), and a refusal left there would
 * read as the refusal of the chat or group that opened, or sit on top of the other kind's refusal, hiding it.
 */

afterEach(() => { window.location.hash = ""; });

/** The address is set on the running page, as a browser says a fragment navigation (`popstate`). */
function go(hash: string): void {
  window.location.hash = hash;
  act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
}

/** A fresh invite's code with its end cut off: a damaged link. */
const damaged = () => createChatInvite().inviteCode.slice(0, -5);

it("a group link's refusal goes when a good invite link opens its chat next", async () => {
  fakeEngine.on("joinGroupByLink", () => { throw new Error("Go online to join a group"); });
  render(<Root />);
  await screen.findByTestId("sidebar");
  go("#/join/group2/abc");
  await screen.findByTestId("group-link-invalid");

  go(`#${createChatInvite().inviteCode}`);
  await waitFor(() => expect(listSessions()).toHaveLength(1));
  await waitFor(() => expect(window.location.hash).toBe(`#/chat/${listSessions()[0].id}`));
  expect(screen.queryByTestId("group-link-invalid")).toBeNull();
}, 60_000);

it("an invite link's refusal goes when a group's link opens its group next", async () => {
  fakeEngine.on("joinGroupByLink", () => ({ groupId: "g1" }));
  render(<Root />);
  await screen.findByTestId("sidebar");
  go(`#/${damaged()}`);
  await screen.findByTestId("invite-link-invalid");

  go("#/join/group2/def");
  await waitFor(() => expect(window.location.hash).toBe("#/group/g1"));
  expect(screen.queryByTestId("invite-link-invalid")).toBeNull();
}, 60_000);

it("two refused links of different kinds: only the last one's refusal is shown, not one on top of the other", async () => {
  render(<Root />);
  await screen.findByTestId("sidebar");
  go(`#/${damaged()}`);
  await screen.findByTestId("invite-link-invalid");

  go("#/join/%zz");
  await screen.findByTestId("group-link-invalid");
  expect(screen.queryByTestId("invite-link-invalid")).toBeNull();

  go(`#/${damaged()}`);
  await screen.findByTestId("invite-link-invalid");
  expect(screen.queryByTestId("group-link-invalid")).toBeNull();
}, 60_000);
