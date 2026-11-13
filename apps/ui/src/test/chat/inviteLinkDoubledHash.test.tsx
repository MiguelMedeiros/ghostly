import { act, render, screen, waitFor } from "@testing-library/react";
import { createChatInvite, createDeviceInvite } from "@ghostly/core";
import { afterEach, expect, it } from "vitest";
import { Root } from "../../Root";
import { takeDeviceLink } from "../../lib/devices";
import { listSessions } from "../../lib/storage";

// covers: invite.link

/*
 * A link with a doubled `#` before its code (`##ghostly1…`, or the app's own `#/` with a `#ghostly1…` after it) is
 * the same link: the router reads it as home with a hash, and the code was left in the address with nothing opened.
 */

afterEach(() => { window.location.hash = ""; takeDeviceLink(); });

it.each(["##{code}", "#/#{code}", "##{code}/"])("an invite opened as %s joins, and leaves the address", async (form) => {
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
