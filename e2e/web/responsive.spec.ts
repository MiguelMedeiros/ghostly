import type { Page } from "@playwright/test";
import { createWallet, expect, openWallet, test, useFakeProviders, useTestnet, walletCard } from "../support/fixtures";
import { mockMainnetMints } from "../support/mint";
import { choose } from "../support/select";
import { addNostrIdentity, injectNostrSigner } from "../support/nostrSigner";
import { pair } from "../support/paired";
import { composerRow } from "../support/composer";
import { closePayments, openPayments } from "../support/payments";

/**
 * The pages beside the chat list (Wallet, Services, Settings, Profile, Identities) at every width they are shown at:
 * a wide desktop, a desktop narrowing down to two tight columns, and a phone. On a desktop the page's
 * column can be as narrow as a phone, so nothing here may depend on the window's width.
 *
 * What is checked, on every page and every state opened: nothing sticks out sideways (the window, the
 * page's scrolling column, a button or a field past the page's edge), and no text is squeezed into a
 * column a letter or two wide.
 */

const WIDTHS = [
  { name: "desktop 1440", viewport: { width: 1440, height: 900 } },
  { name: "desktop 1100", viewport: { width: 1100, height: 900 } },
  { name: "desktop 900", viewport: { width: 900, height: 900 } },
  { name: "desktop 768", viewport: { width: 768, height: 900 } },
  { name: "phone 390", mobile: true },
] as const;

/** Every problem on the page right now, in words; empty when the layout holds. */
async function layoutProblems(page: Page, root: string): Promise<string[]> {
  return page.evaluate((selector) => {
    const problems: string[] = [];
    const describe = (el: Element) => `${el.tagName.toLowerCase()}${el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : ""} "${(el.textContent ?? "").trim().slice(0, 40)}"`;
    const visible = (el: Element) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    const doc = document.documentElement;
    if (doc.scrollWidth > window.innerWidth + 1) problems.push(`the window scrolls sideways: ${doc.scrollWidth} > ${window.innerWidth}`);
    const pageRoot = document.querySelector(selector);
    if (!pageRoot) return [`${selector} is not on the page`];
    const edge = pageRoot.getBoundingClientRect();
    const body = pageRoot.querySelector("[data-page-body]");
    if (body && body.scrollWidth > body.clientWidth + 1) problems.push(`the page's column scrolls sideways: ${body.scrollWidth} > ${body.clientWidth}`);

    // A control inside something made to scroll sideways (the wallet deck's track) may rest past the edge; the scroller itself may not.
    const scroller = (el: Element) => { for (let p = el.parentElement; p && p !== pageRoot; p = p.parentElement) { const s = getComputedStyle(p); if ((s.overflowX === "auto" || s.overflowX === "scroll") && p.scrollWidth > p.clientWidth + 1) return p; } return null; };
    for (const el of pageRoot.querySelectorAll("button, a, input, select, textarea, [role=radio], [role=switch]")) {
      if (!visible(el)) continue;
      const box = scroller(el) ?? el;
      const r = box.getBoundingClientRect();
      if (r.left < edge.left - 1 || r.right > edge.right + 1) problems.push(`${describe(el)} is cut off: ${Math.round(r.left)}–${Math.round(r.right)} outside ${Math.round(edge.left)}–${Math.round(edge.right)}`);
    }

    // A text squeezed into a sliver wraps a letter or two per line: narrow, and many lines tall.
    const walker = document.createTreeWalker(pageRoot, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? "").trim();
      const el = node.parentElement;
      if (text.length < 6 || !el || !visible(el)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
      const width = el.getBoundingClientRect().width;
      if (width < 56 && lines > 2) problems.push(`${describe(el)} is squeezed to ${Math.round(width)}px wide, ${lines} lines`);
      // Only an address or a key may break anywhere; words are never split into more lines than letters allow.
      if (lines > Math.max(3, text.length / 3)) problems.push(`${describe(el)} breaks into ${lines} lines for ${text.length} characters`);
    }
    return problems;
  }, root);
}

/**
 * What is wrong with the chosen card of every deck under `root` (wallet cards, ID cards): a line of text that runs out
 * of its box without an ellipsis, text outside the card, two lines of text on top of each other, or text under the
 * ID card's photo or seal. A card chooses what it shows by its own width, so this holds at every width.
 */
/** A deck's switch has played out (the card's swing, its seal peeking in), so what is measured is the card at rest. */
const deckSettled = (page: Page, deck: string) => page.locator(deck).first().evaluate(el => Promise.all(el.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {}))));

async function deckCardProblems(page: Page, root: string): Promise<string[]> {
  return page.evaluate((selector) => {
    const problems: string[] = [];
    const shown = (el: Element) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0; };
    const overlap = (a: DOMRect, b: DOMRect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2;
    for (const face of document.querySelectorAll(`${selector} .deck-card[data-active=true] [data-deck=face]`)) {
      const card = face.getBoundingClientRect(), name = (face.closest("[data-testid]")?.getAttribute("data-testid") ?? "card") + ` ${Math.round(card.width)}px`;
      // The elements that hold a line of text themselves, as shown.
      const lines = [...face.querySelectorAll<HTMLElement>("*")].filter(el => shown(el) && [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent!.trim()) && !el.closest("[aria-hidden=true]"));
      // Where the text itself is drawn (its box may be padded clear of the seal).
      const ink = (el: Element) => { const range = document.createRange(); range.selectNodeContents(el); const r = range.getBoundingClientRect(); const right = el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight); return new DOMRect(r.left, r.top, Math.min(r.right, right) - r.left, r.height); };
      for (const el of lines) {
        const r = ink(el), s = getComputedStyle(el), text = `"${el.textContent!.trim().slice(0, 30)}"`;
        if (el.scrollWidth > el.clientWidth + 1 && s.textOverflow !== "ellipsis") problems.push(`${name}: ${text} runs out of its box without an ellipsis`);
        if (r.left < card.left - 1 || r.right > card.right + 1 || r.top < card.top - 1 || r.bottom > card.bottom + 1) problems.push(`${name}: ${text} is outside the card`);
        for (const decor of face.querySelectorAll(".id-card-photo, .id-card-seal")) if (shown(decor) && overlap(r, decor.getBoundingClientRect())) problems.push(`${name}: ${text} runs under ${decor.className}`);
      }
      lines.forEach((a, i) => lines.slice(i + 1).forEach(b => {
        if (!a.contains(b) && !b.contains(a) && overlap(ink(a), ink(b))) problems.push(`${name}: "${a.textContent!.trim().slice(0, 20)}" and "${b.textContent!.trim().slice(0, 20)}" overlap`);
      }));
    }
    return problems;
  }, root);
}

async function expectTidy(page: Page, root: string, what: string): Promise<void> {
  await page.waitForTimeout(250); // Let a panel's fade-in and a late balance settle.
  expect(await layoutProblems(page, root), `${what} at ${page.viewportSize()?.width}px`).toEqual([]);
  expect(await deckCardProblems(page, root), `${what}'s cards at ${page.viewportSize()?.width}px`).toEqual([]);
}

for (const width of WIDTHS) {
  test(`the right-hand pages hold together: ${width.name}`, { tag: ["@feature:app.responsive"] }, async ({ peer }) => {
    const alice = await peer("alice", "mobile" in width ? { mobile: true } : { viewport: width.viewport });
    const { page } = alice;
    await mockMainnetMints(alice.context);
    await useFakeProviders(alice);

    await page.goto("/#/wallet");
    await expect(page.getByTestId("wallet")).toBeVisible();
    // A new profile has no wallet: the first-run choice holds together, and New stays inside the header bar.
    await expect(page.getByTestId("wallet-first")).toBeVisible();
    await expectTidy(page, "[data-testid=wallet]", "the first-run wallet page");
    const header = await page.getByTestId("wallet").locator("header").boundingBox();
    const add = await page.getByTestId("wallet-add").boundingBox();
    expect(add!.x + add!.width).toBeLessThanOrEqual(header!.x + header!.width + 1);
    await page.getByTestId("wallet-add").click();
    await expectTidy(page, "[data-testid=new-wallet]", "the New wallet dialog");
    await page.keyboard.press("Escape");
    // The wallets that need no outside service: Cashu on both networks (the Mainnet mints answered by the suite's
    // own), the Lightning of each, and a fake Testnet Bitcoin wallet. Ark, Bark, Spark, USDT and Fedimint need
    // their servers (public test networks, or the gated regtest stack): their own specs cover their panels.
    await createWallet(alice, "cashu", "testnet");
    await createWallet(alice, "cashu", "mainnet");
    await createWallet(alice, "bitcoin", "testnet", { provider: "fake-onchain", fill: async (form) => {
      await form.getByLabel("Access token").fill("token");
      await form.getByTestId("provider-save").click();
    } });
    for (const card of ["cashu-mainnet", "cashu-testnet", "lightning-mainnet", "lightning-testnet", "bitcoin-testnet"] as const) {
      await openWallet(alice, card);
      await expectTidy(page, "[data-testid=wallet]", `the ${card} wallet`);
    }
    await openWallet(alice, "cashu-testnet");
    await expect(page.getByTestId("mint-row").first()).toBeVisible();
    for (const tab of ["wallet-send", "wallet-history"]) {
      await page.getByTestId(tab).click();
      await expectTidy(page, "[data-testid=wallet]", `the Cashu ${tab}`);
    }

    await page.goto("/#/services");
    await expect(page.getByTestId("my-services")).toBeVisible();
    await expectTidy(page, "[data-testid=my-services]", "Services");

    await page.goto("/#/settings");
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await page.getByRole("switch", { name: "Lock Screen" }).click(); // opens the password form
    await expectTidy(page, "[data-testid=settings-page]", "Settings");
    // Every ⓘ open: the longest the rows get.
    for (const more of await page.getByTestId("row-info").all()) await more.click();
    await expectTidy(page, "[data-testid=settings-page]", "Settings, every ⓘ open");

    await page.goto("/#/settings/advanced");
    await expect(page.getByTestId("settings-advanced-page")).toBeVisible();
    for (const more of await page.getByTestId("row-info").all()) await more.click();
    await expectTidy(page, "[data-testid=settings-advanced-page]", "Settings, Advanced");

    await page.goto("/#/profile");
    await expect(page.getByTestId("profile-page")).toBeVisible();
    for (const open of ["backup-open", "restore-open", "s3-setup"]) {
      await page.getByTestId(open).click();
      await expectTidy(page, "[data-testid=profile-page]", `Profile, ${open}`);
    }
    await page.getByTestId("profile-new").click();
    await expectTidy(page, "[data-testid=profile-page]", "Profile, a new profile");

    await page.goto("/#/identities");
    await expect(page.getByTestId("identities-page")).toBeVisible();
    await expectTidy(page, "[data-testid=identities-page]", "Identities");
    // Adding an identity: the dialog holds together too (Nostr, remote signer: no extension in this page).
    await page.getByTestId("identities-new").click();
    await expectTidy(page, "[data-testid=add-identity]", "Identities, choosing an identity");
    await page.getByTestId("add-identity-nostr").click();
    await expect(page.getByTestId("add-identity-field-bunker")).toBeVisible();
    await expectTidy(page, "[data-testid=add-identity]", "Identities, adding an identity");
    await page.getByRole("button", { name: "Close" }).click();

    // Five places under the list (or in the phone's tab bar): each one inside the bar and easy to tap, and a
    // label is shown whole or not at all.
    await expect(await navProblems(page)).toEqual([]);
  });
}

/** What is wrong with the account bar (desktop) or the tab bar (phone): items outside it, too small to tap, cut labels. */
async function navProblems(page: Page): Promise<string[]> {
  const bar = page.getByTestId("account-bar").or(page.getByTestId("mobile-tabs"));
  await expect(bar).toBeVisible();
  return bar.evaluate((nav) => {
    const problems: string[] = [];
    const edge = nav.getBoundingClientRect();
    // The places themselves: the account switcher's chevron rides on Profile's corner and is not one.
    const items = [...nav.querySelectorAll("button:not(.profile-switcher-chevron)")];
    if (items.length !== 5) problems.push(`${items.length} items, not 5`);
    for (const item of items) {
      const r = item.getBoundingClientRect(), name = item.getAttribute("aria-label") ?? item.textContent;
      if (r.width < 40 || r.height < 40) problems.push(`${name} is ${Math.round(r.width)}×${Math.round(r.height)}`);
      if (r.left < edge.left - 1 || r.right > edge.right + 1) problems.push(`${name} sticks out of the bar`);
      for (const label of item.querySelectorAll<HTMLElement>(".account-label, .truncate")) {
        if (label.offsetWidth > 0 && getComputedStyle(label).visibility !== "hidden" && label.scrollWidth > label.clientWidth + 1) problems.push(`${name}: the label "${label.textContent}" is cut`);
      }
    }
    return problems;
  });
}

test("the account bar keeps its five places at the list's narrowest", { tag: ["@feature:app.sidebar-resize", "@feature:app.responsive", "@feature:proofs.page"] }, async ({ peer }) => {
  const { page } = await peer("alice", { viewport: { width: 1440, height: 900 } });
  await page.goto("/#/identities");
  const handle = (await page.getByTestId("sidebar-resize").boundingBox())!;
  await page.mouse.move(handle.x + 1, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(0, handle.y + 100, { steps: 5 });
  await page.mouse.up();
  expect(Math.round((await page.getByTestId("account-bar").boundingBox())!.width)).toBeLessThanOrEqual(281);
  expect(await navProblems(page)).toEqual([]);
  await expectTidy(page, "[data-testid=identities-page]", "Identities beside the narrowest list");
  // The account switcher fits the narrowest list: inside it, every line tall enough to tap, no name cut short of a word.
  await page.getByTestId("account-profile").click();
  const bar = (await page.getByTestId("account-bar").boundingBox())!;
  const menu = (await page.getByTestId("profile-switcher").boundingBox())!;
  expect(menu.x).toBeGreaterThanOrEqual(bar.x);
  expect(menu.x + menu.width).toBeLessThanOrEqual(bar.x + bar.width + 1);
  expect(menu.y).toBeGreaterThanOrEqual(0);
  for (const line of await page.getByTestId("profile-switcher").locator("[role^=menuitem]").all()) expect((await line.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  await page.keyboard.press("Escape");
  // In Portuguese too, whose labels are longer.
  await page.getByTestId("account-settings").click();
  await choose(page.getByTestId("settings-language"), "pt");
  await expect(page.getByTestId("account-identities")).toHaveAccessibleName("Identidades");
  expect(await navProblems(page)).toEqual([]);
  // "Configurações" does not fit in a fifth of 280px: the labels step aside together, the icons stay.
  await expect(page.getByRole("navigation", { name: "Account" })).toHaveAttribute("data-compact", "true");
});

test("the page keeps a phone's width however wide the chat list is dragged", { tag: ["@feature:app.sidebar-resize", "@feature:app.responsive", "@feature:wallet.deck", "@feature:proofs.deck"] }, async ({ peer }) => {
  const alice = await peer("alice", { viewport: { width: 900, height: 900 } });
  const { page } = alice;
  await injectNostrSigner(alice);
  await addNostrIdentity(alice);
  await page.goto("/#/wallet");
  await useTestnet(alice);
  const handle = (await page.getByTestId("sidebar-resize").boundingBox())!;
  await page.mouse.move(handle.x + 1, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(890, handle.y + 100, { steps: 5 });
  await page.mouse.up();
  const column = (await page.getByTestId("wallet").boundingBox())!;
  expect(column.width).toBeGreaterThanOrEqual(319);
  // Too narrow for a stack of readable cards, even with a mouse: the snapping track, one card whole in the centre.
  await expect(page.getByTestId("wallet").locator(".wallet-deck")).toHaveAttribute("data-mode", "track");
  await walletCard(page, "cashu-testnet").click();
  await expect(page.getByTestId("mint-row").first()).toBeVisible();
  await expectTidy(page, "[data-testid=wallet]", "the wallet beside the widest list");
  await page.goto("/#/identities");
  await expect(page.locator(".id-deck")).toHaveAttribute("data-mode", "track");
  // The page opens on the Ghostly card: the click brings the proof's card up, and its swing (the seal peeking in) must
  // have played out before the card is measured.
  await page.getByTestId("identity-proof").click();
  await deckSettled(page, ".id-deck");
  await expectTidy(page, "[data-testid=identities-page]", "an ID card beside the widest list");
  await page.goto("/#/settings");
  await expectTidy(page, "[data-testid=settings-page]", "Settings beside the widest list");
});

test("the chat's pickers stay inside the chat's column beside the widest list, their cards readable", { tag: ["@feature:app.sidebar-resize", "@feature:app.responsive", "@feature:payments.chat.cards", "@feature:proofs.composer"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice", { viewport: { width: 900, height: 900 } }), peer("bob")]);
  await injectNostrSigner(alice);
  // Cards to pay with: a Testnet Cashu wallet each (a new profile has none), made before they pair.
  for (const p of [alice, bob]) await useTestnet(p);
  await pair(alice, bob);
  const { page } = alice;
  const chat = page.url();
  await addNostrIdentity(alice);
  await page.goto(chat);
  const handle = (await page.getByTestId("sidebar-resize").boundingBox())!;
  await page.mouse.move(handle.x + 1, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(890, handle.y + 100, { steps: 5 });
  await page.mouse.up();
  const column = (await page.locator(".composer-safe").boundingBox())!;
  for (const [button, sheet] of [["payment-button", "payment-composer"], ["composer-identities-button", "composer-identities"]] as const) {
    const row = await composerRow(page, button);
    await expect(row).toBeEnabled({ timeout: 60_000 });
    await row.click();
    const box = (await page.getByTestId(sheet).boundingBox())!;
    expect(box.x, `${sheet} inside the chat's column`).toBeGreaterThanOrEqual(column.x - 1);
    expect(box.x + box.width, `${sheet} inside the chat's column`).toBeLessThanOrEqual(column.x + column.width + 1);
    await page.waitForTimeout(250);
    expect(await deckCardProblems(page, `[data-testid=${sheet}]`), `${sheet}'s cards`).toEqual([]);
    await page.keyboard.press("Escape");
  }
});

/** Whether a control can be used where it is, without scrolling: in the window, and what a click there lands on. */
const reachable = (page: Page, testId: string) => page.getByTestId(testId).evaluate((el) => {
  const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return r.top >= 0 && r.bottom <= innerHeight && !!hit && (hit === el || el.contains(hit));
});

test("the payment sheet fits a short window: its head in view, Use and Save in reach, the rest scrolls", { tag: ["@feature:app.responsive", "@feature:payments.chat.cards", "@feature:payments.chat.methods"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice", { viewport: { width: 1100, height: 900 } }), peer("bob")]);
  // Cards to pay with and accept: Testnet Cashu and its Lightning each (a new profile has none), made before they pair.
  for (const p of [alice, bob]) await useTestnet(p);
  await pair(alice, bob);
  const { page } = alice;
  // A laptop split in two, then a narrow side panel the height of the extension's.
  for (const viewport of [{ width: 1100, height: 420 }, { width: 380, height: 560 }]) {
    await page.setViewportSize(viewport);
    const sheet = await openPayments(page);
    const where = `${viewport.width}x${viewport.height}`;
    expect((await sheet.boundingBox())!.y, `the sheet's top in the window at ${where}`).toBeGreaterThanOrEqual(0);
    await expect.poll(() => reachable(page, "payment-mode-accept"), `Accept at ${where}`).toBe(true);
    await expect.poll(() => reachable(page, "payment-use"), `Use at ${where}`).toBe(true);
    await openPayments(page, "accept");
    await expect.poll(() => reachable(page, "payment-accept-save"), `Save at ${where}`).toBe(true);
    // Save works where it is: a way turned off, saved, and on again.
    for (const on of ["false", "true"]) {
      await page.getByTestId("payment-accept-deck-next").click();
      const current = sheet.locator("[role=switch][data-active=true]");
      await current.press("Space");
      await expect(current).toHaveAttribute("aria-checked", on);
      await page.getByTestId("payment-accept-save").click();
      await expect(page.getByTestId("payment-accept-status")).toHaveAttribute("data-state", "saved");
      await page.getByTestId("payment-accept-deck-prev").click();
    }
    await closePayments(page);
  }
});
