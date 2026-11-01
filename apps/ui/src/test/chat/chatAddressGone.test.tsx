import { act, render, screen, waitFor } from "@testing-library/react";
import { createChatInvite } from "@ghostly/core";
import { afterEach, expect, it } from "vitest";
import { Root } from "../../Root";
import { deleteSession, ensureSession, listSessions } from "../../lib/storage";
import { readInvite } from "../../lib/url";

// covers: invite.link

/*
 * The address of a chat no longer on this device (a bookmark, a link kept from before it was deleted) says the chat is
 * gone, as a group's does; the person was not opening an invite. A code that looks like an invite keeps its refusal.
 */

afterEach(() => { window.location.hash = ""; });

/** The address is set on the running page. */
function go(hash: string): void {
  window.location.hash = hash;
  // A browser says a fragment navigation with `popstate` (what the router listens to); happy-dom says only `hashchange`.
  act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
}

it("a deleted chat's address says the chat is gone from this device, not that it is no invite", async () => {
  const reading = readInvite(createChatInvite().inviteCode);
  if (!reading.ok) throw new Error("a fresh invite reads");
  const id = ensureSession(reading.keys);
  deleteSession(id);
  expect(listSessions()).toHaveLength(0);

  render(<Root />);
  go(`#/chat/${id}`);
  const notice = await screen.findByTestId("invite-link-invalid");
  expect(notice).toHaveTextContent("This chat is gone from this device.");
  expect(notice).not.toHaveTextContent("This is not a Ghostly invite.");
  await waitFor(() => expect(window.location.hash).toBe("#/"));
});

it("a code that looks like an invite keeps its refusal", async () => {
  render(<Root />);
  go("#/chat/ghostly1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq");
  const notice = await screen.findByTestId("invite-link-invalid");
  expect(notice).not.toHaveTextContent("This chat is gone from this device.");
  await waitFor(() => expect(window.location.hash).toBe("#/"));
});
