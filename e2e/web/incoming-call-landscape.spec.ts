import type { Page } from "@playwright/test";
import { connect, expect, link, test } from "../support/fixtures";

/**
 * An incoming call on a phone on its side. Under the `md` width it takes the whole screen with 5rem of padding above and
 * 4rem below, whatever the height: while on a call (End and answer and Decline, each named under its button) the
 * content was 364 px high, so at 568x320 the buttons were cut by 20 px and their words not shown, and at 640x360 the
 * words were cut by 4 px. The screen did not scroll. Measured: the buttons and their words below the screen's bottom.
 */
const cut = (page: Page) => page.getByTestId("incoming-call").evaluate((ring) => {
  const height = window.innerHeight;
  return [...ring.querySelectorAll("button, span[aria-hidden=true]")].map((part) => [part, part.getBoundingClientRect()] as const)
    .filter(([, r]) => r.height > 0 && r.bottom > height)
    .map(([part, r]) => `${part.getAttribute("aria-label") ?? part.textContent} at ${Math.round(r.top)}..${Math.round(r.bottom)} of ${height}`);
});

const sides = [{ width: 568, height: 320 }, { width: 640, height: 360 }, { width: 667, height: 375 }];

test("a call ringing on a phone on its side, plain and while on a call: its buttons and their words fit the screen", { tag: ["@feature:calls.end-and-answer", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  const [alice, bob, carol] = await Promise.all([peer("side-alice"), peer("side-bob"), peer("side-carol")]);
  await link(alice, bob);
  await connect(alice, bob);
  await link(alice, carol);
  await connect(alice, carol);
  await alice.page.setViewportSize(sides[0]);

  // A plain ring: Decline and Accept.
  await carol.page.getByTestId("call-audio").click();
  await expect(alice.page.getByTitle("Accept audio call")).toBeVisible({ timeout: 30_000 });
  for (const side of sides) {
    await alice.page.setViewportSize(side);
    await expect.poll(() => cut(alice.page), `plain ring at ${side.width}x${side.height}`).toEqual([]);
  }
  await alice.page.getByTitle("Decline").click();
  await expect(alice.page.getByTestId("incoming-call")).toHaveCount(0);

  // On a call with Bob, Carol rings: End and answer and Decline, with their words.
  await alice.page.setViewportSize(sides[0]);
  await expect(bob.page.getByTestId("call-audio")).toBeEnabled();
  await bob.page.getByTestId("call-audio").click();
  await alice.page.getByTitle("Accept audio call").click();
  await expect(alice.page.getByTitle("End call").first()).toBeVisible();
  await expect(carol.page.getByTestId("call-audio")).toBeEnabled({ timeout: 30_000 });
  await carol.page.getByTestId("call-audio").click();
  await expect(alice.page.getByRole("button", { name: "End and answer" })).toBeVisible({ timeout: 30_000 });
  for (const side of sides) {
    await alice.page.setViewportSize(side);
    await expect.poll(() => cut(alice.page), `ring while on a call at ${side.width}x${side.height}`).toEqual([]);
  }
  await alice.page.getByTitle("Decline").click();
  await expect(alice.page.getByTestId("incoming-call")).toHaveCount(0);
  await bob.page.getByTitle("End call").click();
});
