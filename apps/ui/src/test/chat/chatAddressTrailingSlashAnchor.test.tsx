import { render, waitFor } from "@testing-library/react";
import { createChatInvite } from "@ghostly/core";
import { expect, it } from "vitest";
import { Root } from "../../Root";
import { ensureSession } from "../../lib/storage";
import { readInvite } from "../../lib/url";

// covers: invite.link

/*
 * A stored chat's address with a trailing slash is the chat's address, as the router reads it: opened directly, it
 * gets home put under it like `#/chat/<id>` does, so Back leads home rather than out of the app. Alone in its file:
 * an anchor the page made earlier stays in the history and the next render reads it.
 */

it("a stored chat's address with a trailing slash, opened directly, gets home put under it", async () => {
  const reading = readInvite(createChatInvite().inviteCode);
  if (!reading.ok) throw new Error("a fresh invite reads");
  const id = ensureSession(reading.keys);
  window.location.hash = `#/chat/${id}/`;
  const before = window.history.length;

  render(<Root />);
  await waitFor(() => expect(window.history.length).toBe(before + 1));
  expect(window.location.hash).toBe(`#/chat/${id}/`);
});
