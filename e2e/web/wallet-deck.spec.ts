import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

/**
 * The wallet cards are a deck. In a wide column they fan out in place; in a narrow one (a phone, or a desktop
 * column squeezed by the chat list) they are a snapping track and the card at rest in the centre is the chosen
 * one. Either way the chosen card's panel shows below, and the keyboard moves along the deck.
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

test("a wide column fans the cards out: a click or the arrow keys choose one, and its panel follows", async ({ peer }) => {
  const { page } = await peer("alice", { viewport: { width: 1280, height: 900 } });
  await page.goto("/#/wallet");
  await expect(deck(page)).toHaveAttribute("data-mode", "fan");
  const tabs = page.getByRole("tablist", { name: "Wallet integrations" }).getByRole("tab");
  await expect(tabs).toHaveCount(CARDS.length);
  await chosen(page, "cashu");

  await card(page, "bark").click();
  await chosen(page, "bark");
  // Only the chosen card is in the tab order; the others are reached with the arrows.
  await expect(card(page, "bark")).toHaveAttribute("tabindex", "0");
  await expect(card(page, "cashu")).toHaveAttribute("tabindex", "-1");

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
  // The chosen card is the lifted, upright one; the others spread away from it in order, turned and lower.
  const place = (id: string) => card(page, id).evaluate((el) => { const s = getComputedStyle(el); return { x: parseFloat(s.getPropertyValue("--x")), y: parseFloat(s.getPropertyValue("--y")), tilt: parseFloat(s.getPropertyValue("--ry")) }; });
  const cashu = await place("cashu"), lightning = await place("lightning"), usdt = await place("usdt");
  expect(cashu.y).toBeLessThan(0);
  expect(cashu.tilt).toBe(0);
  expect(lightning.x).toBeGreaterThan(cashu.x);
  expect(usdt.x).toBeGreaterThan(lightning.x);
  expect(lightning.tilt).not.toBe(0);
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
  await expect(deck(page).locator(".wallet-deck-dots span[data-on=true]")).toHaveCount(1);

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

  // The keyboard works on the track too.
  await card(page, "arkade").focus();
  await page.keyboard.press("ArrowRight");
  await chosen(page, "bark");
  await expect.poll(() => offCentre(page, "bark")).toBeLessThan(3);
  await page.keyboard.press("End");
  await chosen(page, "usdt");
  await expect.poll(() => offCentre(page, "usdt")).toBeLessThan(3);
  // Nothing scrolls sideways but the track itself.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.evaluate(() => { const body = document.querySelector("[data-page-body]")!; return body.scrollWidth <= body.clientWidth + 1; })).toBe(true);
});

test("a desktop column squeezed by the chat list gets the track too, and a mouse can drag it", async ({ peer }) => {
  const { page } = await peer("alice", { viewport: { width: 1100, height: 900 } });
  await page.goto("/#/wallet");
  await expect(deck(page)).toHaveAttribute("data-mode", "fan");
  const handle = (await page.getByTestId("sidebar-resize").boundingBox())!;
  await page.mouse.move(handle.x + 1, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(1090, handle.y + 100, { steps: 5 });
  await page.mouse.up();
  await expect(deck(page)).toHaveAttribute("data-mode", "track");
  await expect.poll(() => offCentre(page, "cashu")).toBeLessThan(3);

  // Dragging the track with the mouse, then letting go: the nearest card settles in the centre.
  const track = (await page.locator(".wallet-deck-track").boundingBox())!;
  const y = track.y + track.height / 2;
  await page.mouse.move(track.x + track.width * 0.7, y);
  await page.mouse.down();
  await page.mouse.move(track.x + track.width * 0.2, y, { steps: 12 });
  await page.mouse.up();
  await chosen(page, "lightning");
  await expect.poll(() => offCentre(page, "lightning")).toBeLessThan(3);

  // Widening the column again brings the fan back, with the same card chosen.
  const squeezed = (await page.getByTestId("sidebar-resize").boundingBox())!;
  await page.mouse.move(squeezed.x + 1, squeezed.y + 100);
  await page.mouse.down();
  await page.mouse.move(handle.x, handle.y + 100, { steps: 5 });
  await page.mouse.up();
  await expect(deck(page)).toHaveAttribute("data-mode", "fan");
  await chosen(page, "lightning");
});

test("with reduced motion the deck still fans, chooses and follows, without a transition", async ({ peer }) => {
  const { page } = await peer("alice", { viewport: { width: 1280, height: 900 } });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#/wallet");
  await card(page, "bitcoin").click();
  await chosen(page, "bitcoin");
  expect(await card(page, "bitcoin").evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
  await card(page, "bitcoin").focus();
  await page.keyboard.press("ArrowLeft");
  await chosen(page, "bark");
});
