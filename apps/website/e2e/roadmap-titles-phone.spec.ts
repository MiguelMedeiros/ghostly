import { expect, test } from "@playwright/test";

/**
 * The roadmap's candidates with a larger browser text size on a 375 px phone (150%: 24 px, 200%: 32 px; WCAG 1.4.4).
 * A title with nowhere to break (Voice/video/screenshare) set the width of its column, so it ran past the screen's
 * edge and was drawn over its status (Available). Each title must end inside its own column, before the status.
 */
for (const standard of [24, 32]) {
  test(`/roadmap: candidate titles wrap inside their column on a 375 px phone with a ${standard} px default font`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Page.enable");
    await cdp.send("Page.setFontSizes", { fontSizes: { standard, fixed: Math.round(standard * 0.8125) } });
    await page.goto("/roadmap");
    await page.getByTestId("inventory-toggle-all").click();
    await expect(page.locator("details.rm-cat").first()).toHaveAttribute("open", "");

    const rows = await page.locator(".rm-cat > ul > li > details > summary").evaluateAll((summaries) =>
      summaries.map((summary) => {
        const head = summary.querySelector(".rm-cand-head")!;
        const title = head.querySelector(".rm-cand-title")!;
        const status = summary.querySelector(".level")!;
        const range = document.createRange();
        range.selectNodeContents(title);
        const style = getComputedStyle(summary);
        return {
          title: (title.textContent ?? "").trim(),
          text: range.getBoundingClientRect().right,
          head: head.getBoundingClientRect().right,
          status: status.getBoundingClientRect().left,
          inner: summary.getBoundingClientRect().right - parseFloat(style.paddingRight),
          screen: document.documentElement.clientWidth,
        };
      }),
    );
    expect(rows.map((r) => r.title)).toContain("Voice/video/screenshare");
    const past = rows
      .filter((r) => r.text > r.head + 0.5 || r.head > r.status + 0.5 || r.text > r.inner + 0.5 || r.text > r.screen + 0.5)
      .map((r) => `${r.title}: ends at ${Math.round(r.text)}, column ${Math.round(r.head)}, status at ${Math.round(r.status)}`);
    expect(past).toEqual([]);
  });
}
