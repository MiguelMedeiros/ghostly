import type { Page } from "@playwright/test";
import { chat, connect, expect, link, openProfilePage, say, test, type Peer } from "../support/fixtures";

/**
 * Replies (WISP 400 § Replies). In a 1:1 chat, Bob answers a message of Alice's that is out of view: from the reply
 * button beside it, the ⋮ and a swipe on a phone, with the composer's quote bar and Escape to let go. Both bubbles
 * quote it, and on Alice's side a tap on the quote brings her own message back into view and marks it. In a group,
 * a reply and a mention go together.
 */

/** The row whose own text is `text`: a reply's quote holds the original's words too, so the text is matched, not the row. */
const row = (page: Page, text: string) => page.locator(".chat-wallpaper [data-message-row]")
  .filter({ has: page.getByTestId("message-text").filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) }).last();
const bar = (page: Page) => page.getByTestId("composer-reply");

/** A finger dragging a message sideways by `dx`, as a touch screen sends it. */
async function swipe(page: Page, text: string, dx: number): Promise<void> {
  const target = row(page, text).locator("[data-message-bubble]");
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  const at = (x: number) => ({ pointerType: "touch", pointerId: 7, isPrimary: true, button: 0, buttons: 1, clientX: box.x + 20 + x, clientY: box.y + box.height / 2 });
  await target.dispatchEvent("pointerdown", at(0));
  for (const x of [15, 35, 60, dx]) await target.dispatchEvent("pointermove", at(x));
  await target.dispatchEvent("pointerup", at(dx));
}

test("a 1:1 reply: started three ways, sent both ways, and a tap on the quote goes to the original", { tag: ["@feature:chat.replies", "@feature:chat.replies.wire"] }, async ({ peer }, testInfo) => {
  test.setTimeout(5 * 60_000);
  const [alice, bob] = await Promise.all([peer("reply-alice"), peer("reply-bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  for (const p of [alice, bob]) await p.page.setViewportSize({ width: 1000, height: 560 });

  await say(alice, "lunch at noon?");
  // Enough after it that it is out of view on both sides.
  for (let i = 1; i <= 12; i++) await say(alice, `filler ${i}`);
  await expect(chat(bob).getByText("filler 12")).toBeVisible();

  // Bob answers from the reply button beside the message: the bar names it, and the field has the focus.
  const original = row(bob.page, "lunch at noon?");
  await original.hover();
  await original.getByTestId("message-reply-action").click();
  await expect(bar(bob.page).getByTestId("reply-quote-snippet")).toHaveText("lunch at noon?");
  await expect(bob.page.getByPlaceholder("Message…")).toBeFocused();
  // Escape lets go of it; the message's ⋮ answers it again.
  await bob.page.keyboard.press("Escape");
  await expect(bar(bob.page)).toHaveCount(0);
  await original.hover();
  await original.getByTestId("message-options").click();
  await bob.page.getByTestId("message-reply").click();
  await expect(bar(bob.page).getByTestId("reply-quote-snippet")).toHaveText("lunch at noon?");
  await expect(bar(bob.page)).toHaveCSS("opacity", "1");
  await bob.page.screenshot({ path: testInfo.outputPath("composer-reply-bar.png") });
  await say(bob, "yes, see you there");
  await expect(bar(bob.page)).toHaveCount(0);
  await expect(row(bob.page, "yes, see you there").getByTestId("message-quote")).toHaveAttribute("data-state", "found");

  // Alice: the reply quotes her own message, checked against her history.
  const reply = row(alice.page, "yes, see you there");
  await expect(reply.getByTestId("message-quote")).toHaveAttribute("data-state", "found");
  await expect(reply.getByTestId("reply-quote-name")).toHaveText("You");
  await expect(reply.getByTestId("reply-quote-snippet")).toHaveText("lunch at noon?");
  const hers = row(alice.page, "lunch at noon?");
  await expect(hers).not.toBeInViewport();
  await reply.getByTestId("message-quote").click();
  await expect(hers).toBeInViewport();
  await expect(hers).toHaveAttribute("data-reply-flash", "");
  await alice.page.screenshot({ path: testInfo.outputPath("jumped-to-original.png") });
  await expect(hers).not.toHaveAttribute("data-reply-flash", { timeout: 5_000 });

  // And back: Alice answers Bob's reply, which Bob sees quoted as his own.
  await reply.hover();
  await reply.getByTestId("message-reply-action").click();
  await say(alice, "great");
  const back = row(bob.page, "great");
  await expect(back.getByTestId("reply-quote-name")).toHaveText("You");
  await expect(back.getByTestId("reply-quote-snippet")).toHaveText("yes, see you there");
  await bob.page.screenshot({ path: testInfo.outputPath("reply-bubbles.png") });

  // On a phone there is no reply button: a swipe to the right answers, and ✕ lets go.
  await bob.page.setViewportSize({ width: 390, height: 844 });
  await expect(row(bob.page, "filler 3").getByTestId("message-reply-action")).toBeHidden();
  await swipe(bob.page, "filler 3", 30);
  await expect(bar(bob.page)).toHaveCount(0);
  await swipe(bob.page, "filler 3", 90);
  await expect(bar(bob.page).getByTestId("reply-quote-snippet")).toHaveText("filler 3");
  await bar(bob.page).getByTestId("composer-reply-cancel").click();
  await expect(bar(bob.page)).toHaveCount(0);
});

async function setName(peer: Peer, name: string): Promise<void> {
  await openProfilePage(peer.page);
  await peer.page.getByTestId("account-nickname").fill(name);
  await expect(peer.page.getByTestId("account-nickname")).toHaveValue(name);
  await peer.page.goBack();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

test("a reply in a group, with a mention", { tag: ["@feature:groups.replies", "@feature:groups.protocol.replies", "@feature:groups.mentions"] }, async ({ peer }) => {
  test.setTimeout(8 * 60_000);
  const [alice, bob] = await Promise.all(["alice", "bob"].map(name => peer(`reply-group-${name}`)));
  await Promise.all([setName(alice, "Alice"), setName(bob, "Bob")]);
  const groupChat = (p: Peer) => p.page.getByTestId("group-chat");

  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await alice.page.getByTestId("new-group-name").fill("Pizza night");
  await alice.page.getByTestId("new-group-create").click();
  const share = alice.page.getByTestId("group-share-dialog");
  const url = await share.getByTestId("group-link-url").inputValue();
  await share.getByTestId("group-share-done").click();
  await bob.page.goto(url);
  await expect(groupChat(bob)).toHaveAttribute("data-status", "active", { timeout: 180_000 });
  // A community member's name travels with what they say.
  await say(bob, "hi from Bob");
  await expect(groupChat(alice).getByText("hi from Bob")).toBeVisible({ timeout: 120_000 });
  await say(alice, "who is in for pizza?");
  await expect(groupChat(bob).getByText("who is in for pizza?")).toBeVisible({ timeout: 120_000 });

  // Bob answers Alice's message and names her.
  const question = row(bob.page, "who is in for pizza?");
  await question.hover();
  await question.getByTestId("message-options").click();
  await bob.page.getByTestId("message-reply").click();
  await expect(bar(bob.page).getByTestId("reply-quote-name")).toHaveText("Alice");
  const box = bob.page.getByPlaceholder("Message…");
  await box.pressSequentially("@Al");
  await expect(bob.page.getByTestId("mention-picker").getByRole("option")).toHaveText([/^Alice…/]);
  await box.press("Enter");
  await box.pressSequentially("me, obviously");
  await box.press("Enter");
  await expect(bar(bob.page)).toHaveCount(0);
  await expect(row(bob.page, "@Alice me, obviously").getByTestId("reply-quote-name")).toHaveText("Alice");

  // Alice: the quote of her question, and the mention of her.
  const reply = row(alice.page, "@Alice me, obviously");
  await expect(reply.getByTestId("message-quote")).toHaveAttribute("data-state", "found", { timeout: 120_000 });
  await expect(reply.getByTestId("reply-quote-name")).toHaveText("You");
  await expect(reply.getByTestId("reply-quote-snippet")).toHaveText("who is in for pizza?");
  await expect(reply.getByTestId("mention")).toHaveText("@Alice");
  await expect(reply.getByTestId("mention")).toHaveAttribute("data-me", "true");
});
