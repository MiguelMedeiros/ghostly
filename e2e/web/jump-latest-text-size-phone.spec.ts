import { createLink } from "@ghostly/core";
import type { Page } from "@playwright/test";
import { chat, expect, test, type Peer } from "../support/fixtures";

/**
 * The chat's ↓ (jump to the latest message) on a 375px phone at a larger browser text size. Its 44px was 2.75rem, so it
 * grew with the text: 66px at 24px text, an 88px circle at 32px over the newest messages' text and time. It is 44px
 * at any text size now, in its corner, on the screen.
 */
const PHONE = { width: 375, height: 667 };
const COUNT = 300;
const jump = (page: Page) => page.getByTestId("jump-latest");

/** A chat of `COUNT` texts ("Message 0" on), opened at its bottom. */
async function seedChat(p: Peer) {
  const mine = createLink().mine;
  await p.page.evaluate(({ mine, count }) => {
    const id = crypto.randomUUID().replaceAll("-", "");
    const start = Date.now() - 86_400_000 * 3;
    const messages = Array.from({ length: count }, (_, i) => ({
      id: `m${i}`, sender: i % 2 ? "peer" : "me", timestamp: start + i * 60_000, delivery: i % 2 ? undefined : "delivered", text: `Message ${i}`,
    }));
    localStorage.setItem(`ghostly_${id}`, JSON.stringify({ id, mySeedB64: mine.seedB64, peerPubKeyB64: mine.peerPubKeyZ32, encKeyB64: mine.encKeyB64, messages, createdAt: start }));
    localStorage.setItem(`ghostly_join_${id}`, "true");
    window.dispatchEvent(new Event("session-updated"));
    location.hash = `/chat/${id}`;
  }, { mine, count: COUNT });
  await expect(p.page.locator(`.chat-wallpaper [data-message-id="m${COUNT - 1}"]`)).toBeInViewport();
}

test("on a 375px phone at a larger text size the chat's jump to the latest stays a 44px button", { tag: ["@feature:chat.scroll", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  test.setTimeout(3 * 60_000);
  const alice = await peer("jump-phone-alice", { mobile: true, viewport: PHONE });
  const page = alice.page;
  await seedChat(alice);
  // The browser's text size (Android Chrome's text scaling): rem grows, the screen stays 375px.
  const cdp = await page.context().newCDPSession(page);
  for (const px of [24, 32]) {
    await cdp.send("Page.setFontSizes", { fontSizes: { standard: px, fixed: Math.round(px * 13 / 16) } });
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(`${px}px`);
    // Far up the chat with nothing new: a plain ↓.
    await chat(alice).evaluate((el) => { el.scrollTop = 0; });
    await expect(jump(page)).toBeVisible();
    await expect(jump(page)).toHaveAttribute("data-count", "0");

    // It was 2.75rem: 66px at 24px text, 88px at 32px. A thumb's 44px at any text size, whole on the screen.
    const box = (await jump(page).boundingBox())!;
    expect.soft(box.width, `${px}px width`).toBeCloseTo(44, 0);
    expect.soft(box.height, `${px}px height`).toBeCloseTo(44, 0);
    expect.soft(box.x, `${px}px left`).toBeGreaterThanOrEqual(0);
    expect.soft(box.x + box.width, `${px}px right`).toBeLessThanOrEqual(PHONE.width);
    expect.soft(box.y + box.height, `${px}px bottom`).toBeLessThanOrEqual(PHONE.height);

    await jump(page).click();
    await expect(page.locator(`.chat-wallpaper [data-message-id="m${COUNT - 1}"]`)).toBeInViewport();
    await expect(jump(page)).toHaveCount(0);
  }
});
