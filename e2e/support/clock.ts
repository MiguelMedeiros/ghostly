import type { BrowserContext } from "@playwright/test";

/**
 * Gives every page of a context a clock that is off: `Date.now()` and `new Date()` read `offset` ms ahead (or behind,
 * when negative) from the first script on, as on a device whose clock is wrong. The engine runs in the page, so the
 * peer dates everything it publishes and sends by that clock, and judges what it reads by it. A test can move it later
 * through `globalThis.clockOffset`. Timers are left alone: nothing waits longer or shorter.
 */
export async function skewClock(context: BrowserContext, offset: number): Promise<void> {
  await context.addInitScript((initial: number) => {
    const scope = globalThis as { clockOffset?: number; Date: DateConstructor };
    scope.clockOffset = initial;
    const Real = Date;
    const now = () => Real.now() + (scope.clockOffset ?? 0);
    class Shifted extends Real {
      constructor(...args: unknown[]) {
        if (args.length) super(...(args as [number]));
        else super(now());
      }
      static now(): number { return now(); }
    }
    scope.Date = Shifted as unknown as DateConstructor;
  }, offset);
}
