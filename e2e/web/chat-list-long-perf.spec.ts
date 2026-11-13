import { expect, test } from "../support/fixtures";
import { countCommits, median, seed } from "../support/chatPerf";

/**
 * A chat list of 300 chats: every row is in the page, and the browser draws only those near the list's view
 * (apps/ui/src/index.css `.chat-list-row`, `content-visibility: auto`). So a scroll of the list costs no script (no React
 * commit, no row put in or taken out of the page), and a Light/Dark switch restyles only the rows near the view. A list
 * that drew only the rows near its view in script re-drew the list at every row scrolled: 4-10 times the scroll's main
 * thread of the list drawn whole, at 300 chats.
 *
 *   E2E_WEB_URL=http://localhost:<port> npx playwright test -c e2e/playwright.config.ts --project web chat-list-long-perf
 *
 * prints what it measured. The switch's bound is a share of the same switch with every row drawn, in the same page: in
 * milliseconds it failed on a loaded host (51 ms over 40 at a load of 10-12 on 4 cores) with nothing in the app slower.
 * The list drawn whole paid ~95-130 ms of style and layout per switch at 300 chats on a quiet desktop, the app ~30-50 ms.
 */

const CHATS = 300;
/**
 * Most a Light/Dark switch may take, style and layout, as a share of the same switch with every row drawn. Measured
 * 0.23-0.40 on a quiet desktop, at a load of ~11 on 4 cores and under a 50% CPU quota alike; with content-visibility
 * taken off the rows (every row drawn, as before it), 0.86-1.3.
 */
const SWITCH_SHARE = 0.5;

// A trace's DOM snapshots and a video would be measured with the app.
test.use({ trace: "off", video: "off" });

test("a list of 300 chats keeps every row in the page, scrolls with no React commit, and switches Light/Dark cheaply", { tag: ["@feature:chats.list.rows"] }, async ({ peer }) => {
  test.setTimeout(3 * 60_000);
  const bob = await peer("long-list-bob", { viewport: { width: 1280, height: 800 } });
  await bob.context.addInitScript(countCommits);
  await seed(bob.page, Array.from({ length: CHATS }, (_, i) => ({ label: `Chat ${i + 1}`, count: 1, lean: true })));
  // Seeded after load: a reload hands the hook to React, and shows the chats.
  await bob.page.reload();
  const list = bob.page.getByTestId("chat-list");
  await expect(list.getByTestId("chat-row")).toHaveCount(CHATS);
  // The page quiet: the chats read, their faces drawn.
  await bob.page.waitForTimeout(1_500);

  // Most rows are left to the browser: in the page, not drawn.
  const skipped = await list.evaluate(el => [...el.querySelectorAll<HTMLElement>("[data-testid=chat-row]")]
    .filter(row => !row.querySelector("*")!.checkVisibility({ contentVisibilityAuto: true })).length);
  expect(skipped, "rows in the page the browser skips").toBeGreaterThan(CHATS / 2);

  // The page's own commits while nothing happens (the engine's state, the clock), over as long as the scroll takes.
  const watch = () => list.evaluate(el => {
    const w = window as unknown as { __ghostlyCommits: number; __rows: number; __from: number; __watch?: MutationObserver };
    w.__watch?.disconnect();
    w.__rows = 0;
    w.__from = w.__ghostlyCommits;
    const rows = (n: Node) => n instanceof HTMLElement ? (n.matches("[data-testid=chat-row]") ? 1 : 0) + n.querySelectorAll("[data-testid=chat-row]").length : 0;
    w.__watch = new MutationObserver(records => {
      for (const r of records) w.__rows += [...r.addedNodes, ...r.removedNodes].reduce((s, n) => s + rows(n), 0);
    });
    w.__watch.observe(el, { childList: true, subtree: true });
  });
  const read = () => bob.page.evaluate(() => {
    const w = window as unknown as { __ghostlyCommits: number; __rows: number; __from: number };
    return { commits: w.__ghostlyCommits - w.__from, rows: w.__rows };
  });
  const NOTCHES = 40, GAP = 50;
  await watch();
  await bob.page.waitForTimeout(NOTCHES * GAP);
  const idle = await read();

  // A wheel down the list, a notch every 50 ms.
  const box = (await list.boundingBox())!;
  await bob.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await watch();
  for (let i = 0; i < NOTCHES; i++) {
    await bob.page.mouse.wheel(0, 400);
    await bob.page.waitForTimeout(GAP);
  }
  const scroll = await read();
  const top = await list.evaluate(el => el.scrollTop);
  console.log(`chat-list-long-perf scroll: ${JSON.stringify({ skipped, idle, scroll, top })}`);
  expect(top, "the wheel scrolled the list").toBeGreaterThan(4_000);
  expect(scroll.rows, "chat rows put in or taken out of the page by the scroll").toBe(0);
  // The scroll's own commits: none (a couple of the page's own at most, as while idle).
  expect(scroll.commits, "React commits during the scroll").toBeLessThanOrEqual(idle.commits + 2);
  await expect(list.getByTestId("chat-row")).toHaveCount(CHATS);

  // Light/Dark: the style and layout of each switch, forced at once and timed. Each as the app draws the list, then the
  // same switch with every row drawn (the list before content-visibility), in turns: a host busy with other work slows
  // both alike, so their ratio holds where a bound in milliseconds failed on a loaded runner.
  const switches = await bob.page.evaluate(async () => {
    const html = document.documentElement;
    const layout = () => void document.body.getBoundingClientRect();
    // Two frames: a row's content-visibility changes take effect at a frame, not at a forced layout.
    const frame = () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
    const whole = document.createElement("style");
    whole.textContent = ".chat-list-row { content-visibility: visible !important; }";
    const time = () => {
      const t0 = performance.now();
      html.setAttribute("data-theme", html.getAttribute("data-theme") === "light" ? "dark" : "light");
      void getComputedStyle(document.body).color;
      layout();
      return performance.now() - t0;
    };
    const measure = async (all: boolean) => {
      if (all) document.head.append(whole);
      else whole.remove();
      layout();
      await frame();
      return time();
    };
    const app: number[] = [], drawn: number[] = [];
    // Eight of each, in the order app, drawn, drawn, app, …: each one switched both ways (to Light and to Dark, which cost
    // differently) four times.
    for (let i = 0; i < 8; i++) {
      for (const all of i % 2 ? [true, false] : [false, true]) (all ? drawn : app).push(await measure(all));
    }
    whole.remove();
    const round = (times: number[]) => times.map(t => Math.round(t * 10) / 10);
    return { app: round(app), drawn: round(drawn) };
  });
  // Each switch over its twin with every row drawn, measured just before or after it: the two met the same load. What a
  // busy host adds lands on a few switches at random, so the median of the eight.
  const ratio = median(switches.app.map((t, i) => t / switches.drawn[i]));
  console.log(`chat-list-long-perf Light/Dark (ms): ${JSON.stringify({ ...switches, ratio: Math.round(ratio * 100) / 100 })}`);
  expect(ratio, "median Light/Dark switch, style and layout, over the same switch with every row drawn").toBeLessThan(SWITCH_SHARE);
});
