import { act, render, screen, waitFor } from "@testing-library/react";
import { createChatInvite, createDeviceInvite } from "@ghostly/core";
import { afterEach, expect, it } from "vitest";
import { Root } from "../../Root";
import { takeDeviceLink, takeDeviceLinkFromAddress } from "../../lib/devices";
import { listSessions } from "../../lib/storage";

// covers: invite.link

/*
 * A link whose code ends in a `/` (typed by hand, or one a linkifier ended so) is the same link: the invite joins and a
 * device code goes to the join host, and the code leaves the address as it does without the `/`. Anything else after
 * the code is a link the app cannot read: refused, and out of the address. The page was blank, the code still in it.
 */

afterEach(() => { window.location.hash = ""; takeDeviceLink(); });

it.each(["#/{code}/", "#{code}/", "#{code}//"])("an invite opened as %s joins, and leaves the address", async (form) => {
  const code = createChatInvite().inviteCode;
  window.location.hash = form.replace("{code}", code);
  render(<Root />);
  await waitFor(() => expect(listSessions()).toHaveLength(1));
  await waitFor(() => expect(window.location.hash).toBe(`#/chat/${listSessions()[0].id}`));
}, 60_000);

it("an invite with more after its `/` is refused, and leaves the address", async () => {
  const code = createChatInvite().inviteCode;
  window.location.hash = `#/${code}/more`;
  render(<Root />);
  expect(await screen.findByTestId("invite-link-invalid")).toBeInTheDocument();
  expect(window.location.hash).toBe("#/");
  expect(listSessions()).toHaveLength(0);
}, 60_000);

it.each(["#{code}/", "#/{code}/", "#Ana#{code}/"])("a device code given to the open app as %s goes to the join host, and leaves the address", async (form) => {
  render(<Root />);
  const code = createDeviceInvite(new Uint8Array(32).fill(7)).code;
  window.location.hash = form.replace("{code}", code);
  act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
  await waitFor(() => expect(window.location.hash).toBe("#/"));
  // The join host took it: "Add this device to <profile>".
  expect(await screen.findByTestId("device-join-confirm")).toBeInTheDocument();
  expect(screen.queryByTestId("invite-link-invalid")).toBeNull();
}, 60_000);

it.each(["#{code}/", "#/{code}/", "#Ana#{code}/"])("a device code opened as %s goes to the join host, and leaves the address", (form) => {
  const code = createDeviceInvite(new Uint8Array(32).fill(7)).code;
  window.history.replaceState(null, "", form.replace("{code}", code));
  takeDeviceLinkFromAddress();
  expect(window.location.hash).toBe("#/");
  expect(takeDeviceLink()?.code).toBe(code);
});
