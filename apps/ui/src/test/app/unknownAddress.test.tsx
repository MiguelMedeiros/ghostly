import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Root } from "../../Root";

// covers: invite.link

/*
 * An address no page answers and no intake takes: home, with the list and its ways out, not an empty screen that a
 * reload keeps. One part or several, either way.
 */

afterEach(() => { window.location.hash = ""; });

it.each(["#/wallets", "#/join", "#/nonsense", "#/wallet/x", "#/settings/a/b", "#/chat", "#/chat/"])("%s goes home", async (address) => {
  window.location.hash = address;
  render(<Root />);
  expect(await screen.findByTestId("sidebar")).toBeInTheDocument();
  await waitFor(() => expect(window.location.hash).toBe("#/"));
});

/*
 * A route that starts with `//` or `/\` (a link pasted after a `/`, an extra `/` typed): read as another site's
 * address, the router refused to go there and the app opened on "Something went wrong".
 */
it.each(["#//x", "#///x", "#//settings", "#//join/abc", "#//ghostly1abc", "#//chat/abc", "#/\\x"])("%s goes home", async (address) => {
  window.location.hash = address;
  render(<Root />);
  expect(await screen.findByTestId("sidebar")).toBeInTheDocument();
  await waitFor(() => expect(window.location.hash).toBe("#/"));
});

it("an invite code that can't be read still says why, and goes home", async () => {
  window.location.hash = "#ghostly1nothing";
  render(<Root />);
  expect(await screen.findByTestId("invite-link-invalid")).toBeInTheDocument();
  await waitFor(() => expect(window.location.hash).toBe("#/"));
  expect(await screen.findByTestId("sidebar")).toBeInTheDocument();
});
