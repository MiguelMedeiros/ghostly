import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";

/**
 * The pages beside the chat list (Wallet, Services, Settings, Profile) at every width they are shown at:
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

async function expectTidy(page: Page, root: string, what: string): Promise<void> {
  await page.waitForTimeout(250); // Let a panel's fade-in and a late balance settle.
  expect(await layoutProblems(page, root), `${what} at ${page.viewportSize()?.width}px`).toEqual([]);
}

for (const width of WIDTHS) {
  test(`the right-hand pages hold together: ${width.name}`, { tag: ["@feature:app.responsive"] }, async ({ peer }) => {
    const { page } = await peer("alice", "mobile" in width ? { mobile: true } : { viewport: width.viewport });

    await page.goto("/#/wallet");
    await expect(page.getByTestId("wallet")).toBeVisible();
    // The Mainnet/Testnet switch stays inside the header bar.
    const header = await page.getByTestId("wallet").locator("header").boundingBox();
    const mode = await page.getByTestId("wallet-mode").boundingBox();
    expect(mode!.x + mode!.width).toBeLessThanOrEqual(header!.x + header!.width + 1);
    for (const card of ["cashu", "lightning", "arkade", "bark", "usdt", "bitcoin"] as const) {
      await page.getByTestId(`wallet-card-${card}`).click();
      await expectTidy(page, "[data-testid=wallet]", `the ${card} wallet`);
    }
    await page.getByTestId("wallet-card-cashu").click();
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

    await page.goto("/#/profile");
    await expect(page.getByTestId("profile-page")).toBeVisible();
    for (const open of ["backup-open", "restore-open", "s3-setup"]) {
      await page.getByTestId(open).click();
      await expectTidy(page, "[data-testid=profile-page]", `Profile, ${open}`);
    }
    await page.getByTestId("profile-new").click();
    await expectTidy(page, "[data-testid=profile-page]", "Profile, a new profile");
    // Adding an identity: the dialog holds together too (Nostr, remote signer: no extension in this page).
    await page.getByTestId("identity-add").click();
    await expectTidy(page, "[data-testid=add-identity]", "Profile, choosing an identity");
    await page.getByTestId("add-identity-nostr").click();
    await expect(page.getByTestId("add-identity-field-bunker")).toBeVisible();
    await expectTidy(page, "[data-testid=add-identity]", "Profile, adding an identity");
  });
}

test("the page keeps a phone's width however wide the chat list is dragged", { tag: ["@feature:app.sidebar-resize", "@feature:app.responsive"] }, async ({ peer }) => {
  const { page } = await peer("alice", { viewport: { width: 900, height: 900 } });
  await page.goto("/#/wallet");
  const handle = (await page.getByTestId("sidebar-resize").boundingBox())!;
  await page.mouse.move(handle.x + 1, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(890, handle.y + 100, { steps: 5 });
  await page.mouse.up();
  const column = (await page.getByTestId("wallet").boundingBox())!;
  expect(column.width).toBeGreaterThanOrEqual(319);
  await page.getByTestId("wallet-card-cashu").click();
  await expect(page.getByTestId("mint-row").first()).toBeVisible();
  await expectTidy(page, "[data-testid=wallet]", "the wallet beside the widest list");
  await page.goto("/#/settings");
  await expectTidy(page, "[data-testid=settings-page]", "Settings beside the widest list");
});
