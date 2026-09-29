import type { Page } from "@playwright/test";

/**
 * Measuring the composer while typing (web/composer-typing-perf.spec.ts): each keystroke's latency, from its keydown
 * to the frame after it is painted, and what React drew for it (commits, and how many message rows rendered).
 */

export interface Typing {
  /** Keystrokes measured. */
  keys: number;
  /** Keydown to the next frame painted, in ms: median, 95th percentile and the longest. */
  median: number;
  p95: number;
  max: number;
  /** Keystrokes over 50 ms (a frame and a half at 30 fps: felt as lag). */
  slow: number;
  /** React commits per keystroke. */
  commits: number;
  /** Message rows (a bubble, drawn again) per keystroke, when rows are counted. */
  rows: number;
  /** Changes of the field's `style` attribute (its height) over the whole run: each one lays the chat out again. */
  heightWrites: number;
}

/**
 * React calls the DevTools hook on each commit, in a production build too. With `__ghostlyCountRows` set, each commit
 * also counts the message bubbles that rendered in it: fibers React worked on this commit (a fiber not current at the
 * previous commit, with PerformedWork) whose props carry the bubble's `message` and `names`.
 */
export function instrumentTyping() {
  type Fiber = { child: Fiber | null; sibling: Fiber | null; flags: number; memoizedProps: unknown; type: unknown };
  const w = window as unknown as {
    __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown; __ghostlyCommits: number; __ghostlyRows: number; __ghostlyCountRows: boolean;
    __ghostlyKeys: number[]; __ghostlyMeasure: boolean;
  };
  w.__ghostlyCommits = 0;
  w.__ghostlyRows = 0;
  w.__ghostlyCountRows = false;
  w.__ghostlyKeys = [];
  w.__ghostlyMeasure = false;
  let previous: WeakSet<Fiber> | null = null;
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(), supportsFiber: true, isDisabled: false,
    inject: () => 1, checkDCE: () => {}, onScheduleFiberRoot: () => {}, onCommitFiberUnmount: () => {}, onPostCommitFiberRoot: () => {},
    onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
      w.__ghostlyCommits++;
      // Off, the fibers seen are forgotten: the first commit counted again only learns which ones are current.
      if (!w.__ghostlyCountRows) { previous = null; return; }
      const seen = new WeakSet<Fiber>();
      const stack: Fiber[] = [root.current];
      while (stack.length) {
        const fiber = stack.pop()!;
        seen.add(fiber);
        const props = fiber.memoizedProps as { message?: { id?: unknown }; names?: unknown } | null;
        // PerformedWork is 1; a fiber current at the last commit and here again was not touched.
        if (previous && (fiber.flags & 1) && !previous.has(fiber) && typeof fiber.type === "function" && props && typeof props === "object"
          && props.message && typeof props.message === "object" && typeof props.names === "string") w.__ghostlyRows++;
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
      }
      previous = seen;
    },
  };
  // Each keystroke: keydown to the frame after it, once painted (a message posted from the frame runs after the paint).
  document.addEventListener("keydown", () => {
    if (!w.__ghostlyMeasure) return;
    const t0 = performance.now();
    requestAnimationFrame(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => w.__ghostlyKeys.push(performance.now() - t0);
      channel.port2.postMessage(0);
    });
  }, true);
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};

/** Types `text` into the composer, a key every `delayMs`, and measures it (see `Typing`). */
export async function typeAndMeasure(page: Page, text: string, { delayMs = 40, countRows = false } = {}): Promise<Typing> {
  const box = page.getByPlaceholder("Message…");
  await box.click();
  await box.fill("");
  await page.waitForTimeout(300);
  const before = await page.evaluate((countRows) => {
    const w = window as unknown as { __ghostlyCommits: number; __ghostlyRows: number; __ghostlyCountRows: boolean; __ghostlyKeys: number[]; __ghostlyMeasure: boolean };
    w.__ghostlyKeys = [];
    w.__ghostlyRows = 0;
    w.__ghostlyCountRows = countRows;
    w.__ghostlyMeasure = true;
    return w.__ghostlyCommits;
  }, countRows);
  const writes = await box.evaluateHandle((field) => {
    const seen = { n: 0 };
    new MutationObserver(records => { seen.n += records.length; }).observe(field, { attributes: true, attributeFilter: ["style"] });
    return seen;
  });
  await box.pressSequentially(text, { delay: delayMs });
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => {
    const w = window as unknown as { __ghostlyCommits: number; __ghostlyRows: number; __ghostlyCountRows: boolean; __ghostlyKeys: number[]; __ghostlyMeasure: boolean };
    w.__ghostlyMeasure = false;
    w.__ghostlyCountRows = false;
    return { commits: w.__ghostlyCommits, rows: w.__ghostlyRows, keys: w.__ghostlyKeys };
  });
  const heightWrites = await writes.evaluate(seen => seen.n);
  const keys = after.keys;
  return {
    keys: keys.length,
    median: Math.round(percentile(keys, 0.5) * 10) / 10,
    p95: Math.round(percentile(keys, 0.95) * 10) / 10,
    max: Math.round(Math.max(0, ...keys)),
    slow: keys.filter(k => k > 50).length,
    commits: Math.round(((after.commits - before) / text.length) * 100) / 100,
    rows: Math.round((after.rows / text.length) * 100) / 100,
    heightWrites,
  };
}
