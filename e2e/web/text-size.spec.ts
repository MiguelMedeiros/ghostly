import type { Locator, Page } from "@playwright/test";
import { setClipboard } from "../support/clipboard";
import { DEVICE_SET_PASSWORD } from "../support/devices";
import { expect, test } from "../support/fixtures";

/**
 * The browser's own text size (Chrome's Settings → Font size, a user style sheet) reaches the smallest text too: the
 * tab names, the identity card and the wordmark grow with the rest, and look as before at the default 16 px. On a
 * phone a Settings section's name shows in full in its header, at any text size.
 */
const PHONE = { width: 375, height: 667 };

/** The browser's default text size, as its settings set it (rem follows it). */
async function textSize(page: Page, px: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.setFontSizes", { fontSizes: { standard: px, fixed: Math.round(px * 13 / 16) } });
  await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(px);
}

/** The computed font size of the first element each selector finds, in px. */
function sizes(page: Page, selectors: readonly string[]): Promise<Record<string, number>> {
  return page.evaluate((selectors) => Object.fromEntries(selectors.map((selector) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`${selector} is not on the page`);
    return [selector, Math.round(parseFloat(getComputedStyle(element).fontSize) * 100) / 100];
  })), selectors);
}

async function useLanguage(page: Page, language: string): Promise<void> {
  await page.evaluate((language) => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
  }, language);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
}

/** The identity card's lines and the px sizes they had before (min, share of the card's width, max). */
const CARD_PX: Record<string, [number, number, number]> = {
  issuer: [8, 0.026, 10], status: [9, 0.028, 11], provider: [14, 0.055, 20], name: [11, 0.036, 13],
  subject: [10, 0.034, 12.5], field: [9, 0.03, 11], mrz: [8, 0.027, 10],
};
const card = (part: string) => `[data-testid="identities-page"] .id-card-face .id-card-${part}`;
const CARD = Object.keys(CARD_PX).map(card);

/** At 16 px each card line is the size the old px rule gives for the card's width now. */
async function expectCardAsBefore(page: Page, at16: Record<string, number>): Promise<void> {
  const width = await page.locator(card("issuer")).evaluate((element) => parseFloat(getComputedStyle(element).getPropertyValue("--card-w")));
  expect(width).toBeGreaterThan(0);
  for (const [part, [min, share, max]] of Object.entries(CARD_PX)) {
    expect(at16[card(part)], part).toBeCloseTo(Math.min(max, Math.max(min, width * share)), 1);
  }
}

/** At 16 px, what each looked like before its size followed the browser's, in px. */
const DESKTOP_AT_16: Record<string, number> = {
  ".account-label": 10,
  ".sidebar-wordmark": 17,
};
const PHONE_AT_16: Record<string, number> = {
  '[data-testid="mobile-tab-chats"] > span:last-child': 11,
};

function expectGrown(at16: Record<string, number>, at32: Record<string, number>): void {
  for (const [selector, size] of Object.entries(at16)) expect.soft(at32[selector], selector).toBeGreaterThanOrEqual(size * 2 - 0.01);
}

/** The card's lines on show, each inside the card and none over another (a larger text shows fewer lines instead). */
async function expectCardLinesApart(page: Page): Promise<void> {
  const lines = await page.locator('[data-testid="identities-page"] .id-card-face').first().evaluate((face) => {
    const edge = face.getBoundingClientRect();
    return [...face.querySelectorAll(".id-card-issuer, .id-card-provider, .id-card-name, .id-card-subject, .id-card-field, .id-card-mrz")]
      .map((line) => ({ line, box: line.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 1 && box.height > 1)
      .map(({ line, box }) => ({ part: line.className, top: Math.round(box.top - edge.top), bottom: Math.round(box.bottom - edge.top), height: Math.round(edge.height) }));
  });
  expect(lines.length).toBeGreaterThanOrEqual(2);
  for (const [i, line] of lines.entries()) {
    expect.soft(line.bottom, `${line.part} inside the card`).toBeLessThanOrEqual(line.height);
    if (i > 0) expect.soft(line.top, `${line.part} under ${lines[i - 1].part}`).toBeGreaterThanOrEqual(lines[i - 1].bottom);
  }
}

/** WCAG 1.4.12's text spacing, as the bookmarklets people use apply it (a reload drops it: apply it again). */
async function textSpacing(page: Page): Promise<void> {
  await page.addStyleTag({ content: "*{line-height:1.5 !important;letter-spacing:.12em !important;word-spacing:.16em !important}p{margin-bottom:2em !important}" });
}

test("with WCAG text spacing the identity card's lines show whole, at 1280, 640 and 320 px, in English, Portuguese and Arabic", { tag: ["@feature:app.accessibility", "@feature:proofs.page"] }, async ({ peer }) => {
  const { page } = await peer("text-spacing-card", { viewport: { width: 1280, height: 800 } });
  await page.getByTestId("account-identities").click();
  for (const language of ["en", "pt", "ar"]) {
    await useLanguage(page, language);
    for (const width of [1280, 640, 320]) {
      await page.setViewportSize({ width, height: width === 320 ? 640 : 800 });
      await expect(page.getByTestId("identities-page").locator(".id-card-face").first()).toBeVisible();
      await textSpacing(page);
      // The fields (what the card is, what contacts see, where it is shared): none cut, none drawn under the next.
      const cut = await page.getByTestId("identities-page").locator(".id-card-face").first().evaluate((face) =>
        [...face.querySelectorAll<HTMLElement>(".id-card-field")].filter((line) => line.getBoundingClientRect().width > 1)
          .filter((line) => line.scrollWidth > line.clientWidth || line.scrollHeight > line.clientHeight)
          .map((line) => `${line.textContent}: ${line.scrollWidth}/${line.clientWidth} wide, ${line.scrollHeight}/${line.clientHeight} tall`));
      expect(cut, `${language} at ${width} px`).toEqual([]);
      await expectCardLinesApart(page);
    }
  }
});

test("a desktop at a doubled text size: the account bar's names, the wordmark and the identity card grow with it", { tag: ["@feature:app.accessibility", "@feature:proofs.page"] }, async ({ peer }) => {
  const { page } = await peer("text-size-desktop", { viewport: { width: 1280, height: 800 } });
  await page.getByTestId("account-identities").click();
  await expect(page.getByTestId("identities-page").locator(".id-card-face").first()).toBeVisible();
  const selectors = [...Object.keys(DESKTOP_AT_16), ...CARD];

  const at16 = await sizes(page, selectors);
  for (const [selector, size] of Object.entries(DESKTOP_AT_16)) expect(at16[selector], selector).toBe(size);
  await expectCardAsBefore(page, at16);
  await expectCardLinesApart(page);

  await textSize(page, 32);
  const at32 = await sizes(page, selectors);
  expectGrown(at16, at32);
  await expectCardLinesApart(page);
});

test("a phone at 150% and 200% text size: New and Join stay on the screen at the top of the chat list, in English and Arabic", { tag: ["@feature:app.accessibility", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  // At 24px Join ran 48px past the right edge (past the left one in Arabic), at 32px off the screen whole.
  const { page } = await peer("text-size-header", { mobile: true, viewport: PHONE });
  for (const language of ["en", "ar"]) {
    await useLanguage(page, language);
    for (const px of [24, 32]) {
      await textSize(page, px);
      const join = page.getByRole("button", { name: language === "ar" ? "انضمام" : "Join chat" });
      // The header gives up a step a render after it measured: read once it has settled.
      await expect.poll(() => join.evaluate((button) => {
        const { left, right } = button.getBoundingClientRect();
        return left >= 0 && right <= window.innerWidth;
      }), `${language} at ${px}px`).toBe(true);
      for (const id of ["sidebar-new-chat", "sidebar-new-more", "app-brand"]) {
        const box = (await page.getByTestId(id).boundingBox())!;
        expect(box.x, `${id}, ${language} at ${px}px`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${id}, ${language} at ${px}px`).toBeLessThanOrEqual(PHONE.width);
      }
    }
    await textSize(page, 16);
  }
  // At the default size the wordmark is back beside the ghost.
  await expect(page.locator(".sidebar-wordmark")).toBeVisible();
});

test("a phone at a doubled text size: the tab names and the identity card grow, and a Settings section's name shows in full", { tag: ["@feature:app.accessibility", "@feature:app.mobile-layout", "@feature:settings.sections"] }, async ({ peer }) => {
  const { page } = await peer("text-size-phone", { mobile: true, viewport: PHONE });
  await page.getByTestId("mobile-tab-identities").click();
  await expect(page.getByTestId("identities-page").locator(".id-card-face").first()).toBeVisible();
  const selectors = [...Object.keys(PHONE_AT_16), ...CARD];

  const at16 = await sizes(page, selectors);
  for (const [selector, size] of Object.entries(PHONE_AT_16)) expect(at16[selector], selector).toBe(size);
  await expectCardAsBefore(page, at16);
  await expectCardLinesApart(page);

  await textSize(page, 32);
  const at32 = await sizes(page, selectors);
  expectGrown(at16, at32);
  await expectCardLinesApart(page);

  // The section's name, whole, in the header (the page's only heading on screen there), in each language's length.
  for (const [language, name] of [["pt", "Privacidade e segurança"], ["en", "Privacy & security"], ["ar", "الخصوصية والأمان"]]) {
    await useLanguage(page, language);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe("32px");
    await page.getByTestId("mobile-tab-settings").click();
    await page.getByTestId("settings-open-privacy").click();
    const title = page.getByRole("heading", { level: 1, name });
    await expect(title).toBeVisible();
    const cut = await title.evaluate((h1) => ({ wide: h1.scrollWidth - h1.clientWidth, tall: h1.scrollHeight - h1.clientHeight }));
    expect(cut, `${language}: the header's title is cut`).toEqual({ wide: 0, tall: 0 });
    // Nothing pushed out sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), language).toBeLessThanOrEqual(0);
    await page.goBack();
  }
});

test("a phone at 200% text size: Profile's row buttons wrap their words inside the screen, and the page does not scroll sideways", { tag: ["@feature:app.accessibility", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  // In Portuguese "Adicionar este dispositivo" ran from 7 to 389 px on a 375 px screen, and the page shifted 25 px.
  const { page } = await peer("text-size-profile", { mobile: true, viewport: PHONE });
  await page.goto("/#/profile");
  await textSize(page, 32);
  for (const language of ["pt", "it", "es", "fr", "ja"]) {
    await useLanguage(page, language);
    await expect(page.getByTestId("device-add-open")).toBeEnabled();
    await expect(page.getByTestId("backup-open")).toBeVisible();
    const out = await page.getByTestId("profile-page").locator("section button").evaluateAll((buttons) => buttons
      .map((button) => ({ button, box: button.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 1 && box.height > 1)
      .filter(({ box }) => box.left < 0 || box.right > window.innerWidth)
      .map(({ button, box }) => `${button.textContent}: ${Math.round(box.left)}..${Math.round(box.right)}`));
    expect(out, `${language}: buttons past the screen`).toEqual([]);
    const sections = await page.getByTestId("profile-page").locator("section").evaluateAll((sections) =>
      sections.map((section) => Math.round(section.getBoundingClientRect().left)).filter((left) => left < 0));
    expect(sections, `${language}: sections pushed off the screen`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), language).toBeLessThanOrEqual(0);
  }
});

/** Each of the rows' names cut sideways, as "name: scrollWidth/clientWidth". */
function cutNames(rows: ReturnType<Page["locator"]>, name: string): Promise<string[]> {
  return rows.evaluateAll((rows, name) => rows.map((row) => row.querySelector<HTMLElement>(name)!)
    .filter((label) => label.scrollWidth > label.clientWidth)
    .map((label) => `${label.textContent}: ${label.scrollWidth}/${label.clientWidth}`), name);
}

/** The rows' hints (the line under a name) cut short, theirs or any part's inside, as "words: scrollWidth/clientWidth". */
function cutHints(rows: Locator): Promise<string[]> {
  return rows.evaluateAll((rows) => rows.flatMap((row) => {
    const hint = row.querySelector<HTMLElement>(":scope > span.flex-1 > span:nth-child(2)");
    return hint ? [hint, ...hint.querySelectorAll<HTMLElement>("*")] : [];
  }).filter((part) => part.scrollWidth > part.clientWidth)
    .map((part) => `${part.textContent}: ${part.scrollWidth}/${part.clientWidth}`));
}

/** The dialog's buttons whose words run past their edges, or past the dialog's, as "words: scrollWidth/clientWidth". */
function cutButtons(dialog: Locator): Promise<string[]> {
  return dialog.evaluate((dialog) => {
    const edge = dialog.getBoundingClientRect();
    const cut = [...dialog.querySelectorAll<HTMLElement>("button, label")].filter((button) => {
      const box = button.getBoundingClientRect();
      return box.width > 1 && (button.scrollWidth > button.clientWidth || box.left < edge.left || box.right > edge.right);
    }).map((button) => `${button.textContent!.trim()}: ${button.scrollWidth}/${button.clientWidth}`);
    return dialog.scrollWidth > dialog.clientWidth ? [...cut, `the dialog: ${dialog.scrollWidth}/${dialog.clientWidth}`] : cut;
  });
}

test("a phone at 150% and 200% text size: adding a device, the new device's first buttons and the check's two keep their words inside them, in Italian", { tag: ["@feature:app.accessibility", "@feature:app.mobile-layout", "@feature:devices.screens"] }, async ({ peer }) => {
  // At 24px "Corrispondono" ran 14px past its button and "Scansiona QR" 6px past its own; at 32px the dialog scrolled sideways.
  const [active, added] = await Promise.all([peer("text-size-active", { mobile: true, viewport: PHONE }), peer("text-size-added", { mobile: true, viewport: PHONE })]);
  await useLanguage(active.page, "it");
  await useLanguage(added.page, "it");

  // The new device: I already use Ghostly, Add this device to my profile.
  await added.page.getByTestId("sidebar-already").click();
  await added.page.getByTestId("device-join-add").click();
  const join = added.page.getByRole("dialog");
  await expect(join.getByRole("button", { name: "Scansiona QR" })).toBeVisible();
  for (const px of [24, 32]) {
    await textSize(added.page, px);
    expect.soft(await cutButtons(join), `the new device's first screen at ${px}px`).toEqual([]);
  }
  await textSize(added.page, 16);

  await active.page.goto("/#/profile");
  await active.page.getByTestId("device-add-open").click();
  const add = active.page.getByTestId("device-add");
  await add.getByTestId("device-add-password").fill(DEVICE_SET_PASSWORD);
  await add.getByTestId("device-add-password-again").fill(DEVICE_SET_PASSWORD);
  await add.getByTestId("device-add-next").click();
  const code = (await add.getByTestId("device-add-code").getAttribute("data-code"))!;
  await setClipboard(added.page, code);
  await join.getByRole("button", { name: "Incolla dagli appunti" }).click();
  await added.page.getByTestId("device-join-name").fill("Phone");
  await added.page.getByTestId("device-join-next").click();
  await expect(add.getByTestId("device-add-digits")).toBeVisible();
  for (const px of [24, 32]) {
    await textSize(active.page, px);
    expect.soft(await cutButtons(add), `the check at ${px}px`).toEqual([]);
  }
});

test("a phone at a larger text size: Settings' sections (their names and what they hold), its search results and the identity kinds wrap their words instead of cutting them", { tag: ["@feature:app.accessibility", "@feature:app.mobile-layout", "@feature:settings.sections"] }, async ({ peer }) => {
  const { page } = await peer("text-size-names", { mobile: true, viewport: PHONE });
  await textSize(page, 24);
  for (const language of ["fr", "ja", "ar"]) {
    await useLanguage(page, language);
    await page.getByTestId("mobile-tab-settings").click();
    const sections = page.locator('[data-testid^="settings-open-"]');
    await expect(sections.first()).toBeVisible();
    expect(await cutNames(sections, ":scope > span.flex-1 > span:first-child"), `${language}: Settings' sections`).toEqual([]);
    // What each section holds, under its name: wrapped too (Media's, Privacy's and Network's are the long ones).
    expect(await cutHints(sections), `${language}: Settings' section descriptions`).toEqual([]);
    await page.getByTestId("settings-search").fill(language === "ja" ? "プ" : language === "ar" ? "ال" : "e");
    const results = page.getByTestId("settings-search-result");
    await expect(results.first()).toBeVisible();
    expect(await cutNames(results, ":scope > span.flex-1 > span:first-child"), `${language}: Settings' search results`).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), language).toBeLessThanOrEqual(0);

    await page.getByTestId("mobile-tab-identities").click();
    await page.getByTestId("identities-new").click();
    const kinds = page.getByTestId("add-identity").locator('[data-testid^="add-identity-card-"]');
    await expect(kinds.first()).toBeVisible();
    expect(await cutNames(kinds, 'span[dir="auto"]'), `${language}: the identity kinds`).toEqual([]);
  }
});
