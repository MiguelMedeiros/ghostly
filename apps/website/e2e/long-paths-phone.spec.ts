import { expect, test, type Page } from "@playwright/test";

/**
 * Elements of main whose box or text ends past a phone's screen, outside a box that scrolls sideways by design (a wide
 * table). The text is measured too: a word that has nowhere to break runs out of a paragraph whose own box fits.
 */
const pastScreen = (page: Page) =>
  page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const scrolls = (el: Element) => { for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) if (/auto|scroll/.test(getComputedStyle(up).overflowX)) return true; return false; };
    const range = document.createRange();
    // Its own text only: an ancestor's whole contents would take in a scrolling table's text.
    const textRight = (el: Element) => Math.max(0, ...[...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()).map((n) => {
      range.selectNode(n);
      return range.getBoundingClientRect().right;
    }));
    return [...document.querySelectorAll("main *")].filter((el) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && Math.max(box.right, textRight(el)) > width + 0.5 && !scrolls(el);
    }).map((el) => `${el.tagName.toLowerCase()}.${el.className} ${(el.textContent ?? "").trim().slice(0, 40)}`).slice(0, 5);
  });

/**
 * A long source path (packages/browser/src/proofs/...) has nowhere to break, and on a 375 px phone it pushed the WISP
 * summary card and a roadmap candidate past the screen's edge. The page clips sideways scroll, so the text was cut off.
 */
for (const path of ["/wisps/306-bitcoin", "/roadmap"]) {
  test(`${path}: long paths wrap inside a 375 px phone`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(path);
    expect(await pastScreen(page)).toEqual([]);
  });
}

/**
 * A reader with larger text: Chrome's "Very large" default font (24 px) or the WCAG 1.4.12 text spacing. The press
 * address on /brand lost ".com.br" at the screen's edge (and pushed its card's text with it), the host names in
 * /privacy ran past it, and a WISP paragraph's slash list (GhostStory/FeatureLedger/GhostFinale) lost its end.
 */
const SPACING = "*:not(svg):not(svg *){line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}";
for (const [path, mode] of [["/brand", "font24"], ["/privacy", "font24"], ["/wisps/adapter-roadmap", "spacing"]] as const) {
  test(`${path}: long strings wrap inside a 375 px phone with ${mode === "font24" ? "a 24 px default font" : "WCAG text spacing"}`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    if (mode === "font24") {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Page.enable");
      await cdp.send("Page.setFontSizes", { fontSizes: { standard: 24, fixed: 20 } });
    }
    await page.goto(path);
    if (mode === "spacing") await page.addStyleTag({ content: SPACING });
    expect(await pastScreen(page)).toEqual([]);
  });
}

/**
 * The "On this page" list of a WISP whose headings name a source file (Cache (packages/browser/src/engine/...ts)): its
 * longest path set the width of every entry, so below 375 px they ran past the box's border and off the screen.
 */
for (const width of [320, 344, 360]) {
  test(`/wisps/public-profiles: the 'On this page' entries wrap inside their box at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/wisps/public-profiles");
    const past = await page.locator(".reader-toc").evaluate((box) => {
      const style = getComputedStyle(box);
      const inner = box.getBoundingClientRect().right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
      return [...box.querySelectorAll("li")].filter((li) => {
        const range = document.createRange();
        range.selectNodeContents(li);
        return range.getBoundingClientRect().right > inner + 0.5;
      }).map((li) => (li.textContent ?? "").trim());
    });
    expect(past).toEqual([]);
  });
}
