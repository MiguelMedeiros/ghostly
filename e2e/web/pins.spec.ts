import type { Page } from "@playwright/test";
import { connect, expect, link, say, test, type Peer } from "../support/fixtures";

/**
 * A pinned message (WISP 400 § Pinned message). In a 1:1 chat Alice pins Bob's message from its ⋮: the bar under the
 * header shows it on both sides, a click on Bob's scrolls to it and marks it, and Bob unpins it for both. In a
 * community, the admin pins and the member sees it; only the admin has Pin.
 */

/** The row whose own text is `text`. */
const row = (page: Page, text: string) => page.locator(".chat-wallpaper [data-message-row]")
  .filter({ has: page.getByTestId("message-text").filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) }).last();

/** Opens the message's ⋮. */
async function options(page: Page, text: string): Promise<void> {
  const target = row(page, text);
  await target.hover();
  await target.getByTestId("message-options").click();
  await expect(page.getByTestId("message-menu")).toBeVisible();
}

test("1:1 pin: the bar on both sides, a click jumps to the message, unpin for both", { tag: ["@feature:chat.pins", "@feature:chat.pins.wire"] }, async ({ peer }) => {
  test.setTimeout(5 * 60_000);
  const [alice, bob] = await Promise.all([peer("pin-alice"), peer("pin-bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  await say(bob, "the plan: meet at 8");
  await expect(row(alice.page, "the plan: meet at 8")).toBeVisible();
  await say(alice, "ok");
  await say(bob, "see you");
  await expect(row(alice.page, "see you")).toBeVisible();

  // Alice pins Bob's message from its ⋮.
  await options(alice.page, "the plan: meet at 8");
  await alice.page.getByTestId("message-pin").click();
  await expect(alice.page.getByTestId("pinned-snippet")).toHaveText("the plan: meet at 8");

  // It reaches Bob: his bar shows it, and a click takes him to the message and marks it.
  await expect(bob.page.getByTestId("pinned-snippet")).toHaveText("the plan: meet at 8", { timeout: 60_000 });
  await bob.page.getByTestId("pinned-open").click();
  await expect(row(bob.page, "the plan: meet at 8")).toHaveAttribute("data-reply-flash", "");
  await expect(row(bob.page, "the plan: meet at 8")).toBeInViewport();

  // The ⋮ of the pinned message says Unpin; the bar's ⓘ says what a pin is.
  await options(bob.page, "the plan: meet at 8");
  await expect(bob.page.getByTestId("message-pin")).toHaveText(/Unpin/);
  await bob.page.keyboard.press("Escape");
  await bob.page.getByTestId("pinned-info").click();
  await expect(bob.page.getByTestId("pinned-info-text")).toContainText("One pinned message per chat");

  // Bob unpins from the bar: gone on both sides.
  await bob.page.getByTestId("pinned-unpin").click();
  await expect(bob.page.getByTestId("pinned-bar")).toHaveCount(0);
  await expect(alice.page.getByTestId("pinned-bar")).toHaveCount(0, { timeout: 60_000 });
});

test("a community's admin pins, the member sees it and jumps to it; only the admin has Pin", { tag: ["@feature:groups.pins", "@feature:groups.protocol.pins"] }, async ({ peer }) => {
  test.setTimeout(8 * 60_000);
  const [alice, bob] = await Promise.all(["alice", "bob"].map(name => peer(`pin-group-${name}`)));
  const groupChat = (p: Peer) => p.page.getByTestId("group-chat");

  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await alice.page.getByTestId("new-group-name").fill("Trip");
  await alice.page.getByTestId("new-group-create").click();
  const share = alice.page.getByTestId("group-share-dialog");
  const url = await share.getByTestId("group-link-url").inputValue();
  await share.getByTestId("group-share-done").click();
  await bob.page.goto(url);
  await expect(groupChat(bob)).toHaveAttribute("data-status", "active", { timeout: 180_000 });
  await say(bob, "hi");
  await expect(groupChat(alice).getByText("hi", { exact: true })).toBeVisible({ timeout: 120_000 });
  await say(alice, "train at 9:40, platform 3");
  await expect(groupChat(bob).getByText("train at 9:40, platform 3")).toBeVisible({ timeout: 120_000 });

  // Bob is a member of a community: his ⋮ has no Pin.
  await options(bob.page, "train at 9:40, platform 3");
  await expect(bob.page.getByTestId("message-react")).toBeVisible();
  await expect(bob.page.getByTestId("message-pin")).toHaveCount(0);
  await bob.page.keyboard.press("Escape");

  // Alice, the admin, pins her message: Bob's bar shows it, and takes him to it.
  await options(alice.page, "train at 9:40, platform 3");
  await alice.page.getByTestId("message-pin").click();
  await expect(alice.page.getByTestId("pinned-snippet")).toHaveText("train at 9:40, platform 3");
  await expect(bob.page.getByTestId("pinned-snippet")).toHaveText("train at 9:40, platform 3", { timeout: 120_000 });
  await expect(bob.page.getByTestId("pinned-unpin")).toHaveCount(0);
  await bob.page.getByTestId("pinned-open").click();
  await expect(row(bob.page, "train at 9:40, platform 3")).toHaveAttribute("data-reply-flash", "");
});
