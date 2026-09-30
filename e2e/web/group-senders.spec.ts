import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, openProfilePage, say, test, type Peer } from "../support/fixtures";

/**
 * Who wrote what in a group, at a glance: each member's name above their messages in a colour from their key, and
 * their picture (here their initial: they are not contacts) beside the last bubble of each run of theirs, an empty
 * place of the same width beside the others. Three browsers, one group; Alice reads it at 1280 px and on a 375 px
 * phone (smaller pictures, nothing wider than the screen), and in a 330 px chat, where only the colours stay.
 *
 * GROUP_SENDERS_SHOTS=<dir> also saves Alice's view, light and dark, desktop and phone, there.
 */
const groupChat = (peer: Peer) => peer.page.getByTestId("group-chat");
const list = (page: Page) => page.locator("[data-message-list]");
const reachable = (peer: Peer, n: number, of: number) => expect(peer.page.getByTestId("group-members")).toContainText(`${n} of ${of} reachable`, { timeout: 150_000 });

async function setName(peer: Peer, name: string): Promise<void> {
  await openProfilePage(peer.page);
  await peer.page.getByTestId("account-nickname").fill(name);
  await expect(peer.page.getByTestId("account-nickname")).toHaveValue(name);
  await peer.page.goBack();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

async function theme(page: Page, scheme: "light" | "dark") {
  await page.evaluate(async (scheme) => {
    document.documentElement.setAttribute("data-theme", scheme);
    document.documentElement.style.colorScheme = scheme;
    await new Promise(requestAnimationFrame);
    await Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => {})));
  }, scheme);
}

/** Nothing in the page or the chat is wider than its box: no sideways scroll. */
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await list(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  // No bubble is cut by the edge of the screen.
  const outside = await page.locator("[data-message-bubble]").evaluateAll((bubbles) =>
    bubbles.filter((b) => { const r = b.getBoundingClientRect(); return r.left < 0 || r.right > window.innerWidth; }).length);
  expect(outside).toBe(0);
}

/** What Alice's timeline shows of each member's message: the name, its colour class, and the picture, its place or neither. */
const rows = (page: Page) => list(page).locator("[data-message-row][data-sender=peer]").evaluateAll((rows) => rows.map((row) => {
  const nick = row.querySelector<HTMLElement>("[data-testid=message-nick]");
  const avatar = row.querySelector("[data-testid=sender-avatar]") ? "avatar" : row.querySelector("[data-testid=sender-avatar-spacer]") ? "spacer" : "-";
  return { name: nick?.textContent ?? "", colour: nick?.className.match(/text-member-\d+/)?.[0] ?? "", avatar };
}));

test("a group's members each have a colour, and their picture beside the end of each run", { tag: ["@feature:groups.member-colors", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  test.setTimeout(8 * 60_000);
  const [alice, bob, carol] = await Promise.all([peer("alice"), peer("bob"), peer("carol")]);
  await Promise.all([setName(alice, "Alice"), setName(bob, "Bob"), setName(carol, "Carol")]);

  await alice.page.getByTestId("sidebar-new-more").click();
  await alice.page.getByTestId("new-group").click();
  await alice.page.getByTestId("new-group-name").fill("Lunch crew");
  await alice.page.getByTestId("new-group-kind-mesh").click();
  await alice.page.getByTestId("new-group-create").click();
  const shareDialog = alice.page.getByTestId("group-share-dialog");
  await expect(shareDialog.getByTestId("group-link-url")).toHaveValue(/#\/join\/group1\//);
  const url = await shareDialog.getByTestId("group-link-url").inputValue();
  await shareDialog.getByTestId("group-share-done").click();
  for (const p of [bob, carol]) {
    await p.page.goto(url);
    await expect(groupChat(p)).toHaveAttribute("data-status", "active", { timeout: 120_000 });
  }
  for (const p of [alice, bob, carol]) await reachable(p, 2, 2);

  // Bob twice, Carol, Bob again, then Alice: three runs of theirs, one of mine. Each waits to reach Alice first.
  const lines: [Peer, string][] = [[bob, "Morning all"], [bob, "Who is up for lunch today?"], [carol, "Me! The usual place?"], [bob, "Yes, at noon"]];
  for (const [who, text] of lines) {
    await say(who, text);
    await expect(list(alice.page).getByText(text, { exact: true })).toBeVisible({ timeout: 60_000 });
  }
  // Carol answers Bob's question and names him: the quote and the mention take Bob's colour.
  const question = list(carol.page).locator("[data-message-row]").filter({ hasText: "Who is up for lunch today?" }).last();
  await question.hover();
  await question.getByTestId("message-reply-action").click();
  const box = carol.page.getByPlaceholder("Message…");
  await box.pressSequentially("@Bo");
  await expect(carol.page.getByTestId("mention-picker").getByRole("option")).toHaveText([/^Bob…/]);
  await box.press("Enter");
  await box.pressSequentially("see you there");
  await box.press("Enter");
  await expect(list(alice.page).getByText("see you there")).toBeVisible({ timeout: 60_000 });
  await say(alice, "Count me in");

  const seen = await rows(alice.page);
  expect(seen.map((r) => `${r.name}:${r.avatar}`)).toEqual(["~Bob:spacer", "~Bob:avatar", "~Carol:avatar", "~Bob:avatar", "~Carol:avatar"]);
  const bobColour = seen[0].colour;
  await expect(list(alice.page).getByTestId("reply-quote-name")).toHaveClass(new RegExp(`\\b${bobColour}\\b`));
  await expect(list(alice.page).getByTestId("mention")).toHaveClass(new RegExp(`\\b${bobColour}\\b`));
  // A colour of each member's own, the same on every message of theirs (and never the accent a 1:1 chat's name has).
  const bobs = seen.filter((r) => r.name === "~Bob").map((r) => r.colour);
  expect(new Set(bobs).size).toBe(1);
  expect(bobs[0]).toMatch(/^text-member-\d+$/);
  expect(seen.find((r) => r.name === "~Carol")!.colour).toMatch(/^text-member-\d+$/);
  const [bobInk, carolInk, textInk] = await Promise.all([
    list(alice.page).getByTestId("message-nick").filter({ hasText: "~Bob" }).first().evaluate((el) => getComputedStyle(el).color),
    list(alice.page).getByTestId("message-nick").filter({ hasText: "~Carol" }).first().evaluate((el) => getComputedStyle(el).color),
    list(alice.page).getByTestId("message-text").first().evaluate((el) => getComputedStyle(el).color),
  ]);
  expect(bobInk).not.toBe(textInk);
  expect(carolInk).not.toBe(textInk);
  // My own message has neither a name nor a picture.
  const mine = list(alice.page).locator("[data-message-row][data-sender=me]").filter({ hasText: "Count me in" });
  await expect(mine.getByTestId("sender-avatar")).toHaveCount(0);
  await expect(mine.getByTestId("message-nick")).toHaveCount(0);

  // The pictures: 28 px at 1280, on the leading side of the bubble.
  const avatar = list(alice.page).getByTestId("sender-avatar").first();
  await expect(avatar).toBeVisible();
  expect((await avatar.boundingBox())!.width).toBeCloseTo(28, 0);
  const bubble = list(alice.page).locator("[data-message-row][data-sender=peer]").nth(1).locator("[data-message-bubble]");
  expect((await avatar.boundingBox())!.x).toBeLessThan((await bubble.boundingBox())!.x);
  await noOverflow(alice.page);

  // A tap on the picture opens the members, Bob's row marked.
  await avatar.click();
  const dialog = alice.page.getByTestId("group-members-dialog");
  await expect(dialog.locator("[data-testid=group-member][data-focused]")).toContainText("Bob");
  await alice.page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Bob writes: the header names him in his colour.
  // (Bob just sent: his app says "typing" at most a few times in 10 s, so it may take a few keys.)
  const typingName = alice.page.getByTestId("group-typing-name");
  const bobTypes = () => expect(async () => {
    await bob.page.getByPlaceholder("Message…").pressSequentially(".");
    await expect(typingName).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await bobTypes();
  await expect(typingName).toHaveText("Bob");
  await expect(typingName).toHaveClass(new RegExp(`\\b${bobColour}\\b`));

  const shots = process.env.GROUP_SENDERS_SHOTS;
  const shoot = async (name: string) => {
    if (!shots) return;
    mkdirSync(shots, { recursive: true });
    // Bob keeps typing while the picture is taken.
    await bobTypes();
    await alice.page.screenshot({ path: join(shots, `${name}.png`) });
  };
  for (const scheme of ["light", "dark"] as const) { await theme(alice.page, scheme); await shoot(`desktop-${scheme}`); }

  // A 375 px phone: smaller pictures, and still nothing wider than the screen.
  await alice.page.setViewportSize({ width: 375, height: 812 });
  await expect(list(alice.page).getByTestId("sender-avatar").first()).toBeVisible();
  await expect.poll(async () => (await list(alice.page).getByTestId("sender-avatar").first().boundingBox())?.width).toBeCloseTo(24, 0);
  await noOverflow(alice.page);
  for (const scheme of ["light", "dark"] as const) { await theme(alice.page, scheme); await shoot(`phone-${scheme}`); }

  // A 330 px chat: the pictures and their places give the room back; the colours stay.
  await alice.page.setViewportSize({ width: 330, height: 740 });
  await expect(list(alice.page).getByTestId("sender-avatar").first()).toBeHidden();
  await expect(list(alice.page).getByTestId("sender-avatar-spacer").first()).toBeHidden();
  expect(await list(alice.page).getByTestId("message-nick").filter({ hasText: "~Bob" }).first().evaluate((el) => getComputedStyle(el).color)).not.toBe(textInk);
  await noOverflow(alice.page);
  await shoot("narrow-dark");
});
