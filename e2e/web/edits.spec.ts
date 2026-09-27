import type { Page } from "@playwright/test";
import { chat, connect, expect, link, say, test, type Peer } from "../support/fixtures";

/**
 * Editing a sent message (WISP 400 § Edits) between two web apps. Alice edits her text from its ⋮ and with ↑ in an
 * empty composer; Bob sees the new text in place, marked edited, with the earlier versions in its details, and his chat
 * list follows. An edit made while Bob's session is gone reaches him when he is back. A Bob whose app does not say
 * edit/1 (an older one) keeps the text he has and gets no second message; once his app shows edits, it arrives.
 */

/** The row whose own text is exactly `text`. */
const row = (page: Page, text: string) => page.locator(".chat-wallpaper [data-message-row]")
  .filter({ has: page.getByTestId("message-text").filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) }).last();
const field = (p: Peer) => p.page.getByPlaceholder("Message…");
const connected = (p: Peer) => expect(p.page.getByTestId("connection-options")).toHaveAttribute("aria-label", /Connected/, { timeout: 120_000 });

/** Alice edits the row with `from` into `to`, from its ⋮. */
async function editFromMenu(p: Peer, from: string, to: string): Promise<void> {
  const target = row(p.page, from);
  await target.hover();
  await target.getByTestId("message-options").click();
  await p.page.getByTestId("message-edit").click();
  await expect(p.page.getByTestId("composer-edit")).toBeVisible();
  await expect(field(p)).toHaveValue(from);
  await field(p).fill(to);
  await field(p).press("Enter");
  await expect(p.page.getByTestId("composer-edit")).toHaveCount(0);
}

async function reopen(p: Peer): Promise<void> {
  const url = p.page.url();
  await p.page.close();
  p.page = await p.context.newPage();
  await p.page.goto(url);
  await expect(field(p)).toBeVisible({ timeout: 60_000 });
}

test("an edit shows on the contact's side in place, marked edited, with the history in its details", { tag: ["@feature:chat.edit", "@feature:chat.edit.wire"] }, async ({ peer }) => {
  test.setTimeout(4 * 60_000);
  const [alice, bob] = await Promise.all([peer("edit-alice"), peer("edit-bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  await say(alice, "Working: 0 of 2");
  await expect(row(bob.page, "Working: 0 of 2")).toBeVisible();
  await editFromMenu(alice, "Working: 0 of 2", "Working: 1 of 2");
  await expect(row(alice.page, "Working: 1 of 2").getByTestId("message-edited")).toBeVisible();

  // Bob: the same message with the new text, marked; no second message.
  const edited = row(bob.page, "Working: 1 of 2");
  await expect(edited.getByTestId("message-edited")).toHaveText("edited", { timeout: 30_000 });
  await expect(chat(bob).getByText("Working: 0 of 2", { exact: true })).toHaveCount(0);

  // ↑ in Alice's empty composer edits her last message.
  await field(alice).click();
  await field(alice).press("ArrowUp");
  await expect(alice.page.getByTestId("composer-edit")).toBeVisible();
  await expect(field(alice)).toHaveValue("Working: 1 of 2");
  await field(alice).fill("Done: 2 of 2");
  await field(alice).press("Enter");
  await expect(row(bob.page, "Done: 2 of 2").getByTestId("message-edited")).toBeVisible({ timeout: 30_000 });
  // The confirmation came back: Alice's mark no longer waits.
  await expect(row(alice.page, "Done: 2 of 2").getByTestId("message-edited")).not.toHaveAttribute("data-pending", { timeout: 30_000 });
  // Bob's chat list shows the new text.
  await expect(bob.page.getByTestId("sidebar").getByTestId("chat-row").first()).toContainText("Done: 2 of 2");

  // Its details keep the earlier versions, the original first.
  await row(bob.page, "Done: 2 of 2").getByTestId("message-text").dblclick();
  const versions = bob.page.getByTestId("message-details").locator('[data-section="edits"] [data-testid="message-details-row"]');
  await expect(versions.nth(0)).toHaveAttribute("data-value", /^2, the last at /);
  await expect(versions.nth(1)).toHaveAttribute("data-label", /^Original, /);
  await expect(versions.nth(1)).toHaveAttribute("data-value", "Working: 0 of 2");
  await expect(versions.nth(2)).toHaveAttribute("data-value", "Working: 1 of 2");
  await bob.page.keyboard.press("Escape");

  // A reload keeps it all.
  await bob.page.reload();
  await expect(row(bob.page, "Done: 2 of 2").getByTestId("message-edited")).toBeVisible({ timeout: 60_000 });
});

test("an edit made while the contact's session is gone reaches it when it is back", { tag: ["@feature:chat.edit.wire"] }, async ({ peer }) => {
  test.setTimeout(6 * 60_000);
  const [alice, bob] = await Promise.all([peer("edit-off-alice"), peer("edit-off-bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  for (const p of [alice, bob]) await connected(p);
  await say(alice, "status: starting");
  await expect(row(bob.page, "status: starting")).toBeVisible();

  // Bob's app stops mid-session: the edit reaches a session that never reads it.
  const cdp = await bob.context.newCDPSession(bob.page);
  await cdp.send("Debugger.enable");
  await cdp.send("Debugger.pause");
  await editFromMenu(alice, "status: starting", "status: finished");
  await expect(row(alice.page, "status: finished").getByTestId("message-edited")).toHaveAttribute("data-pending", "true");

  await reopen(bob);
  await expect(row(bob.page, "status: finished").getByTestId("message-edited")).toBeVisible({ timeout: 150_000 });
  await expect(chat(bob).getByText("status: starting", { exact: true })).toHaveCount(0);
  await expect(row(alice.page, "status: finished").getByTestId("message-edited")).not.toHaveAttribute("data-pending", { timeout: 60_000 });
});

test("a contact whose app does not show edits keeps its text and gets no second message, until its app does", { tag: ["@feature:chat.edit.wire"] }, async ({ peer }) => {
  test.setTimeout(6 * 60_000);
  const [alice, bob] = await Promise.all([peer("edit-old-alice"), peer("edit-old-bob")]);
  // Bob's app says no edit/1, as one from before edits.
  await bob.page.evaluate(() => localStorage.setItem("ghostly-test-no-edit", "1"));
  await bob.page.reload();
  await link(alice, bob);
  await connect(alice, bob);
  await say(alice, "old text");
  await expect(row(bob.page, "old text")).toBeVisible();

  await editFromMenu(alice, "old text", "new text");
  const mark = row(alice.page, "new text").getByTestId("message-edited");
  await expect(mark).toHaveAttribute("data-pending", "true");
  await expect(mark).toHaveAttribute("title", "Not shown to your contact yet");
  await bob.page.waitForTimeout(5_000);
  await expect(row(bob.page, "old text")).toBeVisible();
  await expect(chat(bob).getByText("new text")).toHaveCount(0);
  await expect(mark).toHaveAttribute("data-pending", "true");

  // Bob's app now shows edits: the edit that waited arrives, and Alice's mark settles.
  await bob.page.evaluate(() => localStorage.removeItem("ghostly-test-no-edit"));
  await bob.page.reload();
  await expect(row(bob.page, "new text").getByTestId("message-edited")).toBeVisible({ timeout: 150_000 });
  await expect(chat(bob).getByText("old text", { exact: true })).toHaveCount(0);
  await expect(mark).not.toHaveAttribute("data-pending", { timeout: 60_000 });
});
