import { expect, test } from "../support/fixtures";

/**
 * A field low on a phone page, and the keyboard coming up over it. Playwright has no keyboard to open: the
 * viewport loses an iPhone keyboard's height (336px) while the field has the focus, as the page sees it once
 * the keyboard is up.
 */
const PHONE = { width: 390, height: 844 };
const KEYBOARD = 336;

test("on a phone: a field the keyboard comes up over is brought into view", { tag: ["@feature:app.mobile-layout", "@feature:settings.network.relays"] }, async ({ peer }) => {
  const { page } = await peer("alice", { mobile: true, viewport: PHONE });
  await page.goto("/#/settings/network");
  await expect(page.getByTestId("network-relays")).toBeVisible();
  // A field below where the keyboard will reach, on screen until then.
  const inputs = page.locator("input[type=text], input:not([type])");
  const low = await inputs.evaluateAll((all, reach) => all.findIndex((input) => {
    const box = input.getBoundingClientRect();
    return box.top > reach + 10 && box.bottom < innerHeight;
  }), PHONE.height - KEYBOARD);
  expect(low).toBeGreaterThanOrEqual(0);
  const field = inputs.nth(low);
  await field.focus();
  await page.setViewportSize({ width: PHONE.width, height: PHONE.height - KEYBOARD });
  await expect(page.locator("html")).toHaveAttribute("data-keyboard", "true");
  await expect.poll(async () => { const box = (await field.boundingBox())!; return box.y >= 0 && box.y + box.height <= PHONE.height - KEYBOARD; }).toBe(true);
  await expect(field).toBeFocused();

  // A field already in view does not move.
  await field.blur();
  await page.setViewportSize(PHONE);
  const top = page.getByTestId("network-relays");
  await top.scrollIntoViewIfNeeded();
  const before = (await top.boundingBox())!.y;
  await top.focus();
  await page.setViewportSize({ width: PHONE.width, height: PHONE.height - KEYBOARD });
  await expect(page.locator("html")).toHaveAttribute("data-keyboard", "true");
  await page.waitForTimeout(200);
  expect((await top.boundingBox())!.y).toBe(before);
});
