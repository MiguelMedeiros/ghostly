import { expect, test } from "../support/fixtures";

/**
 * The emoji sheet has about 1,900 emoji in one scrolling grid. Styled and laid out all at once, opening it cost about
 * 240 ms on a fast computer and over 800 ms with the processor slowed 4x, as on a phone, most of it style. Only the
 * categories near the view are drawn now (`content-visibility: auto`), and a category's icon still jumps to it.
 */
test("the emoji sheet draws only the categories near its view, and a category's icon still jumps to it", { tag: ["@feature:app.emoji-picker"] }, async ({ peer, browserName }) => {
  test.skip(browserName !== "chromium", "reads what the browser skips with checkVisibility({ contentVisibilityAuto })");
  const { page } = await peer("emoji cost", { mobile: true, viewport: { width: 390, height: 844 } });
  await page.getByTitle("New Chat").click();
  await page.getByTestId("composer-expressions").tap();
  const panel = page.getByTestId("expression-panel");
  const grid = panel.getByTestId("emoji-grid");
  await expect(grid.locator(".emoji-cell").first()).toBeVisible();

  const drawn = () => grid.evaluate((box) => {
    const cells = [...box.querySelectorAll<HTMLElement>(".emoji-cell")];
    return { all: cells.length, drawn: cells.filter((cell) => cell.checkVisibility({ contentVisibilityAuto: true })).length };
  });
  const opened = await drawn();
  expect(opened.all).toBeGreaterThan(1000);
  // What is in view, and a little around it: not every emoji there is.
  expect(opened.drawn).toBeGreaterThan(0);
  expect(opened.drawn).toBeLessThan(opened.all / 2);

  // The last category's icon puts its heading at the top of the grid, its emoji drawn.
  const last = panel.locator("[data-testid^='emoji-category-']").last();
  const id = (await last.getAttribute("data-testid"))!.replace("emoji-category-", "");
  await last.click();
  const section = grid.getByTestId(`emoji-section-${id}`);
  await expect.poll(async () => {
    const [box, heading] = [(await grid.boundingBox())!, (await section.boundingBox())!];
    return Math.abs(heading.y - box.y);
  }).toBeLessThan(2);
  await expect(section.locator(".emoji-cell").first()).toBeVisible();
  await expect(last).toHaveAttribute("data-active");

  // And back to the first.
  const first = panel.locator("[data-testid^='emoji-category-']").first();
  await first.click();
  await expect.poll(() => grid.evaluate((box) => box.scrollTop)).toBe(0);
  await expect(first).toHaveAttribute("data-active");
});
