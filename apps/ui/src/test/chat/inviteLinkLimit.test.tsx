import { act, render, screen, waitFor } from "@testing-library/react";
import { createChatInvite } from "@ghostly/core";
import { afterEach, expect, it } from "vitest";
import { Root } from "../../Root";
import { LINK_CHATS_WAITING, ensureSession, linkChatsWaiting, listSessions, saveSession } from "../../lib/storage";
import { readInvite } from "../../lib/url";

// covers: invite.link

/*
 * An invite link opened in the app makes a chat with no act of the person's: a page can send the browser to one, and
 * a code needs nobody behind it. So only a few link-made chats may wait for an answer at once. Past that a link makes
 * nothing and says so, until one of them is answered or deleted. Join's paste and scan are not counted.
 */

afterEach(() => { window.location.hash = ""; });

/** The address is given another invite while the app is open. */
async function follow(code: string): Promise<void> {
  window.location.hash = `#${code}`;
  // A browser says a fragment navigation with `popstate` (what the router listens to); happy-dom says only `hashchange`.
  act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
  // The code leaves the address whatever comes of it.
  await waitFor(() => expect(window.location.hash).not.toContain(code));
}

it("an invite link makes a chat only while few link-made chats wait for an answer", async () => {
  const codes = Array.from({ length: LINK_CHATS_WAITING + 3 }, () => createChatInvite().inviteCode);
  window.location.hash = `#${codes[0]}`;
  render(<Root />);
  await waitFor(() => expect(listSessions()).toHaveLength(1));
  for (let at = 1; at < codes.length - 1; at++) await follow(codes[at]);

  // The first ones each made a chat; the ones past the limit made none, and the app says why.
  expect(listSessions()).toHaveLength(LINK_CHATS_WAITING);
  expect(listSessions().every((session) => session.viaLink)).toBe(true);
  expect(await screen.findByTestId("invite-link-invalid")).toHaveTextContent("Too many invite links opened. Delete a chat that got no answer, or paste the invite in Join.");
  expect(window.location.hash).toBe("#/");

  // A link to a chat it already made still opens that chat.
  const first = listSessions().find((session) => session.mySeedB64 === (readInvite(codes[0]) as { keys: { seedB64: string } }).keys.seedB64)!;
  await follow(codes[0]);
  await waitFor(() => expect(window.location.hash).toBe(`#/chat/${first.id}`));
  expect(listSessions()).toHaveLength(LINK_CHATS_WAITING);

  // One of them is answered: a link makes a chat again.
  saveSession({ ...first, messages: [{ id: "m1", text: "hi", timestamp: Date.now(), sender: "peer" }] as never, lastSyncAt: Date.now() });
  expect(linkChatsWaiting()).toBe(LINK_CHATS_WAITING - 1);
  await follow(codes[codes.length - 1]);
  await waitFor(() => expect(listSessions()).toHaveLength(LINK_CHATS_WAITING + 1));
}, 120_000);

it("an invite the person pasted or scanned in Join is not counted, and is not held back", () => {
  for (let at = 0; at < LINK_CHATS_WAITING + 2; at++) {
    const reading = readInvite(createChatInvite().inviteCode);
    if (!reading.ok) throw new Error("a fresh invite reads");
    ensureSession(reading.keys);
  }
  expect(listSessions()).toHaveLength(LINK_CHATS_WAITING + 2);
  expect(linkChatsWaiting()).toBe(0);
});
