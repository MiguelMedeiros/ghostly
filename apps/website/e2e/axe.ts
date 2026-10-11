import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

/**
 * What axe finds serious or critical (WCAG 2.2, A and AA) on the page as it stands, one line per element, once the
 * one-shot animations ended: a text still fading in has no contrast to measure. `within` keeps the check to one part
 * of the page.
 */
export async function axe(page: Page, within?: string): Promise<string[]> {
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations === 1).map((a) => a.finished.catch(() => {})));
  });
  const builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
  const { violations } = await (within ? builder.include(within) : builder).analyze();
  return violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`));
}
