import { chat, connect, expect, link, say, test } from "../support/fixtures";

/**
 * An open chat's memory as messages keep coming, and once it is closed (Chromium: its DevTools protocol counts the page's
 * nodes, attached or not, after a garbage collection).
 *
 * - A message that comes while the chat is open plays its entry and then is like any other row: nothing of the
 *   animation stays in effect. With fill `both` every live row kept one, a transform each (a layer of its own in WebKit).
 * - A chat closed while its composer has the focus lets its whole page go. A field taken out with the focus gets no
 *   focusout, and React kept it (and, through it, every row of the closed chat) until another text field took the focus.
 *
 * The bound on the rows in the page while messages keep coming (`useRowWindow`'s trim) is in the unit tests
 * (apps/ui/src/test/chat/chatScroll.test.tsx): it needs 300 rows.
 */

test.use({ trace: "off", video: "off" });

test("an open chat keeps nothing of its entries, and a closed one lets its rows go", { tag: ["@feature:chat.scroll"] }, async ({ peer }) => {
  test.setTimeout(4 * 60_000);
  const [alice, bob] = await Promise.all([peer("memory-alice"), peer("memory-bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  const cdp = await bob.context.newCDPSession(bob.page);
  await cdp.send("Performance.enable");
  const nodes = async () => {
    for (let i = 0; i < 3; i++) await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = await cdp.send("Performance.getMetrics");
    return metrics.find(m => m.name === "Nodes")!.value;
  };

  // Bob's composer has the focus (he said hello); Alice's messages come while his chat is open, at its bottom.
  await expect(bob.page.getByPlaceholder("Message…")).toBeFocused();
  for (let i = 1; i <= 25; i++) {
    await expect(alice.page.getByPlaceholder("Message…")).toHaveValue("");
    await say(alice, `ghost ${i}`);
  }
  await expect(chat(bob).getByText("ghost 25", { exact: true })).toBeVisible();
  // Every entry has played (0.22 s): none is still in effect.
  await expect.poll(() => bob.page.evaluate(() => document.getAnimations().filter(a => (a as CSSAnimation).animationName?.startsWith("bubble-in")).length)).toBe(0);

  // Bob leaves the chat with the app's own navigation, the composer still focused: its rows leave the page and memory.
  const open = await nodes();
  await bob.page.evaluate(() => { location.hash = "#/"; });
  await expect(chat(bob)).toHaveCount(0);
  const attached = await bob.page.evaluate(() => { let n = 0; const w = document.createTreeWalker(document, NodeFilter.SHOW_ALL); while (w.nextNode()) n++; return n; });
  // Live nodes once collected: the page's own, give or take what the engine keeps for a moment (never the closed chat's rows).
  await expect.poll(async () => (await nodes()) - attached, { timeout: 15_000 }).toBeLessThan((open - attached) / 3);
});
