import type { Page } from "@playwright/test";

/**
 * What a page still does when nobody touches it: the animations that never end, the animation frames its code asks
 * for, and the timers that fire. An idle window should draw nothing: on Linux (WebKitGTK) every frame is composited by
 * the app's main thread, so a one-second decoration that loops is a core kept busy for as long as the app is open.
 *
 * `installIdleProbe` goes in with `context.addInitScript` (before the app's code, so its timers are the wrapped ones);
 * `watchIdle` then counts over a window of time. Workers have timers of their own and are not counted: they draw nothing.
 */
export interface IdleReport {
  seconds: number;
  /** Animations running at the end of the window that never end by themselves (CSS `infinite`, Web Animations). */
  endless: string[];
  /** Every animation running at the end of the window, endless or not. */
  running: string[];
  /** Animation-frame callbacks the page's code ran, per second, and the callbacks that asked for them. */
  framesPerSecond: number;
  frameSites: Record<string, number>;
  /** Timer callbacks (intervals and timeouts) run per second. */
  timersPerSecond: number;
  /** How often each callback ran, by "<interval|timeout> <delay> ms: <the callback's text>". */
  timerSites: Record<string, number>;
  /** Intervals alive at the end of the window that fire more than once a second: "<delay> ms: <callback>". */
  fastIntervals: string[];
  /** The callbacks that ran most, most first: "<runs>x <site>". */
  busiest: string[];
}

interface Probe {
  frames: Record<string, number>;
  timers: Record<string, number>;
  intervals: Map<number, { delay: number; site: string }>;
}

export function installIdleProbe(): void {
  const w = window as unknown as { __ghostlyIdle?: Probe };
  if (w.__ghostlyIdle) return;
  const probe: Probe = { frames: {}, timers: {}, intervals: new Map() };
  w.__ghostlyIdle = probe;
  // A callback's own text says where it is from, in a minified build too (a stack there is one file and a column).
  const site = (fn: unknown) => typeof fn === "function" ? (fn.name ? `${fn.name}: ` : "") + String(fn).replace(/\s+/g, " ").slice(0, 90) : String(fn).slice(0, 90);
  const count = (into: Record<string, number>, key: string) => { into[key] = (into[key] ?? 0) + 1; };

  const frame = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => {
    const from = site(callback);
    return frame((time) => { count(probe.frames, from); callback(time); });
  };

  const every = window.setInterval.bind(window), stop = window.clearInterval.bind(window);
  const later = window.setTimeout.bind(window);
  type Timer = (handler: TimerHandler, delay?: number, ...args: unknown[]) => number;
  (window as unknown as { setInterval: Timer }).setInterval = (handler, delay = 0, ...args) => {
    if (typeof handler !== "function") return every(handler, delay, ...args);
    const from = site(handler);
    const id = every((...given: unknown[]) => { count(probe.timers, `interval ${delay} ms: ${from}`); (handler as (...a: unknown[]) => void)(...given); }, delay, ...args);
    probe.intervals.set(id, { delay, site: from });
    return id;
  };
  window.clearInterval = (id) => { if (id !== undefined) probe.intervals.delete(id as number); stop(id); };
  (window as unknown as { setTimeout: Timer }).setTimeout = (handler, delay = 0, ...args) => {
    if (typeof handler !== "function") return later(handler, delay, ...args);
    const from = site(handler);
    return later((...given: unknown[]) => { count(probe.timers, `timeout ${delay} ms: ${from}`); (handler as (...a: unknown[]) => void)(...given); }, delay, ...args);
  };
}

/**
 * The animations running now on elements that are drawn, as "<name> on <element>": all of them, or only those that
 * never end by themselves. An element inside content the browser skips (the connection panel is a closed <details>,
 * and holds a pairing glyph of its own) draws nothing, and its style is not kept up to date while it is skipped: on a
 * slow machine it keeps the animation of the stage it was first styled in, "running", whatever the page says since
 * (the pause while the window is away, the stage that changed). It costs no frame, so it is not counted.
 */
export function runningAnimations(page: Page, only: "all" | "endless" = "all"): Promise<string[]> {
  return page.evaluate((only) => document.getAnimations()
    .filter(a => a.playState === "running" && (only === "all" || a.effect?.getComputedTiming().endTime === Infinity))
    .filter(a => ((a.effect as KeyframeEffect | null)?.target as Element | null)?.checkVisibility?.() !== false)
    .map((animation) => {
      const target = (animation.effect as KeyframeEffect | null)?.target as HTMLElement | SVGElement | null;
      const where = target ? `${target.tagName.toLowerCase()}${target.dataset?.testid ? `[${target.dataset.testid}]` : ""}.${String(target.getAttribute("class") ?? "").split(" ").filter(Boolean).slice(0, 3).join(".")}` : "?";
      return `${(animation as CSSAnimation).animationName ?? (animation as CSSTransition).transitionProperty ?? (animation.id || "animation")} on ${where}`;
    }), only);
}

/** Counts what the page does by itself for `seconds`, without touching it. */
export async function watchIdle(page: Page, seconds: number): Promise<IdleReport> {
  await page.evaluate(() => { const probe = (window as unknown as { __ghostlyIdle: Probe }).__ghostlyIdle; probe.frames = {}; probe.timers = {}; });
  await page.waitForTimeout(seconds * 1000);
  const counted = await page.evaluate(() => {
    const probe = (window as unknown as { __ghostlyIdle: Probe }).__ghostlyIdle;
    return { frames: probe.frames, timers: probe.timers, intervals: [...probe.intervals.values()] };
  });
  const sum = (of: Record<string, number>) => Object.values(of).reduce((a, b) => a + b, 0);
  return {
    seconds,
    endless: await runningAnimations(page, "endless"), running: await runningAnimations(page),
    framesPerSecond: sum(counted.frames) / seconds, frameSites: counted.frames,
    timersPerSecond: sum(counted.timers) / seconds, timerSites: counted.timers,
    fastIntervals: counted.intervals.filter(i => i.delay < 1000).map(i => `${i.delay} ms: ${i.site}`),
    busiest: Object.entries(counted.timers).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([from, runs]) => `${runs}x ${from}`),
  };
}
