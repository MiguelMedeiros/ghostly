import { act, render, screen, waitFor } from "@testing-library/react";
import { createChatInvite, createDeviceInvite } from "@ghostly/core";
import { afterEach, expect, it } from "vitest";
import { Root } from "../../Root";
import { takeDeviceLink } from "../../lib/devices";
import { listSessions } from "../../lib/storage";
import { fakeEngine } from "../fakeEngine";

// covers: invite.link

/*
 * A link with a doubled `#` before it (`##ghostly1…`, or the app's own `#/` with a `#…` after it) is the same link, for
 * every kind the intakes take: the router read it as home with a hash, and the link was left in the address with
 * nothing opened.
 */

afterEach(() => { window.location.hash = ""; takeDeviceLink(); });

it.each(["##{code}", "#/#{code}", "##{code}/", "##/chat/{code}", "#/#/chat/{code}", "##web+ghostly:{code}", "#/#web%2Bghostly%3A{code}"])("an invite opened as %s joins, and leaves the address", async (form) => {
  const code = createChatInvite().inviteCode;
  window.history.replaceState(null, "", form.replace("{code}", code));
  render(<Root />);
  await waitFor(() => expect(listSessions()).toHaveLength(1));
  await waitFor(() => expect(window.location.hash).toBe(`#/chat/${listSessions()[0].id}`));
}, 60_000);

it("an invite with more after a doubled `#` is refused, and leaves the address", async () => {
  const code = createChatInvite().inviteCode;
  window.history.replaceState(null, "", `##${code}/more`);
  render(<Root />);
  expect(await screen.findByTestId("invite-link-invalid")).toBeInTheDocument();
  expect(window.location.hash).toBe("#/");
  expect(listSessions()).toHaveLength(0);
}, 60_000);

it.each(["##{code}", "#/#{code}"])("a device code given to the open app as %s goes to the join host, and leaves the address", async (form) => {
  render(<Root />);
  const code = createDeviceInvite(new Uint8Array(32).fill(7)).code;
  window.location.hash = form.replace("{code}", code);
  act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
  await waitFor(() => expect(window.location.hash).toBe("#/"));
  expect(await screen.findByTestId("device-join-confirm")).toBeInTheDocument();
  expect(screen.queryByTestId("invite-link-invalid")).toBeNull();
}, 60_000);

it.each(["##/join/group2/abc", "#/#/join/group2/abc"])("a group's link opened as %s joins, and leaves the address", async (form) => {
  fakeEngine.on("joinGroupByLink", () => ({ groupId: "g1" }));
  window.history.replaceState(null, "", form);
  render(<Root />);
  await waitFor(() => expect(window.location.hash).toBe("#/group/g1"));
}, 60_000);
