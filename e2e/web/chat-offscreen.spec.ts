import { seed } from "../support/chatPerf";
import { chat, expect, test, type Peer } from "../support/fixtures";

/**
 * A chat kept loaded while another one is on screen (it is on a call, or a mini-app runs in it: App.tsx hides its
 * wrapper), then shown again. Chromium brings its list back where it was. WebKit (Safari, the macOS and Linux apps)
 * brings it back at the top and says so with a scroll event no hand made: the chat used to stay there, a hundred older
 * messages taken in above, and was remembered as left up there. It runs in WebKit too (playwright.webkit.config.ts).
 *
 * The wrapper is hidden here the way App.tsx hides it (its class), without the call or the app that makes it do so.
 */

const distanceToBottom = (p: Peer) => chat(p).evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
const rowsInPage = (p: Peer) => chat(p).locator("[data-message-id]").count();

/** Off screen for a moment, as a chat kept loaded is while another one is open, and back. */
async function awayAndBack(p: Peer): Promise<void> {
  const wrapper = p.page.locator(".chat-pane").locator("xpath=..");
  const shown = await wrapper.evaluate(el => { const was = el.getAttribute("class")!; el.setAttribute("class", "hidden"); return was; });
  await p.page.waitForTimeout(400);
  expect(await chat(p).evaluate(el => el.clientHeight)).toBe(0);
  await wrapper.evaluate((el, shown) => { el.setAttribute("class", shown); }, shown);
}

/** The first message whose top is in the view, and how far down the view its top is. */
function topRow(p: Peer): Promise<{ id: string; y: number }> {
  return chat(p).evaluate(el => {
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll<HTMLElement>("[data-message-id]")].find(row => row.getBoundingClientRect().top >= top + 8)!;
    return { id: row.dataset.messageId!, y: row.getBoundingClientRect().top - top };
  });
}

test("a chat kept loaded off screen is back where it was: at its bottom, or on its message", { tag: ["@feature:chat.scroll"] }, async ({ peer }) => {
  const bob = await peer("offscreen-bob");
  const [long, short] = await seed(bob.page, [{ label: "Long", count: 400 }, { label: "Short", count: 30 }]);
  const open = (id: string) => bob.page.evaluate(id => { location.hash = `/chat/${id}`; }, id);
  const atBottom = () => expect.poll(() => distanceToBottom(bob), { timeout: 10_000 }).toBeLessThanOrEqual(2);

  await open(long);
  await expect(chat(bob).locator("[data-message-id]").last()).toBeVisible();
  await atBottom();
  // Its rows have laid out (previews, cards): nothing moves by itself from here.
  await bob.page.waitForTimeout(1_000);
  const rows = await rowsInPage(bob);

  // 1. At its bottom: back at its bottom, with the rows it had.
  await awayAndBack(bob);
  await atBottom();
  await bob.page.waitForTimeout(1_000);
  expect(await distanceToBottom(bob)).toBeLessThanOrEqual(2);
  expect(await rowsInPage(bob)).toBe(rows);

  // And still remembered at its bottom: another chat, then this one again.
  await open(short);
  await expect.poll(() => rowsInPage(bob)).toBeLessThanOrEqual(30);
  await open(long);
  await expect.poll(() => rowsInPage(bob)).toBe(rows);
  await atBottom();
  await bob.page.waitForTimeout(1_000);
  expect(await distanceToBottom(bob)).toBeLessThanOrEqual(2);

  // 2. Scrolled up by hand: back on the same message, where it was in the view.
  const box = (await chat(bob).boundingBox())!;
  await bob.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 3; i++) {
    await bob.page.mouse.wheel(0, -700);
    await bob.page.waitForTimeout(80);
  }
  await expect.poll(() => distanceToBottom(bob)).toBeGreaterThan(1_000);
  // The wheel's smooth scrolling has ended, and the hand is off it.
  await bob.page.waitForTimeout(1_500);
  const left = await topRow(bob);
  await awayAndBack(bob);
  const row = chat(bob).locator(`[data-message-id="${left.id}"]`);
  const y = () => row.evaluate(row => row.getBoundingClientRect().top - row.closest(".chat-wallpaper")!.getBoundingClientRect().top);
  await expect.poll(async () => Math.abs(await y() - left.y), { timeout: 10_000 }).toBeLessThanOrEqual(3);
  await bob.page.waitForTimeout(1_000);
  expect(Math.abs(await y() - left.y)).toBeLessThanOrEqual(3);
  expect(await distanceToBottom(bob)).toBeGreaterThan(400);
});
