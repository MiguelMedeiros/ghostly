import type { Page } from "@playwright/test";
import { createWallet, expect, test, useFakeProviders, type Peer } from "../support/fixtures";
import { mockMainnetMints } from "../support/mint";
import { pointAt, stillness } from "../support/still";
import { swipe } from "../support/swipe";

/**
 * The wallet cards are decks, one per network: real money (Mainnet) and test money (Testnet) never share one. With a
 * mouse a deck is a stack, each card in its own place, and the one the pointer rests on comes up; on a touch screen it
 * is a snapping track and the card at rest in the centre is the chosen one. Either way the chosen card's panel shows
 * below, and the arrows under the deck and the keyboard move along it. The deck whose card is not the panel's rests:
 * the pointer crossing it chooses nothing, a click on it hands the panel over.
 *
 * A new profile has no wallet: each test makes five cards first, none of which reaches a real service: Cashu on
 * both networks (the Mainnet mints answered by the suite's own mint), the Lightning that comes with each, and a fake
 * Testnet Bitcoin wallet (in memory).
 */

/** The Testnet deck's order, the one these tests move along. */
const CARDS = ["cashu-testnet", "lightning-testnet", "bitcoin-testnet"] as const;
/** The Mainnet deck, resting while a Testnet card is chosen. */
const MAINNET = ["cashu-mainnet", "lightning-mainnet"] as const;
type Card = (typeof CARDS)[number] | (typeof MAINNET)[number];
const PANELS: Record<string, string> = { cashu: "wallet-balance", lightning: "wallet-balance", bitcoin: "bitcoin-wallet" };

/**
 * The five wallets, made with New. Testnet Cashu is made last, so the page opens on the Testnet deck's first card, as
 * a profile that has just made its wallets and comes back to them does.
 */
async function wallets(peer: Peer): Promise<Page> {
  await mockMainnetMints(peer.context);
  await useFakeProviders(peer);
  await peer.page.goto("/#/wallet");
  await createWallet(peer, "bitcoin", "testnet", { provider: "fake-onchain", fill: async (form) => {
    await form.getByLabel("Access token").fill("token");
    await form.getByTestId("provider-save").click();
  } });
  await createWallet(peer, "cashu", "mainnet");
  await createWallet(peer, "cashu", "testnet");
  // Back to the chat list: each test opens the Wallets page afresh, its decks at rest.
  await peer.page.goto("/#/");
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
  return peer.page;
}

const section = (page: Page, network: "mainnet" | "testnet") => page.getByTestId(`wallet-section-${network}`);
const deck = (page: Page, network: "mainnet" | "testnet" = "testnet") => section(page, network).locator(".wallet-deck");
const card = (page: Page, id: string) => page.getByTestId(`wallet-card-${id}`);
const chosen = async (page: Page, id: Card) => {
  await expect(card(page, id)).toHaveAttribute("aria-selected", "true");
  for (const other of [...CARDS, ...MAINNET]) if (other !== id) await expect(card(page, other)).toHaveAttribute("aria-selected", "false");
  await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", `wallet-tab-${id.replace("-", ":")}`);
  await expect(page.getByRole("tabpanel").getByTestId(PANELS[id.split("-")[0]])).toBeVisible();
};
/** How far the card's centre is from its track's centre, in pixels. */
const offCentre = (page: Page, id: string) => page.evaluate((id) => {
  const el = document.querySelector(`[data-testid=wallet-card-${id}]`)!;
  const track = el.closest(".wallet-deck-track")!.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return Math.abs(r.left + r.width / 2 - (track.left + track.width / 2));
}, id);

/** Where a card sits in the stack, whatever card is on top: the face's place, before its lift and shrink. */
const place = (page: Page, id: string) => card(page, id).evaluate((el) => (el as HTMLElement).offsetLeft + (el.querySelector(".wallet-deck-face") as HTMLElement).offsetLeft);
/** The buttons' strips of one deck, left to right: they tile the stack, with no gap and no overlap. */
const strips = (page: Page, ids: readonly string[] = CARDS) => page.evaluate((ids) => ids.map((id) => { const r = document.querySelector(`[data-testid=wallet-card-${id}]`)!.getBoundingClientRect(); return { left: r.left, right: r.right }; }), [...ids]);
const tiled = (s: { left: number; right: number }[]) => s.every((strip, i) => strip.right > strip.left && (i === 0 || Math.abs(strip.left - s[i - 1].right) <= 1));

test("with a mouse the cards are a stack: resting on one brings it up, and its panel follows", { tag: ["@feature:wallet.deck"] }, async ({ peer }) => {
  const page = await wallets(await peer("alice", { viewport: { width: 1280, height: 900 } }));
  await page.goto("/#/wallet");
  await expect(deck(page)).toHaveAttribute("data-mode", "stack");
  const tabs = page.getByRole("tablist", { name: "Testnet wallets" }).getByRole("tab");
  await expect(tabs).toHaveCount(CARDS.length);
  await chosen(page, "cashu-testnet");
  expect(tiled(await strips(page))).toBe(true);
  const before = await Promise.all(CARDS.map((id) => place(page, id)));

  // The pointer rests on the middle card's strip: it comes up, and nothing moves sideways.
  await card(page, "lightning-testnet").hover();
  await chosen(page, "lightning-testnet");
  expect(await Promise.all(CARDS.map((id) => place(page, id)))).toEqual(before);
  expect(tiled(await strips(page))).toBe(true);
  // The card that came up is under the pointer, so resting there keeps it: the stack does not flicker.
  await page.waitForTimeout(400);
  await chosen(page, "lightning-testnet");

  // Passing over the stack flips through it, a card at a time, to the one the pointer stops on.
  const box = (await card(page, "bitcoin-testnet").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await chosen(page, "bitcoin-testnet");
  await page.mouse.move(10, 10);

  await card(page, "lightning-testnet").click();
  await chosen(page, "lightning-testnet");
  // Only the chosen card is in the tab order; the others are reached with the arrows.
  await expect(card(page, "lightning-testnet")).toHaveAttribute("tabindex", "0");
  await expect(card(page, "cashu-testnet")).toHaveAttribute("tabindex", "-1");

  // A card moving under a still pointer is not the pointer moving: the keys win.
  await card(page, "lightning-testnet").focus();
  await page.keyboard.press("ArrowRight");
  await chosen(page, "bitcoin-testnet");
  await expect(card(page, "bitcoin-testnet")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await chosen(page, "cashu-testnet");
  await page.keyboard.press("End");
  await chosen(page, "bitcoin-testnet");
  await page.keyboard.press("Home");
  await chosen(page, "cashu-testnet");
  await expect(card(page, "cashu-testnet")).toBeFocused();

  // The arrows under the deck, going round at the ends.
  await page.getByTestId("wallet-deck-testnet-prev").click();
  await chosen(page, "bitcoin-testnet");
  await page.getByTestId("wallet-deck-testnet-next").click();
  await chosen(page, "cashu-testnet");
  await page.getByTestId("wallet-deck-testnet-next").click();
  await chosen(page, "lightning-testnet");

  // The chosen card is lifted; the ones after it show their trailing edge, with their mark there.
  await expect(card(page, "bitcoin-testnet").locator(".wallet-deck-card-glyph-end")).toBeVisible();
  await expect(card(page, "cashu-testnet").locator(".wallet-deck-card-glyph-end")).toBeHidden();
  // The chosen card comes back after a reload.
  await card(page, "bitcoin-testnet").click();
  await page.reload();
  await chosen(page, "bitcoin-testnet");
});

// A short window too: there the panel's amount is below the fold, and a focus on it pulled the page down to it (WebKit).
for (const height of [900, 560]) test(`the pointer passing over the cards moves neither the page nor the focus; a click puts the focus in the amount, where it is (${height} px high)`, { tag: ["@feature:wallet.deck"] }, async ({ peer }) => {
  const page = await wallets(await peer("alice", { viewport: { width: 1280, height } }));
  await page.goto("/#/wallet");
  await expect(deck(page)).toHaveAttribute("data-mode", "stack");
  await chosen(page, "cashu-testnet");
  // The page opens without taking the focus: the amount is below the decks.
  const still = await stillness(page);
  expect(still.focus).toBe("body");

  // Over each card, back and forth, and across the resting Mainnet deck: each Testnet card comes up with its panel
  // (Cashu's and Lightning's with an amount), and nothing scrolls or takes the focus.
  for (const id of ["lightning-testnet", "bitcoin-testnet", "cashu-testnet", "lightning-testnet", "cashu-mainnet", "bitcoin-testnet", "cashu-testnet"] as const) {
    await pointAt(card(page, id));
    if (id !== "cashu-mainnet") await chosen(page, id);
    expect(await stillness(page), `over ${id}`).toEqual(still);
  }

  // A click on the card under the pointer chooses it: its amount takes the focus, and the page stays where it is.
  const at = await pointAt(card(page, "lightning-testnet"));
  await page.mouse.click(at.x, at.y);
  await chosen(page, "lightning-testnet");
  await expect(page.getByTestId("wallet-receive-amount")).toBeFocused();
  expect((await stillness(page)).scroll).toEqual(still.scroll);
});

test("real money and test money are two decks: the one resting ignores the pointer crossing it, and a click hands it the panel", { tag: ["@feature:wallet.deck", "@feature:wallet.instances.sections"] }, async ({ peer }) => {
  const page = await wallets(await peer("alice", { viewport: { width: 1280, height: 900 } }));
  await page.goto("/#/wallet");
  await chosen(page, "cashu-testnet");
  // Whose money, in words as well as colour, and each network's cards in its own deck.
  await expect(section(page, "mainnet").getByRole("heading")).toHaveText(/Real money\s*· Mainnet/);
  await expect(section(page, "testnet").getByRole("heading")).toHaveText(/Test money\s*· Testnet/);
  await expect(page.getByRole("tablist", { name: "Mainnet wallets" }).getByRole("tab")).toHaveCount(MAINNET.length);
  await expect(deck(page, "mainnet")).toHaveAttribute("data-resting", "true");
  await expect(deck(page, "testnet")).not.toHaveAttribute("data-resting");
  await expect(page.getByTestId("wallet-panel-network")).toHaveText("Test money");

  // The pointer crosses the Mainnet deck on its way somewhere: nothing is chosen.
  const box = (await card(page, "lightning-mainnet").boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 6 });
  await page.mouse.move(10, 10);
  await chosen(page, "cashu-testnet");

  // A click on it hands it the panel; the Testnet deck rests, its card still on top.
  await card(page, "lightning-mainnet").click();
  await chosen(page, "lightning-mainnet");
  await expect(deck(page, "testnet")).toHaveAttribute("data-resting", "true");
  await expect(deck(page, "mainnet")).not.toHaveAttribute("data-resting");
  await expect(page.getByTestId("wallet-panel-network")).toHaveText("Real money");
  // Now the Mainnet deck follows the pointer, and the keys stay in it.
  await card(page, "cashu-mainnet").hover();
  await chosen(page, "cashu-mainnet");
  await page.mouse.move(10, 10);
  await card(page, "cashu-mainnet").focus();
  await page.keyboard.press("ArrowRight");
  await chosen(page, "lightning-mainnet");
  // A click on the resting Testnet deck's top card brings that deck back, on that card.
  await card(page, "cashu-testnet").click();
  await chosen(page, "cashu-testnet");
});

test("on a phone the cards are a snapping track: a swipe chooses the card that comes to rest in the centre", { tag: ["@feature:wallet.deck"] }, async ({ peer }) => {
  const alice = await peer("alice", { mobile: true });
  const { page, context } = alice;
  await wallets(alice);
  await page.goto("/#/wallet");
  await expect(deck(page)).toHaveAttribute("data-mode", "track");
  await chosen(page, "cashu-testnet");
  expect(await offCentre(page, "cashu-testnet")).toBeLessThan(3);
  await expect(deck(page).locator(".wallet-deck-marks span[data-on=true]")).toHaveCount(1);
  await expect(deck(page, "mainnet").locator(".wallet-deck-marks span[data-on=true]")).toHaveCount(0);

  // A finger drags the track to the left, past half a card, and lets go: the next card settles in the centre and
  // becomes the chosen one.
  await swipe(context, deck(page).locator(".wallet-deck-track"), -0.6);
  await chosen(page, "lightning-testnet");
  await expect.poll(() => offCentre(page, "lightning-testnet")).toBeLessThan(3);

  // Tapping a card at the side brings it to the centre and chooses it.
  await card(page, "bitcoin-testnet").click();
  await chosen(page, "bitcoin-testnet");
  await expect.poll(() => offCentre(page, "bitcoin-testnet")).toBeLessThan(3);

  // The arrows move along the track too.
  await page.getByTestId("wallet-deck-testnet-prev").click();
  await chosen(page, "lightning-testnet");
  await expect.poll(() => offCentre(page, "lightning-testnet")).toBeLessThan(3);

  // The keyboard works on the track too.
  await card(page, "lightning-testnet").focus();
  await page.keyboard.press("Home");
  await chosen(page, "cashu-testnet");
  await expect.poll(() => offCentre(page, "cashu-testnet")).toBeLessThan(3);
  await page.keyboard.press("End");
  await chosen(page, "bitcoin-testnet");
  await expect.poll(() => offCentre(page, "bitcoin-testnet")).toBeLessThan(3);
  // Two keys faster than the track scrolls: the end of the first, cut off on its way, does not choose its card.
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => offCentre(page, "cashu-testnet")).toBeLessThan(3);
  await chosen(page, "cashu-testnet");

  // A tap on the resting Mainnet track hands it the panel.
  await card(page, "cashu-mainnet").click();
  await chosen(page, "cashu-mainnet");
  // Nothing scrolls sideways but the tracks themselves.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.evaluate(() => { const body = document.querySelector("[data-page-body]")!; return body.scrollWidth <= body.clientWidth + 1; })).toBe(true);
});

test("a desktop column squeezed by the chat list keeps the stack, and every card can still be reached", { tag: ["@feature:wallet.deck", "@feature:app.sidebar-resize"] }, async ({ peer }) => {
  const page = await wallets(await peer("alice", { viewport: { width: 1100, height: 900 } }));
  await page.goto("/#/wallet");
  const handle = (await page.getByTestId("sidebar-resize").boundingBox())!;
  await page.mouse.move(handle.x + 1, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(1090, handle.y + 100, { steps: 5 });
  await page.mouse.up();
  await expect(deck(page)).toHaveAttribute("data-mode", "stack");
  const column = (await page.getByTestId("wallet").boundingBox())!;
  // Still a stack of readable cards (deck/Deck.tsx STACK_MIN_CARD); narrower, it is a track (responsive.spec.ts).
  expect((await card(page, "cashu-testnet").locator(".wallet-deck-face").boundingBox())!.width).toBeGreaterThanOrEqual(210);
  const narrow = await strips(page);
  expect(tiled(narrow)).toBe(true);
  // The whole stack is inside the column.
  expect(narrow[0].left).toBeGreaterThanOrEqual(column.x - 1);
  expect(narrow[narrow.length - 1].right).toBeLessThanOrEqual(column.x + column.width + 1);
  for (const id of ["bitcoin-testnet", "cashu-testnet", "lightning-testnet"] as const) {
    await card(page, id).hover();
    await chosen(page, id);
  }
});

/**
 * Records the switch's own animations (walletDeckMotion.ts) from now on, per card: which part of it moved. Recorded
 * as they start rather than looked for afterwards, so a busy machine that is slow to ask cannot miss a short one.
 */
const recordSwings = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { swings: Record<string, string[]>; original?: typeof Element.prototype.animate };
  w.swings = {};
  w.original ??= Element.prototype.animate;
  const original = w.original;
  Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
    const id = this.closest("[data-testid^=wallet-card-]")?.getAttribute("data-testid")?.replace("wallet-card-", "");
    if (id) (w.swings[id] ??= []).push((this as HTMLElement).className);
    return original.apply(this, args);
  };
});
const swings = (page: Page) => page.evaluate(() => (window as unknown as { swings: Record<string, string[]> }).swings);
/** Every face at rest: no swing left over, whatever interrupted what. */
const atRest = (page: Page) => page.evaluate(() => [...document.querySelectorAll(".wallet-deck-face")].every((face) => {
  const style = getComputedStyle(face);
  return face.getAnimations().every((a) => a instanceof CSSTransition) && ["none", "0deg"].includes(style.rotate) && ["none", "0px", "0px 0px"].includes(style.translate);
}));

test("changing the card swings the new one up and tucks the old one back, and quick changes all settle", { tag: ["@feature:wallet.deck"] }, async ({ peer }) => {
  const page = await wallets(await peer("alice", { viewport: { width: 1280, height: 900 } }));
  await page.goto("/#/wallet");
  await chosen(page, "cashu-testnet");
  await recordSwings(page);

  await page.getByTestId("wallet-deck-testnet-next").click();
  await chosen(page, "lightning-testnet");
  const moving = await swings(page);
  expect(moving["lightning-testnet"]).toEqual(["wallet-deck-face", "wallet-deck-card-ghost", "wallet-deck-card-sheen"]);
  expect(moving["cashu-testnet"]).toEqual(["wallet-deck-face"]);
  expect(Object.keys(moving).sort()).toEqual(["cashu-testnet", "lightning-testnet"]);
  await chosen(page, "lightning-testnet");
  await expect.poll(() => atRest(page)).toBe(true);

  // Clicking faster than a swing lasts: every one is interrupted, the last card wins and the stack comes to rest.
  for (let i = 0; i < 3; i++) await page.getByTestId("wallet-deck-testnet-next").click({ delay: 0 });
  await chosen(page, "lightning-testnet");
  await expect.poll(() => atRest(page)).toBe(true);
  expect(tiled(await strips(page))).toBe(true);
});

test("on a phone the card that settles in the centre swings too", { tag: ["@feature:wallet.deck"] }, async ({ peer }) => {
  const page = await wallets(await peer("alice", { mobile: true }));
  await page.goto("/#/wallet");
  await expect(deck(page)).toHaveAttribute("data-mode", "track");
  await chosen(page, "cashu-testnet");
  await recordSwings(page);
  await page.getByTestId("wallet-deck-testnet-next").click();
  await chosen(page, "lightning-testnet");
  expect((await swings(page))["lightning-testnet"]).toContain("wallet-deck-face");
  await expect.poll(() => offCentre(page, "lightning-testnet")).toBeLessThan(3);
  await expect.poll(() => atRest(page)).toBe(true);
});

test("with reduced motion the deck still stacks, chooses and follows, without a transition", { tag: ["@feature:wallet.deck"] }, async ({ peer }) => {
  const page = await wallets(await peer("alice", { viewport: { width: 1280, height: 900 } }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/#/wallet");
  await chosen(page, "cashu-testnet");
  await recordSwings(page);
  await card(page, "bitcoin-testnet").click();
  await chosen(page, "bitcoin-testnet");
  expect(await card(page, "bitcoin-testnet").locator(".wallet-deck-face").evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
  // The keys from here on: the pointer leaves the deck, so no card coming up under it takes the choice back.
  await page.mouse.move(5, 5);
  await card(page, "bitcoin-testnet").focus();
  await page.keyboard.press("ArrowLeft");
  await chosen(page, "lightning-testnet");
  // No swing, no sheen, no ghost peeking: the deck changes at once.
  expect(await swings(page)).toEqual({});
  expect(await atRest(page)).toBe(true);
});

test("the app's own reduced-motion switch stills the deck too", async ({ peer }) => {
  const page = await wallets(await peer("alice", { viewport: { width: 1280, height: 900 } }));
  await page.goto("/#/settings");
  await page.getByRole("switch", { name: "Reduce motion" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", "true");
  await page.goto("/#/wallet");
  await chosen(page, "cashu-testnet");
  await recordSwings(page);
  await page.getByTestId("wallet-deck-testnet-next").click();
  await chosen(page, "lightning-testnet");
  expect(await swings(page)).toEqual({});
  expect(await card(page, "lightning-testnet").locator(".wallet-deck-face").evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
});
