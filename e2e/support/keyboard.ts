import type { Page } from "@playwright/test";

/**
 * The iPhone's on-screen keyboard, as Safari and an installed web app show it to the page: the page keeps its
 * height and only the visual viewport gets shorter. Playwright has no such keyboard, and a smaller viewport is
 * Android's model instead (the whole page shrinks), so this puts a visual viewport the test drives in front of
 * the real one. Installed before the app starts (the page reloads); `keyboard(page, px)` then opens it that
 * tall, `keyboard(page, 0)` closes it.
 */
export async function iosKeyboard(page: Page): Promise<void> {
  await page.context().addInitScript(() => {
    const real = window.visualViewport;
    if (!real) return;
    let covered = 0;
    const events = new EventTarget();
    const fake = {
      get width() { return real.width; },
      get height() { return real.height - covered; },
      get offsetTop() { return 0; },
      get offsetLeft() { return 0; },
      get pageTop() { return real.pageTop; },
      get pageLeft() { return real.pageLeft; },
      get scale() { return real.scale; },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    };
    real.addEventListener("resize", () => events.dispatchEvent(new Event("resize")));
    Object.defineProperty(window, "visualViewport", { configurable: true, get: () => fake });
    Object.defineProperty(window, "__iosKeyboard", { configurable: true, value: (height: number, quietly: boolean) => {
      covered = height;
      if (!quietly) events.dispatchEvent(new Event("resize"));
    } });
  });
  await page.reload();
}

/**
 * Opens the keyboard `height` px tall (an iPhone's is about 336), or closes it with 0. `quietly`: with no resize the
 * page hears, as iOS does for a page in the background.
 */
export async function keyboard(page: Page, height: number, { quietly = false } = {}): Promise<void> {
  await page.evaluate(([h, q]) => (window as unknown as { __iosKeyboard(h: number, q: boolean): void }).__iosKeyboard(h, q), [height, quietly] as const);
}
