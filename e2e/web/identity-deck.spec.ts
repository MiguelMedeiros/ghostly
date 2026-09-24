import type { Locator, Page } from "@playwright/test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { expect, test, type Peer } from "../support/fixtures";
import { addNostrIdentity, injectNostrSigner } from "../support/nostrSigner";
import { swipe } from "../support/swipe";
import { choose } from "../support/select";

/**
 * The person's identities are a deck of ID cards, with the wallet's mechanics (deck/Deck.tsx): with a mouse a
 * stack whose cards come up under a resting pointer, on a phone a snapping track. The chosen card's details show
 * below it, the keyboard and the arrows move along it, and the last card adds an identity.
 */

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

const deck = (page: Page) => page.getByTestId("identities-mine").locator(".id-deck");
const byName = (page: Page, name: string) => page.getByTestId("identity-proof").filter({ hasText: name });
const addCard = (page: Page) => page.getByTestId("identity-add");
const panel = (page: Page) => page.getByTestId("identity-panel");
/** The card is the chosen one, the only one, and the panel below is its own. */
async function chosen(page: Page, card: Locator) {
  await expect(card).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tablist", { name: "Your identities" }).locator("[aria-selected=true]")).toHaveCount(1);
  await expect(panel(page)).toHaveAttribute("aria-labelledby", (await card.getAttribute("id"))!);
}
const offCentre = (page: Page, card: Locator) => card.evaluate((el) => {
  const track = document.querySelector(".id-deck-track")!.getBoundingClientRect(), r = el.getBoundingClientRect();
  return Math.abs(r.left + r.width / 2 - (track.left + track.width / 2));
});
const strips = (page: Page) => page.getByRole("tablist", { name: "Your identities" }).getByRole("tab").evaluateAll((tabs) => tabs.map((t) => { const r = t.getBoundingClientRect(); return { left: r.left, right: r.right }; }));
const tiled = (s: { left: number; right: number }[]) => s.every((strip, i) => strip.right > strip.left && (i === 0 || Math.abs(strip.left - s[i - 1].right) <= 1));

/** Records the switch's animations from now on, by the part of an ID card that moved. */
const recordSwings = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { swings: string[]; original?: typeof Element.prototype.animate };
  w.swings = [];
  w.original ??= Element.prototype.animate;
  const original = w.original;
  Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
    if (this.closest(".id-deck")) w.swings.push((this as HTMLElement).className);
    return original.apply(this, args);
  };
});
const swings = (page: Page) => page.evaluate(() => (window as unknown as { swings: string[] }).swings);

/** A test key (proofs/testing.ts's fake provider), signed outside the app and pasted back, from the deck's last card. */
async function addTestKey(peer: Peer) {
  const key = ed25519.utils.randomSecretKey();
  await addCard(peer.page).click();
  const add = peer.page.getByTestId("add-identity");
  await add.getByTestId("add-identity-fake-key").click();
  await choose(add.getByTestId("add-identity-signer"), "fake-tool");
  await add.getByTestId("add-identity-subject").fill(hex(ed25519.getPublicKey(key)));
  await add.getByTestId("add-identity-start").click();
  const statement = await add.getByTestId("add-identity-copy-0").textContent();
  await add.getByTestId("add-identity-paste").fill(b64url(ed25519.sign(new TextEncoder().encode(statement!), key)));
  await add.getByTestId("add-identity-finish").click();
  await expect(add).toHaveCount(0);
}

async function withTestIdentities(peer: Peer) {
  await peer.page.evaluate(() => localStorage.setItem("ghostly-test-identities", "1"));
  await injectNostrSigner(peer);
}

test("with a mouse the identities are a stack of ID cards: the pointer, a click, the keys and the arrows choose one, its panel follows, and the last card adds one", { tag: ["@feature:proofs.deck", "@feature:proofs.page"] }, async ({ peer }) => {
  const alice = await peer("iddeck-alice", { viewport: { width: 1280, height: 900 } });
  await withTestIdentities(alice);
  const { page } = alice;
  await page.evaluate(() => { location.hash = "#/identities"; });

  // None yet: the deck is a single blank card, which adds the first one.
  await expect(deck(page)).toHaveAttribute("data-mode", "stack");
  await expect(page.getByRole("tablist", { name: "Your identities" }).getByRole("tab")).toHaveCount(1);
  await expect(addCard(page)).toContainText("Add your first identity");
  await expect(page.getByTestId("identity-deck-next")).toHaveCount(0);
  await addNostrIdentity(alice);
  // The card just made comes up, with its details below.
  const nostr = byName(page, "Nostr");
  await chosen(page, nostr);
  await expect(nostr).toContainText("Your own key");
  await expect(nostr).toContainText("Verified");
  await expect(nostr.getByTestId("identity-proof-subject")).toContainText("npub1");
  await expect(panel(page).getByTestId("identity-panel-subject")).toHaveText(/^[0-9a-f]{64}$/);
  await expect(addCard(page)).toContainText("Add identity");

  await addTestKey(alice);
  const key = byName(page, "Test key");
  await chosen(page, key);
  await expect(panel(page)).toContainText("Test signature");
  const tabs = page.getByRole("tablist", { name: "Your identities" }).getByRole("tab");
  await expect(tabs).toHaveCount(3);
  expect(tiled(await strips(page))).toBe(true);

  // The pointer rests on the Nostr card's strip: it comes up, and its panel follows.
  await recordSwings(page);
  await nostr.hover();
  await chosen(page, nostr);
  await expect(panel(page).getByTestId("identity-panel-subject")).toHaveText(/^[0-9a-f]{64}$/);
  expect(tiled(await strips(page))).toBe(true);
  // It came up the way the wallet's cards do: a swing, the seal peeking in, a sheen; the other card tucked back.
  expect(await swings(page)).toEqual(expect.arrayContaining(["id-card-face", "id-card-seal", "id-card-sheen"]));
  // A card after the chosen one shows its trailing edge, with its provider's mark there.
  await expect(key.locator(".id-card-mark-end")).toBeVisible();
  await expect(nostr.locator(".id-card-mark-end")).toBeHidden();
  await page.mouse.move(5, 5);

  // A click, then the keys, going round at the ends.
  await key.click();
  await chosen(page, key);
  await key.focus();
  await page.keyboard.press("ArrowRight");
  await chosen(page, addCard(page));
  await expect(addCard(page)).toBeFocused();
  await expect(page.getByTestId("identity-add-open")).toBeVisible();
  // Coming up is not choosing: the dialog opens on Enter, not on the arrow.
  await expect(page.getByTestId("add-identity")).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await chosen(page, nostr);
  await page.keyboard.press("End");
  await chosen(page, addCard(page));
  await page.keyboard.press("Home");
  await chosen(page, nostr);

  // The arrows under the deck.
  await page.getByTestId("identity-deck-prev").click();
  await chosen(page, addCard(page));
  await page.getByTestId("identity-deck-next").click();
  await chosen(page, nostr);

  // Enter on the last card adds an identity.
  await addCard(page).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("add-identity")).toBeVisible();
  await page.getByTestId("add-identity").getByRole("button", { name: "Close" }).click();

  // Removing is the chosen card's.
  await key.click();
  await page.getByTestId("identity-proof-remove").click();
  await page.getByTestId("identity-proof-remove-confirm").click();
  await expect(page.getByTestId("identity-proof")).toHaveCount(1);
  await expect(tabs).toHaveCount(2);
  await chosen(page, nostr);
});

test("on a phone the ID cards are a snapping track: a swipe chooses the card at rest in the centre, and a tap on the last one adds an identity", { tag: ["@feature:proofs.deck", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  const alice = await peer("iddeck-phone", { mobile: true });
  await withTestIdentities(alice);
  const { page, context } = alice;
  await addNostrIdentity(alice);
  await expect(deck(page)).toHaveAttribute("data-mode", "track");
  const nostr = byName(page, "Nostr");
  await chosen(page, nostr);
  await expect.poll(() => offCentre(page, nostr)).toBeLessThan(3);

  // A finger drags the track to the left, past half a card, and lets go: the blank card settles in the centre and
  // becomes the chosen one.
  await swipe(context, page.locator(".id-deck-track"), -0.6);
  await chosen(page, addCard(page));
  await expect.poll(() => offCentre(page, addCard(page))).toBeLessThan(3);
  await expect(page.getByTestId("identity-add-open")).toBeVisible();

  // Tapping the card at the side brings it back, with its panel.
  await nostr.click();
  await chosen(page, nostr);
  await expect.poll(() => offCentre(page, nostr)).toBeLessThan(3);
  await expect(panel(page).getByTestId("identity-panel-subject")).toHaveText(/^[0-9a-f]{64}$/);

  // Tapping the last card adds an identity; the new one comes to the centre.
  await addTestKey(alice);
  const key = byName(page, "Test key");
  await chosen(page, key);
  await expect.poll(() => offCentre(page, key)).toBeLessThan(3);
  // Nothing scrolls sideways but the track itself.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.evaluate(() => { const body = document.querySelector("[data-page-body]")!; return body.scrollWidth <= body.clientWidth + 1; })).toBe(true);
});

test("with reduced motion the ID cards change at once", { tag: ["@feature:proofs.deck"] }, async ({ peer }) => {
  const alice = await peer("iddeck-still", { viewport: { width: 1280, height: 900 } });
  await alice.page.emulateMedia({ reducedMotion: "reduce" });
  await withTestIdentities(alice);
  const { page } = alice;
  await addNostrIdentity(alice);
  await recordSwings(page);
  await byName(page, "Nostr").focus();
  await page.keyboard.press("ArrowRight");
  await chosen(page, addCard(page));
  await page.keyboard.press("ArrowLeft");
  await chosen(page, byName(page, "Nostr"));
  expect(await swings(page)).toEqual([]);
  expect(await byName(page, "Nostr").locator("[data-deck=face]").evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
});
