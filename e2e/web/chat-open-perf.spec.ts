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

  // Generous on purpose (a loaded CI runner): 40 times the messages may not cost 40 times the time.
  expect(long.settled).toBeLessThan(Math.max(4_000, short.settled * 15));
  // Open and left alone, a long chat does no long work: each change of the page used to draw all 2,000 bubbles again
  // (250 to 350 ms of long tasks every two seconds here before; none after).
  expect(long.idleLong).toBeLessThan(150);
});
