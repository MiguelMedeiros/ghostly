import type { Locator, Page } from "@playwright/test";

/**
 * What the pointer passing over a deck must leave as it was: the window's scroll, every scrolled element's scroll
 * (the page's column, a composer sheet) and what has the focus. Read after two frames, so a scroll the browser makes
 * at the next layout (WebKit revealing a field focused as it mounted) is counted.
 */
export async function stillness(page: Page): Promise<{ scroll: string[]; focus: string }> {
  return page.evaluate(async () => {
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const scroll = [`window ${window.scrollX},${window.scrollY}`];
    for (const el of document.querySelectorAll<HTMLElement>("*")) {
      if (el.scrollTop || el.scrollLeft) scroll.push(`${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ""}.${String(el.className).split(" ")[0]} ${el.scrollLeft},${el.scrollTop}`);
    }
    const active = document.activeElement as HTMLElement | null;
    return { scroll, focus: active ? `${active.tagName.toLowerCase()}${active.dataset.testid ? `[${active.dataset.testid}]` : ""}` : "none" };
  });
}

/**
 * The mouse moves onto `target` as a person's would, without scrolling to it first (a locator's hover() scrolls it
 * into view): to the middle of the part of it inside the window.
 */
export async function pointAt(target: Locator): Promise<{ x: number; y: number }> {
  const page = target.page();
  const box = (await target.boundingBox())!;
  const height = page.viewportSize()!.height;
  const top = Math.max(0, box.y), bottom = Math.min(height, box.y + box.height);
  if (bottom <= top) throw new Error("the target is outside the window");
  const at = { x: box.x + box.width / 2, y: (top + bottom) / 2 };
  await page.mouse.move(at.x, at.y, { steps: 4 });
  return at;
}
