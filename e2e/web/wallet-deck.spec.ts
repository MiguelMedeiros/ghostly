import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

/**
 * The wallet cards are a deck. With a mouse they are a stack, each card in its own place, and the one the pointer
 * rests on comes up; on a touch screen they are a snapping track and the card at rest in the centre is the chosen
 * one. Either way the chosen card's panel shows below, and the arrows under the deck and the keyboard move along it.
 */

const CARDS = ["cashu", "lightning", "arkade", "bark", "bitcoin", "usdt"] as const;
const PANELS: Record<(typeof CARDS)[number], string> = { cashu: "wallet-balance", lightning: "wallet-balance", arkade: "ark-wallet", bark: "bark-wallet", bitcoin: "bitcoin-wallet", usdt: "usdt-wallet" };

const deck = (page: Page) => page.getByTestId("wallet").locator(".wallet-deck");
const card = (page: Page, id: string) => page.getByTestId(`wallet-card-${id}`);
const chosen = async (page: Page, id: (typeof CARDS)[number]) => {
  await expect(card(page, id)).toHaveAttribute("aria-selected", "true");
  for (const other of CARDS) if (other !== id) await expect(card(page, other)).toHaveAttribute("aria-selected", "false");
  await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", `wallet-tab-${id}`);
  await expect(page.getByRole("tabpanel").getByTestId(PANELS[id])).toBeVisible();
};
/** How far the card's centre is from the track's centre, in pixels. */
const offCentre = (page: Page, id: string) => page.evaluate((id) => {
  const track = document.querySelector(".wallet-deck-track")!.getBoundingClientRect();
  const r = document.querySelector(`[data-testid=wallet-card-${id}]`)!.getBoundingClientRect();
  return Math.abs(r.left + r.width / 2 - (track.left + track.width / 2));
}, id);

/** Where a card sits in the stack, whatever card is on top: the face's place, before its lift and shrink. */
const place = (page: Page, id: string) => card(page, id).evaluate((el) => (el as HTMLElement).offsetLeft + (el.querySelector(".wallet-deck-face") as HTMLElement).offsetLeft);
/** The buttons' strips, left to right: they tile the stack, with no gap and no overlap. */
const strips = (page: Page) => page.evaluate((ids) => ids.map((id) => { const r = document.querySelector(`[data-testid=wallet-card-${id}]`)!.getBoundingClientRect(); return { left: r.left, right: r.right }; }), [...CARDS]);
const tiled = (s: { left: number; right: number }[]) => s.every((strip, i) => strip.right > strip.left && (i === 0 || Math.abs(strip.left - s[i - 1].right) <= 1));

test("with a mouse the cards are a stack: resting on one brings it up, and its panel follows", async ({ peer }) => {
  const { page } = await peer("alice", { viewport: { width: 1280, height: 900 } });
  await page.goto("/#/wallet");
  await expect(deck(page)).toHaveAttribute("data-mode", "stack");
  const tabs = page.getByRole("tablist", { name: "Wallet integrations" }).getByRole("tab");
  await expect(tabs).toHaveCount(CARDS.length);
  await chosen(page, "cashu");
  expect(tiled(await strips(page))).toBe(true);
  const before = await Promise.all(CARDS.map((id) => place(page, id)));

  // The pointer rests on the Bark card's strip: it comes up, and nothing moves sideways.
  await card(page, "bark").hover();
  await chosen(page, "bark");
  expect(await Promise.all(CARDS.map((id) => place(page, id)))).toEqual(before);
  expect(tiled(await strips(page))).toBe(true);
  // The card that came up is under the pointer, so resting there keeps it: the stack does not flicker.
  await page.waitForTimeout(400);
  await chosen(page, "bark");

  // Passing over the stack flips through it, a card at a time, to the one the pointer stops on.
  const box = (await card(page, "usdt").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await chosen(page, "usdt");
  await page.mouse.move(10, 10);

  await card(page, "bark").click();
  await chosen(page, "bark");
  // Only the chosen card is in the tab order; the others are reached with the arrows.
  await expect(card(page, "bark")).toHaveAttribute("tabindex", "0");
  await expect(card(page, "cashu")).toHaveAttribute("tabindex", "-1");

  // A card moving under a still pointer is not the pointer moving: the keys win.
  await card(page, "bark").focus();
  await page.keyboard.press("ArrowRight");
  await chosen(page, "bitcoin");
  await expect(card(page, "bitcoin")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await chosen(page, "arkade");
  await page.keyboard.press("End");
  await chosen(page, "usdt");
  await page.keyboard.press("Home");
  await chosen(page, "cashu");
  await expect(card(page, "cashu")).toBeFocused();

  // The arrows under the deck, going round at the ends.
  await page.getByTestId("wallet-deck-prev").click();
  await chosen(page, "usdt");
  await page.getByTestId("wallet-deck-next").click();
  await chosen(page, "cashu");
  await page.getByTestId("wallet-deck-next").click();
  await chosen(page, "lightning");

  // The chosen card is lifted; the ones after it show their trailing edge, with their mark there.
  await expect(card(page, "arkade").locator(".wallet-deck-card-glyph-end")).toBeVisible();
  await expect(card(page, "cashu").locator(".wallet-deck-card-glyph-end")).toBeHidden();
  // The chosen card comes back after a reload.
  await card(page, "usdt").click();
  await page.reload();
  await chosen(page, "usdt");
});

test("on a phone the cards are a snapping track: a swipe chooses the card that comes to rest in the centre", async ({ peer }) => {
  const { page, context } = await peer("alice", { mobile: true });
  await page.goto("/#/wallet");
  await expect(deck(page)).toHaveAttribute("data-mode", "track");
  await chosen(page, "cashu");
  expect(await offCentre(page, "cashu")).toBeLessThan(3);
  await expect(deck(page).locator(".wallet-deck-marks span[data-on=true]")).toHaveCount(1);

  // A finger flicks the track to the left: the next card settles in the centre and becomes the chosen one.
  const track = (await page.locator(".wallet-deck-track").boundingBox())!;
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.synthesizeScrollGesture", { x: track.x + track.width / 2, y: track.y + track.height / 2, xDistance: -Math.round(track.width * 0.6), yDistance: 0, gestureSourceType: "touch", speed: 1500 });
  await chosen(page, "lightning");
  await expect.poll(() => offCentre(page, "lightning")).toBeLessThan(3);

  // Tapping a card at the side brings it to the centre and chooses it.
  await card(page, "arkade").click();
  await chosen(page, "arkade");
  await expect.poll(() => offCentre(page, "arkade")).toBeLessThan(3);

  // The arrows move along the track too.
  await page.getByTestId("wallet-deck-next").click();
  await chosen(page, "bark");
  await expect.poll(() => offCentre(page, "bark")).toBeLessThan(3);

  // The keyboard works on the track too.
  await card(page, "bark").focus();
  await page.keyboard.press("ArrowRight");
  await chosen(page, "bitcoin");
  await expect.poll(() => offCentre(page, "bitcoin")).toBeLessThan(3);
  await page.keyboard.press("End");
  await chosen(page, "usdt");
  await expect.poll(() => offCentre(page, "usdt")).toBeLessThan(3);
  // Nothing scrolls sideways but the track itself.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.evaluate(() => { const body = document.querySelector("[data-page-body]")!; return body.scrollWidth <= body.clientWidth + 1; })).toBe(true);
});

test("a desktop column squeezed by the chat list keeps the stack, and every card can still be reached", async ({ peer }) => {
  const { page } = await peer("alice", { viewport: { width: 1100, height: 900 } });
  await page.goto("/#/wallet");
  const handle = (await page.getByTestId("sidebar-resize").boundingBox())!;
  await page.mouse.move(handle.x + 1, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(1090, handle.y + 100, { steps: 5 });
  await page.mouse.up();
  await expect(deck(page)).toHaveAttribute("data-mode", "stack");
  const column = (await page.getByTestId("wallet").boundingBox())!;
  const narrow = await strips(page);
  expect(tiled(narrow)).toBe(true);
  // The whole stack is inside the column.
  expect(narrow[0].left).toBeGreaterThanOrEqual(column.x - 1);
  expect(narrow[narrow.length - 1].right).toBeLessThanOrEqual(column.x + column.width + 1);
  for (const id of ["usdt", "arkade", "lightning"] as const) {
    await card(page, id).hover();
    await chosen(page, id);
  }
});

test("with reduced motion the deck still stacks, chooses and follows, without a transition", async ({ peer }) => {
  const { page } = await peer("alice", { viewport: { width: 1280, height: 900 } });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#/wallet");
  await card(page, "bitcoin").click();
  await chosen(page, "bitcoin");
  expect(await card(page, "bitcoin").locator(".wallet-deck-face").evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
  await card(page, "bitcoin").focus();
  await page.keyboard.press("ArrowLeft");
  await chosen(page, "bark");
});
