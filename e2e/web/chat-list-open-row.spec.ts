import { expect, test } from "../support/fixtures";
import { seed } from "../support/chatPerf";

/**
 * A chat opened from outside the list (here a reload) in a long list: its row, and its place on the rail, are brought
 * into view once. The person's own scroll afterwards is theirs: the list's look every few seconds leaves it there.
 */

test("after a reload the open chat's row and rail place are in view in a list of 40 chats, and stay where the person scrolls", { tag: ["@feature:chats.list.rows", "@feature:chats.list.rail"] }, async ({ peer }) => {
  const { page } = await peer("bob", { viewport: { width: 1100, height: 800 } });
  await seed(page, Array.from({ length: 40 }, (_, i) => ({ label: `Chat ${i + 1}`, count: 1, lean: true })));
  const list = page.getByTestId("chat-list");
  const rows = list.getByTestId("chat-row");
  await expect(rows).toHaveCount(40);
  // The 36th row as the list orders them: far under the window's foot.
  const far = (await rows.nth(35).getAttribute("data-chat"))!;
  await page.goto(`/#/chat/${far}`);
  await page.reload();

  const row = list.locator(`[data-chat="${far}"]`);
  await expect(page.getByPlaceholder("Message…")).toBeVisible();
  await expect(row).toBeInViewport({ ratio: 1 });

  // Scrolled back to the top by the person, the list stays there through its next looks (every 3 s).
  await list.evaluate(el => el.scrollTo({ top: 0 }));
  await page.waitForTimeout(4_000);
  expect(await list.evaluate(el => el.scrollTop)).toBe(0);

  // Folded to the rail and reloaded: the rail's place for it is in view too.
  await page.getByTestId("chat-list-toggle").click();
  await page.reload();
  await expect(page.getByTestId("chat-rail").locator(`[data-chat="${far}"]`)).toBeInViewport({ ratio: 1 });
});
