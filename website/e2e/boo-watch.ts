import type { Page } from "@playwright/test";

/**
 * The boo lasts well under a second, too short to catch with one assertion after another. This samples it every
 * frame from inside the page instead: install `watchBoo` before the click, read `booSeen` once it is over.
 */
export type BooSeen = {
  /** An overlay was on screen at some frame. */
  mounted: boolean;
  /** The most ghosts in it at once. */
  ghosts: number;
  /** The bubble's highest opacity, and its text. */
  said: number;
  text: string;
  /** Ms from the install to the overlay leaving the DOM (0: still there, or never came). */
  gone: number;
};

export async function watchBoo(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __boo: BooSeen & { t0: number } };
    w.__boo = { mounted: false, ghosts: 0, said: 0, text: "", gone: 0, t0: performance.now() };
    const tick = () => {
      const s = w.__boo;
      const el = document.querySelector(".boo");
      if (el) {
        s.mounted = true;
        s.gone = 0;
        s.ghosts = Math.max(s.ghosts, el.querySelectorAll("svg.ghost").length);
        const say = el.querySelector(".boo-say");
        if (say) {
          s.said = Math.max(s.said, Number(getComputedStyle(say).opacity));
          s.text = say.textContent ?? "";
        }
      } else if (s.mounted && !s.gone) s.gone = performance.now() - s.t0;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export async function booSeen(page: Page): Promise<BooSeen> {
  return page.evaluate(() => {
    const s = (window as unknown as { __boo: BooSeen }).__boo;
    return { mounted: s.mounted, ghosts: s.ghosts, said: s.said, text: s.text, gone: s.gone };
  });
}

/** Waits for a boo that has started to be over. */
export async function booOver(page: Page) {
  await page.waitForFunction(() => {
    const s = (window as unknown as { __boo?: BooSeen }).__boo;
    return !!s && s.mounted && s.gone > 0;
  });
}
