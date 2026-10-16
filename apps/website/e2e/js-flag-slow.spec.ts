import { expect, test } from "@playwright/test";

/**
 * The page paints once, in the layout it keeps: the head scripts (app/layout.tsx) mark <html> as having JavaScript
 * (`js`, `calm`, `data-orient`, `data-touch`) while the browser reads the head, before the first paint. On a slow
 * connection a flag queued for Next's runtime (next/script beforeInteractive, `self.__next_s`) arrived with the JS
 * chunks, seconds after the no-script layout had painted, and the page re-formed under a reader who had started
 * scrolling (CLS 1.0, the home 19,061 → 28,214 px tall). Loopback hides it: the chunks arrive before the first paint.
 */
type Probe = { jsAtFcp: boolean | null; shifts: { t: number; v: number; input: boolean }[] };

test("on a slow connection <html> has the js flag at the first paint, and a reader scrolling during the load is not moved", async ({ page, context }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    const probe: Probe = { jsAtFcp: null, shifts: [] };
    (window as unknown as { probe: Probe }).probe = probe;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === "first-contentful-paint") probe.jsAtFcp = document.documentElement.classList.contains("js");
      }
    }).observe({ type: "paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
        probe.shifts.push({ t: Math.round(entry.startTime), v: entry.value, input: entry.hadRecentInput });
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  // 1.6 Mbit/s, 150 ms: a slow phone connection.
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 200_000, uploadThroughput: 200_000 });

  const response = page.goto("/", { waitUntil: "load", timeout: 150_000 });
  await page.waitForFunction(() => (window as unknown as { probe?: Probe }).probe?.jsAtFcp != null, null, { timeout: 120_000, polling: 50 });
  // The reader starts scrolling as soon as there is something to read.
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo({ top: 2400, behavior: "instant" }));
  const html = await (await response)!.text();
  await page.waitForTimeout(2000);

  const probe = await page.evaluate(() => (window as unknown as { probe: Probe }).probe);
  expect(probe.jsAtFcp).toBe(true);
  expect(probe.shifts.filter((shift) => !shift.input)).toEqual([]);
  // Run by the browser as it parses, not queued for the runtime.
  expect(html.includes("__next_s"), "a head script queued in self.__next_s").toBe(false);
});
