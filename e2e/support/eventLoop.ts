import type { DesktopApp } from "./desktop";

/**
 * Whether a Desktop page froze: a timer in the page every 100 ms, and the longest time it went without running. A page
 * whose main thread is held (a long script, or a call into the WebView that waits on something) shows it as one gap.
 *
 * Test-only: `watchEventLoop` puts the timer in the page of an app under test through the driver; the app has no such
 * timer of its own. A reload drops it (`longestEventLoopGap` then answers null).
 */
export async function watchEventLoop(app: DesktopApp): Promise<void> {
  await app.execute(`
    if (window.__eventLoopGaps) return;
    const gaps = window.__eventLoopGaps = { longest: 0, at: 0, count: 0 };
    let last = Date.now();
    setInterval(() => {
      const now = Date.now(), gap = now - last;
      last = now;
      if (gap > 300) gaps.count++;
      if (gap > gaps.longest) { gaps.longest = gap; gaps.at = now - gap; }
    }, 100);
  `);
}

/** The longest gap since `watchEventLoop`, in ms, with when it began (ms since the epoch); null with no watch. */
export function longestEventLoopGap(app: DesktopApp): Promise<{ longest: number; at: number; count: number } | null> {
  return app.execute(`return window.__eventLoopGaps ?? null;`);
}
