import { expect, test, type Page } from "@playwright/test";

/**
 * The reader's sidebar: one accordion per group of drafts. Only the group of the draft being read starts open,
 * each group opens and closes on its own, the visitor's choice survives a reload, a closed group's links stay in
 * the page but out of the tab order, and the whole thing works from the keyboard and at phone width.
 */

const DRAFT = "/developers/wisps/203-lightning";

const group = (page: Page, id: string) => page.locator(`.reader-all-group[data-group="${id}"]`);
const head = (page: Page, id: string) => group(page, id).locator(".reader-group-head");
const openGroups = (page: Page) =>
  page.locator('.reader-group-head[aria-expanded="true"]').evaluateAll((els) => els.map((el) => el.closest<HTMLElement>("[data-group]")!.dataset.group));

async function currentGroup(page: Page) {
  return page.locator('.reader-all a[aria-current="page"]').evaluate((a) => a.closest<HTMLElement>("[data-group]")!.dataset.group!);
}

test("reader groups: only the current draft's group starts open, with the draft in sight", async ({ page }) => {
  await page.goto(DRAFT);
  const mine = await currentGroup(page);
  expect(await openGroups(page)).toEqual([mine]);

  const current = page.locator('.reader-all a[aria-current="page"]');
  await expect(current).toBeVisible();
  await expect(current).toContainText("203");
  await expect(current).toBeInViewport();

  // Name and count on every header, each pointing at its own panel.
  const heads = page.locator(".reader-group-head");
  const n = await heads.count();
  expect(n).toBeGreaterThan(5);
  for (let i = 0; i < n; i++) {
    const panel = await heads.nth(i).getAttribute("aria-controls");
    const links = await page.locator(`#${panel} a`).count();
    await expect(heads.nth(i).locator(".reader-group-count")).toHaveText(String(links));
  }

  // Closed groups keep their links in the page, hidden and not focusable.
  const closed = group(page, "meet").locator("a").first();
  await expect(closed).toBeAttached();
  await expect(closed).toBeHidden();
  expect(await closed.evaluate((a: HTMLElement) => (a.focus(), document.activeElement === a))).toBe(false);
});

test("reader groups: each group opens and closes on its own, and the choice survives a reload", async ({ page }) => {
  await page.goto(DRAFT);
  const mine = await currentGroup(page);

  await head(page, "meet").click();
  await expect(head(page, "meet")).toHaveAttribute("aria-expanded", "true");
  await expect(head(page, mine)).toHaveAttribute("aria-expanded", "true");
  await expect(group(page, "meet").locator("a").first()).toBeVisible();

  await head(page, "connect").click();
  await head(page, "meet").click();
  await expect(head(page, "meet")).toHaveAttribute("aria-expanded", "false");
  await expect(head(page, "connect")).toHaveAttribute("aria-expanded", "true");
  await expect(group(page, "meet").locator("a").first()).toBeHidden();

  // The current group can be closed too, while this draft is read.
  await head(page, mine).click();
  await expect(head(page, mine)).toHaveAttribute("aria-expanded", "false");

  await page.reload();
  await expect(head(page, "connect")).toHaveAttribute("aria-expanded", "true");
  await expect(head(page, "meet")).toHaveAttribute("aria-expanded", "false");
  // On arrival the current draft's group is open again, whatever was stored.
  await expect(head(page, mine)).toHaveAttribute("aria-expanded", "true");

  // Another draft: its own group opens, the remembered one stays.
  await group(page, "connect").locator("a").first().click();
  await expect(page.locator('.reader-all-group[data-group="connect"] a[aria-current="page"]')).toBeVisible();
  await expect(head(page, mine)).toHaveAttribute("aria-expanded", "false");
});

test("reader groups: expand all, collapse all", async ({ page }) => {
  await page.goto(DRAFT);
  const all = page.getByTestId("reader-groups-all");
  await expect(all).toHaveText("Expand all");
  await all.click();
  await expect(page.locator('.reader-group-head[aria-expanded="false"]')).toHaveCount(0);
  await expect(all).toHaveText("Collapse all");
  await all.click();
  await expect(page.locator('.reader-group-head[aria-expanded="true"]')).toHaveCount(0);
});

test("reader groups: from the keyboard", async ({ page }) => {
  await page.goto(DRAFT);
  await head(page, "meet").focus();
  await page.keyboard.press("Enter");
  await expect(head(page, "meet")).toHaveAttribute("aria-expanded", "true");
  // Tab goes into the open group's links.
  await page.keyboard.press("Tab");
  await expect(group(page, "meet").locator("a").first()).toBeFocused();

  await head(page, "meet").focus();
  await page.keyboard.press("Space");
  await expect(head(page, "meet")).toHaveAttribute("aria-expanded", "false");
  // Closed (once the closing has played): Tab skips its links and lands on the next header.
  await expect(group(page, "meet").locator("a").first()).toBeHidden();
  await page.keyboard.press("Tab");
  await expect(head(page, "connect")).toBeFocused();
});

test("reader groups: work without storage", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("refused", "SecurityError");
      },
    });
  });
  await page.goto(DRAFT);
  const mine = await currentGroup(page);
  expect(await openGroups(page)).toEqual([mine]);
  await head(page, "meet").click();
  await expect(head(page, "meet")).toHaveAttribute("aria-expanded", "true");
});

test("reader groups: reduced motion opens without a transition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(DRAFT);
  const panel = group(page, "meet").locator(".reader-group-panel");
  const durations = await panel.evaluate((el) => getComputedStyle(el).transitionDuration.split(",").map((d) => parseFloat(d)));
  for (const seconds of durations) expect(seconds).toBeLessThan(0.01);
  await head(page, "meet").click();
  await expect(group(page, "meet").locator("a").first()).toBeVisible();
});

test.describe(() => {
  test.use({ javaScriptEnabled: false });
  test("reader groups: without scripts every link is in the page and shown", async ({ page }) => {
    await page.goto(DRAFT);
    const links = page.locator(".reader-all a");
    expect(await links.count()).toBeGreaterThan(30);
    await expect(links.first()).toBeVisible();
    await expect(links.last()).toBeVisible();
  });
});

test.describe(() => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test("reader groups: at phone width", async ({ page }) => {
    await page.goto(DRAFT);
    const mine = await currentGroup(page);
    expect(await openGroups(page)).toEqual([mine]);
    // The list sits under the article there: arriving does not move the page down to it.
    expect(await page.evaluate(() => scrollY)).toBe(0);
    await head(page, "meet").tap();
    await expect(group(page, "meet").locator("a").first()).toBeVisible();
    await expect(head(page, mine)).toHaveAttribute("aria-expanded", "true");
    expect((await head(page, "meet").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
});
