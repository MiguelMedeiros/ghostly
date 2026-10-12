import { expect, test } from "@playwright/test";

/**
 * A link to a section of the home (ghostly.tools/#download, the WISP documents' #dht, #agree, #alive and #space)
 * opened on a phone lands with that section under the bar. The browser goes to the section while the page is still
 * the server's markup, where every story chapter is the tall pinned film; the chapters then take their phone shape
 * and the page above the section gets shorter.
 */

const SECTIONS = ["story", "invite", "dht", "agree", "alive", "next", "space", "wallets", "identities", "open", "download"] as const;

for (const id of SECTIONS) {
  test(`/#${id} opened on a phone lands on the section`, async ({ page }) => {
    await page.goto(`/#${id}`, { waitUntil: "load" });
    await expect(page.locator("#invite.scene--phone")).toHaveCount(1);
    // Under the bar: the page's scroll padding, plus the section's own margin where it has one.
    const under = await page.evaluate(
      (id) => parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) + (parseFloat(getComputedStyle(document.getElementById(id)!).scrollMarginTop) || 0),
      id,
    );
    const top = () => page.evaluate((id) => Math.round(document.getElementById(id)!.getBoundingClientRect().top), id);
    await expect.poll(top, { timeout: 8000 }).toBeLessThanOrEqual(under + 2);
    // And it stays there: nothing moves the page again.
    await page.waitForTimeout(1500);
    expect(Math.abs((await top()) - under), `#${id} top`).toBeLessThanOrEqual(2);
  });
}

test("a reader who touches the page while it settles is left where they are", async ({ page }) => {
  await page.goto("/#download", { waitUntil: "load" });
  await expect(page.locator("#invite.scene--phone")).toHaveCount(1);
  // A finger on the glass, wherever the page is by now (a tap at a fixed point could land on a link).
  await page.evaluate(() => window.dispatchEvent(new Event("touchstart")));
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
  // The page changes height again, as it does while it starts (at its end, so the browser has nothing to hold in place).
  await page.evaluate(() => document.querySelector("main")!.append(Object.assign(document.createElement("div"), { style: "height: 300px" })));
  await page.waitForTimeout(1500);
  // Still at the top (the story's playhead may finish a beat there, a few pixels), not sent back down to the section.
  expect(await page.evaluate(() => scrollY)).toBeLessThan(page.viewportSize()!.height);
});
