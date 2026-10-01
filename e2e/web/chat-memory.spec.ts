import { chat, connect, expect, link, say, test } from "../support/fixtures";

/**
 * An open chat's memory as messages keep coming. A message that comes while the chat is open plays its entry and is
 * then like any other row: nothing of the animation stays in effect. With fill `both` every live row kept one, for as
 * long as the row was in the page (a transform each in Chromium, about 200 KB of WebKit's heap per row in the Desktop
 * app's engine).
 *
 * The bound on the rows in the page while messages keep coming (`useRowWindow`'s trim) is in the unit tests
 * (apps/ui/src/test/chat/chatScroll.test.tsx): it needs 300 rows.
 */

test("messages that come while a chat is open leave nothing of their entry behind", { tag: ["@feature:chat.scroll"] }, async ({ peer }) => {
  test.setTimeout(4 * 60_000);
  const [alice, bob] = await Promise.all([peer("memory-alice"), peer("memory-bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  const entries = () => bob.page.evaluate(() => document.getAnimations().filter(a => (a as CSSAnimation).animationName?.startsWith("bubble-in")).length);

  for (let i = 1; i <= 10; i++) {
    await expect(alice.page.getByPlaceholder("Message…")).toHaveValue("");
    await say(alice, `ghost ${i}`);
  }
  await expect(chat(bob).getByText("ghost 10", { exact: true })).toBeVisible();
  // Each entry plays (0.22 s), then is over: none is still in effect.
  await expect.poll(entries).toBe(0);
});
