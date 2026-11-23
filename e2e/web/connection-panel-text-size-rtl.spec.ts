import type { Page } from "@playwright/test";
import { connect, expect, link, test } from "../support/fixtures";

/**
 * A chat's Connection options on a 375 px phone at 200% of the browser's text size. The transport rows sit in a
 * <fieldset>, which is never narrower than its content by default: the WebRTC row's "In use · 34 ms" mark, one line and
 * long in Arabic, made every row 391 px wide in a ~311 px panel. In RTL the rest went off the panel's left edge, which
 * cuts it: no transport's radio was on screen, and Fallback's switch sat at x = -37..3. Kept to the panel's width, the
 * name keeps its room and the mark goes onto a second line: in English "WebRTC" stays whole, not "W…".
 */
const PHONE = { width: 375, height: 667 };

/** The browser's default text size, as its settings set it (rem follows it). */
async function textSize(page: Page, px: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.setFontSizes", { fontSizes: { standard: px, fixed: Math.round(px * 13 / 16) } });
  await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(px);
}

test("on a 375px phone at 200% text size, Connection options keep every transport's radio and Fallback inside the panel, in Arabic and English", { tag: ["@feature:app.mobile-layout", "@feature:chat.paired.status", "@feature:transport.chat-switch"] }, async ({ peer }) => {
  const alice = await peer("alice");
  const bob = await peer("bob", { mobile: true, viewport: PHONE });
  await link(alice, bob);
  await connect(alice, bob);
  const page = bob.page;
  await textSize(page, 32);
  for (const [language, title] of [["ar", "خيارات الاتصال"], ["en", "Connection options"]] as const) {
    await page.evaluate((language) => {
      const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
      localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
    }, language);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", new RegExp(`^${language}`));
    await expect(page.getByTestId("connection-options")).toHaveAttribute("data-state", "connected", { timeout: 90_000 });
    await page.getByTestId("connection-options").click();
    const panel = page.getByRole("dialog", { name: title });
    await expect(panel.locator("[data-in-use]")).toBeVisible();

    const { box, parts } = await panel.evaluate((el) => {
      const edge = el.getBoundingClientRect();
      // Each row, its radio (the last box in the row) and Fallback's switch.
      const rows = [...el.querySelectorAll<HTMLElement>('[role="radio"]')];
      const radios = rows.map((row) => row.lastElementChild as HTMLElement);
      const toggle = el.querySelector<HTMLElement>('[role="switch"]')!;
      const of = (name: string, node: HTMLElement) => { const r = node.getBoundingClientRect(); return { name, left: r.left, right: r.right }; };
      return {
        box: { left: edge.left, right: edge.right },
        parts: [...rows.map((row) => of(row.getAttribute("aria-label")!, row)), ...radios.map((radio, i) => of(`${rows[i].getAttribute("aria-label")} radio`, radio)), of("Fallback", toggle)],
      };
    });
    expect(parts.length, language).toBeGreaterThanOrEqual(5);
    for (const part of parts) {
      expect.soft(part.left, `${language} ${part.name}: ${JSON.stringify(part)} in ${JSON.stringify(box)}`).toBeGreaterThanOrEqual(box.left);
      expect.soft(part.right, `${language} ${part.name}: ${JSON.stringify(part)} in ${JSON.stringify(box)}`).toBeLessThanOrEqual(box.right);
    }
    if (language === "en") {
      const name = panel.locator("[data-in-use] .truncate");
      expect(await name.evaluate((el) => el.scrollWidth - el.clientWidth), "English: the in-use row's name cut-off width").toBeLessThanOrEqual(0);
    }
    await page.keyboard.press("Escape");
  }
});
