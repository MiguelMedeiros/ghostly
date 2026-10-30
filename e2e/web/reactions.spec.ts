import type { Locator, Page } from "@playwright/test";
import { chat, connect, deployedBuild, expect, link, openProfilePage, say, test, type Peer } from "../support/fixtures";

/**
 * Reactions (WISP 400 § Reactions). In a 1:1 chat Alice reacts to Bob's message from the React button, changes it from
 * the message's ⋮, Bob adds the same by clicking her chip, and Alice takes hers back: each side sees the other's, the
 * chips name who reacted, and Bob's chat list says it without an unread count. In a group, a member's reaction reaches
 * the others with their name. An app from before reactions gets nothing, and its contact's chip stays on their side.
 */

/** The row whose own text is `text` (a reply's quote holds other words, so the text itself is matched). */
const row = (page: Page, text: string) => page.locator(".chat-wallpaper [data-message-row]")
  .filter({ has: page.getByTestId("message-text").filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) }).last();
const chips = (target: Locator) => target.getByTestId("reaction-chip");
const chip = (target: Locator, emoji: string) => target.locator(`[data-testid="reaction-chip"][data-emoji="${emoji}"]`);

async function setName(peer: Peer, name: string): Promise<void> {
  await openProfilePage(peer.page);
  await peer.page.getByTestId("account-nickname").fill(name);
  await expect(peer.page.getByTestId("account-nickname")).toHaveValue(name);
  await peer.page.goBack();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

/** Opens the quick bar from the React button beside the message and picks `emoji` (or + and the panel's search). */
async function react(page: Page, target: Locator, emoji: string, fromPanel?: string): Promise<void> {
  await target.hover();
  await target.getByTestId("message-react-action").click();
  const bar = page.getByTestId("reaction-bar");
  await expect(bar).toBeVisible();
  if (fromPanel) {
    await bar.getByTestId("reaction-more").click();
    const picker = page.getByTestId("reaction-picker");
    await picker.getByTestId("expression-search").fill(fromPanel);
    await picker.locator(`[data-emoji="${emoji}"]`).first().click();
    await expect(picker).toHaveCount(0);
    return;
  }
  await bar.locator(`[data-testid="reaction-quick"][data-emoji="${emoji}"]`).click();
  await expect(bar).toHaveCount(0);
}

test("1:1 reactions: add, change, the same one from the contact, take back; who reacted; the chat list", { tag: ["@feature:chat.reactions", "@feature:chat.reactions.wire"] }, async ({ peer }, testInfo) => {
  test.setTimeout(5 * 60_000);
  const [alice, bob] = await Promise.all([peer("react-alice"), peer("react-bob")]);
  await Promise.all([setName(alice, "Alice"), setName(bob, "Bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  await say(bob, "lunch at noon?");
  const hers = row(alice.page, "lunch at noon?");
  await expect(hers).toBeVisible();
  // Bob steps out of the chat: the reaction must not count as unread there.
  await bob.page.evaluate(() => { location.hash = "#/"; });
  await expect(chat(bob)).toHaveCount(0);

  // Alice reacts from the React button: her chip at once, marked hers.
  await react(alice.page, hers, "👍");
  await expect(chips(hers)).toHaveCount(1);
  await expect(chip(hers, "👍")).toHaveAttribute("aria-pressed", "true");

  // Bob's chat list says it, and counts nothing unread.
  const bobRow = bob.page.getByTestId("chat-row").first();
  await expect(bobRow.getByTestId("chat-row-note")).toHaveText('Alice reacted 👍 to "lunch at noon?"', { timeout: 60_000 });
  await expect(bobRow.getByTestId("chat-row-unread")).toHaveCount(0);
  await bobRow.click();
  const his = row(bob.page, "lunch at noon?");
  await expect(chip(his, "👍")).toHaveAttribute("aria-pressed", "false");
  await expect(chip(his, "👍")).toHaveAccessibleName("👍: Alice");

  // Alice changes it from the message's ⋮ → React: one reaction per person, the new one replaces the old.
  await hers.hover();
  await hers.getByTestId("message-options").click();
  await alice.page.getByTestId("message-react").click();
  await alice.page.locator('[data-testid="reaction-quick"][data-emoji="❤️"]').click();
  await expect(chips(hers)).toHaveCount(1);
  await expect(chip(hers, "❤️")).toHaveAttribute("aria-pressed", "true");
  await expect(chips(his)).toHaveCount(1);
  await expect(chip(his, "❤️")).toBeVisible();

  // Bob clicks her chip: the same emoji from him, two of them, his marked on his side.
  await chip(his, "❤️").click();
  await expect(chip(his, "❤️")).toHaveAttribute("aria-pressed", "true");
  await expect(chip(his, "❤️").getByTestId("reaction-count")).toHaveText("2");
  await expect(chip(hers, "❤️").getByTestId("reaction-count")).toHaveText("2");
  // Who reacted, on hover (again if the list was still scrolling under the pointer).
  await expect(async () => {
    await alice.page.mouse.move(0, 0);
    await chip(hers, "❤️").hover();
    await expect(alice.page.getByTestId("reaction-who")).toHaveText(/You, Bob/, { timeout: 1_500 });
  }).toPass({ timeout: 20_000 });
  await alice.page.screenshot({ path: testInfo.outputPath("reaction-chips.png") });

  // Alice takes hers back with a click on her chip: Bob's stays, on both sides.
  await chip(hers, "❤️").click();
  await expect(chip(hers, "❤️")).toHaveAttribute("aria-pressed", "false");
  await expect(chip(hers, "❤️").getByTestId("reaction-count")).toHaveCount(0);
  await expect(chip(his, "❤️").getByTestId("reaction-count")).toHaveCount(0);
  await expect(chip(his, "❤️")).toHaveAttribute("aria-pressed", "true");

  // Any emoji through + and the emoji panel, on a message of her own.
  await say(alice, "see you there");
  const mine = row(alice.page, "see you there");
  await expect(row(bob.page, "see you there")).toBeVisible();
  await react(alice.page, mine, "🎉", "party");
  await expect(chip(row(bob.page, "see you there"), "🎉")).toBeVisible();

  // Alice edits the message her reaction quotes: Bob's chat list line follows the new text.
  const bobNote = bob.page.getByTestId("chat-row").first().getByTestId("chat-row-note");
  await expect(bobNote).toHaveText('Alice reacted 🎉 to "see you there"', { timeout: 60_000 });
  await mine.hover();
  await mine.getByTestId("message-options").click();
  await alice.page.getByTestId("message-edit").click();
  const box = alice.page.getByPlaceholder("Message…");
  await box.fill("see you at one");
  await box.press("Enter");
  await expect(row(bob.page, "see you at one")).toBeVisible({ timeout: 60_000 });
  await expect(bobNote).toHaveText('Alice reacted 🎉 to "see you at one"', { timeout: 30_000 });
});

test("a message taller than the chat: the bar and the + panel open at the React button, in sight", { tag: ["@feature:chat.reactions"] }, async ({ peer }) => {
  test.setTimeout(4 * 60_000);
  const [alice, bob] = await Promise.all([peer("react-tall-alice"), peer("react-tall-bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  // Two screens of lines, one message: the React button beside its middle.
  const lines = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n");
  await say(bob, lines);
  const tall = alice.page.locator(".chat-wallpaper [data-message-row]").filter({ hasText: "line 120" }).last();
  await expect(tall).toBeVisible({ timeout: 60_000 });
  const list = alice.page.locator("[data-message-list]");
  const button = tall.getByTestId("message-react-action");
  const listBox = (await list.boundingBox())!;
  const bubble = (await tall.locator("[data-message-bubble]").boundingBox())!;
  expect(bubble.height).toBeGreaterThan(listBox.height * 1.5);

  /** Scrolls the list until the React button is `from` px under the list's top edge. */
  const scrollButtonTo = async (from: number) => {
    await button.evaluate((el, from) => {
      const scroller = el.closest<HTMLElement>("[data-message-list]")!;
      scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - from;
    }, from);
  };
  const inside = async (testId: string) => {
    const box = (await alice.page.getByTestId(testId).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(listBox.y);
    expect(box.y + box.height).toBeLessThanOrEqual(listBox.y + listBox.height);
    // Beside the button, not at an edge of the bubble.
    const at = (await button.boundingBox())!;
    expect(Math.min(Math.abs(box.y + box.height - at.y), Math.abs(box.y - (at.y + at.height)))).toBeLessThan(16);
  };

  // The bubble's middle in sight (the bar above the button), then near the list's top (the bar below it) and its
  // bottom (above it again).
  for (const from of [listBox.height / 2, 30, listBox.height - 60]) {
    await scrollButtonTo(from);
    // On the button itself: hovering the row would scroll its middle into view.
    await button.click();
    await expect(alice.page.getByTestId("reaction-bar")).toBeVisible();
    await inside("reaction-bar");
    await alice.page.keyboard.press("Escape");
    await expect(alice.page.getByTestId("reaction-bar")).toHaveCount(0);
  }

  // The + panel, too: in the list, by the button, as tall as the room there.
  await scrollButtonTo(listBox.height / 2);
  await button.click();
  await alice.page.getByTestId("reaction-more").click();
  await expect(alice.page.getByTestId("reaction-picker")).toBeVisible();
  await inside("reaction-picker");
});

test("an app from before reactions gets nothing, and its contact's chip stays on their side", { tag: ["@feature:chat.reactions.wire"] }, async ({ peer }) => {
  test.skip(deployedBuild, "a deployed build is a release build: it ignores ghostly-test-reactions");
  test.setTimeout(4 * 60_000);
  const [alice, bob] = await Promise.all([peer("react-new"), peer("react-old")]);
  // Bob's page stands in for an older app: it never says react/1.
  await bob.page.evaluate(() => localStorage.setItem("ghostly-test-reactions", "off"));
  await bob.page.reload();
  await expect(bob.page.getByTitle("New Chat")).toBeVisible();
  await link(alice, bob);
  await connect(alice, bob);

  await say(bob, "from an old app");
  const hers = row(alice.page, "from an old app");
  await react(alice.page, hers, "😂");
  await expect(chip(hers, "😂")).toHaveAttribute("aria-pressed", "true");
  // Messages still flow both ways; the old app shows no reaction and nothing odd.
  await say(alice, "still talking");
  await expect(chat(bob).getByText("still talking")).toBeVisible();
  await expect(chips(row(bob.page, "from an old app"))).toHaveCount(0);
  await expect(chat(bob).getByText("😂")).toHaveCount(0);

  // Alice takes hers back from the keyboard: the chip goes, and the focus stays on the message it was under.
  await chip(hers, "😂").focus();
  await alice.page.keyboard.press("Enter");
  await expect(chips(hers)).toHaveCount(0);
  await expect(hers).toBeFocused();
});

test("a reaction in a group reaches the other member, named", { tag: ["@feature:groups.reactions", "@feature:groups.protocol.reactions"] }, async ({ peer }) => {
  test.setTimeout(8 * 60_000);
  const [alice, bob] = await Promise.all(["alice", "bob"].map(name => peer(`react-group-${name}`)));
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
  await expect(chat(alice).getByText("hi from Bob")).toBeVisible({ timeout: 120_000 });
  await say(alice, "who is in for pizza?");
  await expect(chat(bob).getByText("who is in for pizza?")).toBeVisible({ timeout: 120_000 });

  // Bob reacts to Alice's message; she sees it, with his name.
  const question = row(bob.page, "who is in for pizza?");
  await react(bob.page, question, "🙏");
  await expect(chip(question, "🙏")).toHaveAttribute("aria-pressed", "true");
  const hers = row(alice.page, "who is in for pizza?");
  await expect(chip(hers, "🙏")).toBeVisible({ timeout: 120_000 });
  await expect(chip(hers, "🙏")).toHaveAccessibleName("🙏: Bob");
  // Alice adds the same with a click: two, on both sides.
  await chip(hers, "🙏").click();
  await expect(chip(question, "🙏").getByTestId("reaction-count")).toHaveText("2", { timeout: 120_000 });
});
