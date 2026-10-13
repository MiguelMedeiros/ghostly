import { chat, expect, test } from "../support/fixtures";
import { seed } from "../support/chatPerf";

/**
 * Wheeling up a long chat on a slower processor: each time the view nears the top of the rows in the page, older rows
 * come in above and, past the window's most, rows leave below, in one commit, and the view is put back on its message.
 * That step must not freeze the page: with 100 rows in and 100 out (and 300 in the page) each step was one long task,
 * 210-250 ms here at 2x (150-175 ms on a faster machine at 4x), every 100 messages.
 *
 *   SCROLL_CPU_RATE=4 E2E_WEB_URL=http://localhost:<port> npx playwright test -c e2e/playwright.config.ts --project web chat-scroll-slow-cpu
 *
 * prints the long tasks it saw (run it alone to compare builds), and holds what a step's cost grows with: the rows it
 * brings in, the rows in the page, and the rows of those laid out and painted.
 */

test.use({ trace: "off", video: "off" });
const RATE = Number(process.env.SCROLL_CPU_RATE) || 2;
/** apps/ui/src/hooks/useRowWindow.ts `PAGE_ROWS` and `MAX_ROWS`. */
const PAGE_ROWS = 25, MAX_ROWS = 150;

test("wheeling up a long chat on a slower processor draws its older pages without a long freeze", { tag: ["@feature:chat.scroll"] }, async ({ peer }) => {
  test.setTimeout(6 * 60_000);
  const bob = await peer("slow-scroll-bob");
  await seed(bob.page, [{ label: "Long chat", count: 5_000 }]);
  await bob.page.reload();
  await bob.page.getByTestId("chat-row-name").filter({ hasText: "Long chat" }).click();
  const list = chat(bob);
  await expect(list.locator("[data-message-id=peer_r004999ab]")).toBeInViewport();
  const box = (await list.boundingBox())!;
  await bob.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // The pictures and previews of the first screens loaded, the page quiet.
  await bob.page.waitForTimeout(1_000);
  await list.evaluate(el => {
    const w = window as unknown as { __long: number[]; __added: number[]; __most: number };
    w.__long = []; w.__added = []; w.__most = 0;
    new PerformanceObserver(list => { for (const e of list.getEntries()) w.__long.push(e.duration); }).observe({ type: "longtask" });
    // The rows each commit brings into the page, and the most in it at once.
    const rows = (n: Node) => n instanceof HTMLElement ? (n.matches("[data-message-id]") ? 1 : 0) + n.querySelectorAll("[data-message-id]").length : 0;
    new MutationObserver(records => {
      const added = records.reduce((sum, r) => sum + [...r.addedNodes].reduce((s, n) => s + rows(n), 0), 0);
      if (added) w.__added.push(added);
      w.__most = Math.max(w.__most, el.querySelectorAll("[data-message-id]").length);
    }).observe(el, { childList: true, subtree: true });
  });
  const first = () => list.evaluate(el => el.querySelector<HTMLElement>("[data-message-id]")!.dataset.messageId!);
  const cdp = await bob.context.newCDPSession(bob.page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: RATE });
  // A wheel, a notch every 50 ms: about ten pages of the old size.
  for (let i = 0; i < 300; i++) {
    await bob.page.mouse.wheel(0, -400);
    await bob.page.waitForTimeout(50);
  }
  await bob.page.waitForTimeout(1_000);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  const { long, added, most } = await bob.page.evaluate(() => {
    const w = window as unknown as { __long: number[]; __added: number[]; __most: number };
    return { long: w.__long, added: w.__added, most: w.__most };
  });
  const max = Math.max(0, ...long), total = long.reduce((a, b) => a + b, 0);
  const row = Number((await first()).replace(/\D/g, ""));
  console.log(`chat-scroll-slow-cpu: ${JSON.stringify({ rate: RATE, longTasks: long.length, longMax: Math.round(max), longTotal: Math.round(total), over100: long.filter(d => d > 100).length, firstRow: row, pages: added.length, mostAdded: Math.max(0, ...added), mostInPage: most })}`);
  // It went far up the history, page after page, each a small one, and the page never held many rows: what a step costs
  // (its commit, the layout and the paint of every row in the page) grows with both. The times above depend on the
  // machine and its load (another worker's test doubles them): printed, not held.
  expect(row).toBeLessThan(4_800);
  expect(added.length).toBeGreaterThan(10);
  expect(Math.max(...added), "rows a step brings in").toBeLessThanOrEqual(PAGE_ROWS);
  expect(most, "rows in the page at once").toBeLessThanOrEqual(MAX_ROWS);
  // And of the rows in the page, only those on screen and near it are laid out and painted: with all 150 drawn, each
  // step was still a long task at 4x. A row on screen is drawn, most of the others are not.
  const drawn = await list.evaluate(el => {
    const view = el.getBoundingClientRect();
    const rows = [...el.querySelectorAll<HTMLElement>("[data-message-row]")].map(row => {
      const box = row.getBoundingClientRect();
      const inside = row.querySelector("*");
      return { onScreen: box.bottom > view.top && box.top < view.bottom, drawn: !inside || inside.checkVisibility({ contentVisibilityAuto: true }) };
    });
    return { rows: rows.length, drawn: rows.filter(r => r.drawn).length, onScreenSkipped: rows.filter(r => r.onScreen && !r.drawn).length };
  });
  console.log(`chat-scroll-slow-cpu drawn: ${JSON.stringify(drawn)}`);
  expect(drawn.onScreenSkipped, "rows on screen left undrawn").toBe(0);
  expect(drawn.drawn, "rows laid out and painted").toBeLessThan(drawn.rows / 2);
});
