import { chat, expect, test } from "../support/fixtures";
import { countCommits, openAndMeasure, seed, summary, type Open } from "../support/chatPerf";

/**
 * How long a long chat takes to open: from the click on its row in the chat list to its first message painted, and to
 * the list settled at its bottom, with the main thread's long tasks and React's commits on the way. A chat of 2,000
 * mixed messages (formatting, links with previews, pictures, voice notes, videos, replies, reactions, edits, forwards)
 * is compared with one of 50, opened in turn.
 *
 *   PERF_RUNS=5 E2E_WEB_URL=http://localhost:<port> npx playwright test -c e2e/playwright.config.ts --project web chat-open-perf
 *
 * prints the median of each number. Absolute times depend on the machine and its load: compare builds run by run
 * (interleaved), not against a number from another day. By itself the test only holds a generous bound: a chat 40
 * times longer may cost more to open, but not in proportion.
 */

const RUNS = Number(process.env.PERF_RUNS) || 3;

// A trace's DOM snapshots and a video would be measured with the app.
test.use({ trace: "off", video: "off" });

test("a long chat opens without costing in proportion to its length", { tag: ["@feature:chat.scroll"] }, async ({ peer }) => {
  test.setTimeout(5 * 60_000);
  const bob = await peer("perf-bob");
  await bob.context.addInitScript(countCommits);
  await seed(bob.page, [{ label: "Long chat", count: 2_000 }, { label: "Short chat", count: 50 }]);
  // Seeded after load: a reload hands the hook to React, and shows the chats.
  await bob.page.reload();
  await expect(bob.page.getByTestId("chat-row-name").filter({ hasText: "Long chat" })).toBeVisible();

  const home = async () => {
    await bob.page.evaluate(() => { location.hash = "/"; });
    await expect(chat(bob)).toHaveCount(0);
    // Let the page go quiet before the next click.
    await bob.page.waitForTimeout(600);
  };
  const runs: Record<string, Open[]> = { "Long chat": [], "Short chat": [] };
  // A first open of each warms the code paths (lazy chunks, the parser's grammars) and is not counted.
  for (let run = -1; run < RUNS; run++) {
    for (const label of run % 2 ? ["Long chat", "Short chat"] : ["Short chat", "Long chat"]) {
      await home();
      const open = await bob.page.evaluate(openAndMeasure, label);
      await expect(chat(bob).locator("[data-message-row]").last()).toBeInViewport();
      if (run >= 0) runs[label].push(open);
    }
  }
  const long = summary(runs["Long chat"]), short = summary(runs["Short chat"]);
  console.log(`chat-open-perf (median of ${RUNS}): ${JSON.stringify({ long, short })}`);
  for (const [label, opens] of Object.entries(runs)) console.log(`  ${label}: ${opens.map(o => JSON.stringify(o)).join("\n    ")}`);

  // Every message ends up in the page, and the view never left the bottom while the older ones came in above.
  expect(long.rows).toBe(2_000);
  expect(long.offBottom).toBe(0);
  // Generous on purpose (a loaded CI runner): 40 times the messages may not cost 40 times the time.
  expect(long.settled).toBeLessThan(Math.max(4_000, short.settled * 15));
  // A long chat shows at once: its last rows first (before, all 2,000 rows were drawn and laid out first, ~500 ms here).
  expect(long.paint).toBeLessThan(Math.max(250, short.paint * 5));
  // Open and left alone, a long chat does no long work: each change of the page used to draw all 2,000 bubbles again
  // (250 to 350 ms of long tasks every two seconds here before; none after).
  expect(long.idleLong).toBeLessThan(150);
});

test("the message list is a layer of its own, but not while a video in it plays full screen", { tag: ["@feature:chat.scroll"] }, async ({ peer }) => {
  const bob = await peer("layer-bob");
  await seed(bob.page, [{ label: "Short chat", count: 50 }]);
  await bob.page.reload();
  await bob.page.getByTestId("chat-row-name").filter({ hasText: "Short chat" }).click();
  const list = chat(bob);
  await expect(list.locator("[data-message-row]").first()).toBeAttached();
  await expect.poll(() => list.evaluate(el => getComputedStyle(el).willChange)).toBe("transform");
  // Full screen, a video is `position: fixed`: a layer would hold it inside the list.
  await list.evaluate(el => el.querySelector("[data-message-row]")!.setAttribute("data-theater", "true"));
  await expect.poll(() => list.evaluate(el => getComputedStyle(el).willChange)).toBe("auto");
});

test("scrolled up while a long chat's older messages come in, the view stays on its message", { tag: ["@feature:chat.scroll"] }, async ({ peer }) => {
  const bob = await peer("perf-scroll-bob");
  await seed(bob.page, [{ label: "Long chat", count: 2_000 }]);
  await bob.page.reload();
  // A slower processor, so the older rows are still coming in when the wheel turns, however fast the runner.
  const cdp = await bob.context.newCDPSession(bob.page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await bob.page.getByTestId("chat-row-name").filter({ hasText: "Long chat" }).click();
  // At once, before the older rows are all in: a hand scrolls up a little, and a row in the view is marked.
  const box = (await chat(bob).boundingBox())!;
  await bob.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await bob.page.mouse.wheel(0, -700);
  const marked = await chat(bob).evaluate(async el => {
    // Once the wheel's scroll has stopped.
    let was = -1;
    while (Math.abs(el.scrollTop - was) >= 1) { was = el.scrollTop; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); }
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll<HTMLElement>("[data-message-id]")].find(r => r.getBoundingClientRect().top > top + 40)!;
    return { id: row.dataset.messageId!, y: row.getBoundingClientRect().top, rows: el.querySelectorAll("[data-message-row]").length };
  });
  expect(marked.rows).toBeLessThan(2_000);
  await expect(chat(bob).locator("[data-message-row]")).toHaveCount(2_000);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  const row = chat(bob).locator(`[data-message-id="${marked.id}"]`);
  await expect.poll(async () => Math.round((await row.boundingBox())!.y)).toBeCloseTo(marked.y, -1);
  await expect(bob.page.getByTestId("jump-latest")).toHaveAttribute("data-count", "0");
});
