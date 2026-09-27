import { chat, connect, expect, link, say, test, type Peer } from "../support/fixtures";

/**
 * Scrolled up in a chat, the contact's new messages do not move the view: Bob keeps reading where he was and a "↓ 3 new"
 * pill counts them, then takes him down. What Bob sends himself always goes to the bottom.
 */

const pill = (p: Peer) => p.page.getByTestId("jump-latest");
const scrollTop = (p: Peer) => chat(p).evaluate(el => el.scrollTop);
const distanceToBottom = (p: Peer) => chat(p).evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);

test("scrolled up, new messages keep the view and a pill counts them", { tag: ["@feature:chat.scroll"] }, async ({ peer }, testInfo) => {
  test.setTimeout(4 * 60_000);
  const [alice, bob] = await Promise.all([peer("scroll-alice"), peer("scroll-bob")]);
  await link(alice, bob);
  await connect(alice, bob);

  // A history taller than the view: at the bottom, each one keeps Bob there.
  for (let i = 1; i <= 10; i++) await say(alice, `Page ${i}\n${"line\n".repeat(5)}end`);
  await expect(chat(bob).getByText("Page 10", { exact: false })).toBeInViewport();
  expect(await distanceToBottom(bob)).toBeLessThan(100);
  await expect(pill(bob)).toHaveCount(0);

  // Bob scrolls to the top and reads the first page.
  await chat(bob).evaluate(el => { el.scrollTop = 0; });
  const first = chat(bob).getByText(`hello from ${alice.name}`);
  await expect(first).toBeInViewport();
  const before = (await first.boundingBox())!.y;
  await expect(pill(bob)).toHaveAttribute("data-count", "0");

  for (const text of ["New 1", "New 2", "New 3"]) await say(alice, text);
  await expect(chat(bob).getByText("New 3", { exact: true })).toBeAttached();
  await expect(pill(bob)).toHaveAttribute("data-count", "3");
  await expect(pill(bob)).toHaveAccessibleName("3 new messages, scroll to bottom");
  await expect(pill(bob)).toContainText("3 new");
  expect(await scrollTop(bob)).toBe(0);
  expect((await first.boundingBox())!.y).toBeCloseTo(before, 0);
  await expect(chat(bob).getByText("New 3", { exact: true })).not.toBeInViewport();
  await bob.page.screenshot({ path: testInfo.outputPath("new-messages-pill.png") });

  // On a phone: a round button, the count a badge on it.
  const desktop = bob.page.viewportSize()!;
  await bob.page.setViewportSize({ width: 390, height: 844 });
  await expect(pill(bob).getByTestId("jump-latest-label")).toBeHidden();
  await expect(pill(bob)).toContainText("3");
  await bob.page.screenshot({ path: testInfo.outputPath("new-messages-pill-phone.png") });
  await bob.page.setViewportSize(desktop);

  await pill(bob).click();
  await expect(chat(bob).getByText("New 3", { exact: true })).toBeInViewport();
  await expect(pill(bob)).toHaveCount(0);

  // Scrolled up again, Bob's own message takes him to the bottom.
  await chat(bob).evaluate(el => { el.scrollTop = 0; });
  await expect(pill(bob)).toBeVisible();
  await say(bob, "Found it");
  await expect(chat(bob).getByText("Found it", { exact: true })).toBeInViewport();
  await expect(pill(bob)).toHaveCount(0);
});
