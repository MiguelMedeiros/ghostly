import { act, render, screen, waitFor } from "@testing-library/react";
import { createChatInvite } from "@ghostly/core";
import { afterEach, expect, it } from "vitest";
import { Root } from "../../Root";
import { ensureSession, getPrefix, loadSession, loadShownSession, sessionPeerKey, storedSession } from "../../lib/storage";
import { readInvite } from "../../lib/url";

// covers: invite.link

/*
 * A chat's address names a chat by its id, and a chat's id never has `_`: an id that has one is another of the
 * profile's keys (`chat_folders`, `app_settings`) or, in the first profile, whose prefix starts every other profile's,
 * another profile's chat. Neither reads as a chat: the address says the chat is gone and leaves the address bar.
 */

afterEach(() => { window.location.hash = ""; });

/** The address is set on the running page. */
function go(hash: string): void {
  window.location.hash = hash;
  // A browser says a fragment navigation with `popstate` (what the router listens to); happy-dom says only `hashchange`.
  act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
}

/** A chat stored under another profile's prefix, as that profile keeps it: its id in this profile's address form. */
function otherProfilesChat(): string {
  const reading = readInvite(createChatInvite().inviteCode);
  if (!reading.ok) throw new Error("a fresh invite reads");
  const id = ensureSession(reading.keys);
  const raw = storedSession(id);
  if (!raw) throw new Error("the chat is stored");
  localStorage.removeItem(`${getPrefix()}${id}`);
  localStorage.setItem(`${getPrefix()}abcdefghij_${id}`, raw);
  return `abcdefghij_${id}`;
}

it("another of the profile's keys is no chat", () => {
  localStorage.setItem(`${getPrefix()}chat_folders`, JSON.stringify({ folders: [] }));
  expect(loadSession("chat_folders")).toBeNull();
  expect(loadShownSession("chat_folders")).toBeNull();
  expect(storedSession("chat_folders")).toBeNull();
});

it("in the first profile, another profile's chat is no chat of this one", () => {
  const id = otherProfilesChat();
  expect(loadSession(id)).toBeNull();
  expect(loadShownSession(id)).toBeNull();
  expect(storedSession(id)).toBeNull();
  expect(sessionPeerKey(id)).toBeUndefined();
});

it("the address of another of the profile's keys says the chat is gone and leaves the address", async () => {
  localStorage.setItem(`${getPrefix()}chat_folders`, JSON.stringify({ folders: [] }));
  render(<Root />);
  go("#/chat/chat_folders");
  const notice = await screen.findByTestId("invite-link-invalid");
  expect(notice).toHaveTextContent("This chat is gone from this device.");
  await waitFor(() => expect(window.location.hash).toBe("#/"));
});

it("the address of another profile's chat says the chat is gone and leaves the address", async () => {
  const id = otherProfilesChat();
  render(<Root />);
  go(`#/chat/${id}`);
  const notice = await screen.findByTestId("invite-link-invalid");
  expect(notice).toHaveTextContent("This chat is gone from this device.");
  await waitFor(() => expect(window.location.hash).toBe("#/"));
});
