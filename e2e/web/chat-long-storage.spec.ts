import { chat, expect, test } from "../support/fixtures";
import { engineHistory, seed } from "../support/chatPerf";

/**
 * A long 1:1 chat the engine keeps (its IndexedDB) is mirrored into the page's localStorage session only in part: its
 * last messages, which the chat list and a chat's first moment read. The chat still opens whole, from the engine's copy.
 * A chat of thousands of messages used to be mirrored whole, fill the page's storage (5 MB in WebKit, the Desktop app's)
 * and stop showing new messages once a write failed.
 */

/** Most messages a chat's session keeps in localStorage (apps/ui/src/lib/storage.ts `STORED_MESSAGES`). */
const STORED_MESSAGES = 200;

test("a long chat the engine keeps stores only its last messages in the page, and opens whole", { tag: ["@feature:chat.paired.storage", "@feature:chat.scroll"] }, async ({ peer }) => {
  test.setTimeout(3 * 60_000);
  const bob = await peer("storage-bob");
  // The chat, then its history in the engine's store, as if it had come over months; a reload brings it to the page.
  await seed(bob.page, [{ label: "Long chat", count: 1 }]);
  await bob.page.reload();
  await expect(bob.page.getByTestId("chat-row-name").filter({ hasText: "Long chat" })).toBeVisible();
  await engineHistory(bob.page, "Long chat", 5_000);
  await bob.page.reload();

  // Mirrored in part: the last messages, and how many older ones the engine keeps.
  const stored = () => bob.page.evaluate(() => {
    const key = Object.keys(localStorage).find(k => { try { return JSON.parse(localStorage.getItem(k)!)?.label === "Long chat"; } catch { return false; } });
    const session = key && JSON.parse(localStorage.getItem(key)!);
    return session ? { messages: session.messages.length as number, older: (session.older ?? 0) as number, chars: localStorage.getItem(key)!.length } : null;
  });
  await expect.poll(async () => (await stored())?.older ?? 0, { timeout: 30_000 }).toBeGreaterThan(4_000);
  const small = (await stored())!;
  expect(small.messages).toBeLessThanOrEqual(STORED_MESSAGES + 1);
  expect(small.messages + small.older).toBe(5_000);
  expect(small.chars).toBeLessThan(150_000);

  // Opened, it is whole: its newest message, and the first one, 5,000 up, which the newest quotes.
  await bob.page.getByTestId("chat-row-name").filter({ hasText: "Long chat" }).click();
  const newest = chat(bob).locator("[data-message-id=peer_r004999ab]");
  await expect(newest).toBeInViewport();
  await newest.getByTestId("message-quote").click();
  const first = chat(bob).locator("[data-message-id=me_r000000ab]");
  await expect(first).toHaveAttribute("data-reply-flash", "");
  await expect(first).toBeInViewport();
  await expect(bob.page.getByTestId("reply-quote-note")).toHaveCount(0);
});
