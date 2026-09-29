import type { Page } from "@playwright/test";
import { connect, expect, link, test, type Peer } from "../support/fixtures";

/**
 * A call's buttons stay round and off the edges on a narrow screen. With Share screen (a browser that can capture one,
 * in a narrow window) the row had five buttons of 64 px with 32 px between them: wider than 375 px, so flex squeezed
 * four of them into ovals pressed against both edges. A phone's browser has no screen capture: three buttons, which fit.
 */
/** Buttons of the row that are squeezed out of round (flex shrinks them) or reach the screen's edges. */
const misshapen = (page: Page) => page.getByTestId("call-hang-up").evaluate((hangUp) => {
  const width = document.documentElement.clientWidth;
  return [...hangUp.parentElement!.children].map((b) => b.getBoundingClientRect())
    .filter((r) => r.width > 0 && (Math.abs(r.width - r.height) > 1 || r.left < 4 || r.right > width - 4))
    .map((r) => `${Math.round(r.width)}x${Math.round(r.height)} at ${Math.round(r.left)}..${Math.round(r.right)} of ${width}`);
});

for (const { width, share } of [{ width: 320, share: false }, { width: 375, share: true }]) {
  test(`the call's buttons fit a ${width} px phone${share ? ", Share screen too" : ""}`, { tag: ["@feature:calls.video"] }, async ({ peer }) => {
    const alice = await peer("alice");
    const bob: Peer = await peer("bob", { mobile: true, viewport: { width, height: 740 } });
    // A phone's browser has no screen capture, so its row has no Share screen button.
    if (!share) {
      await bob.page.addInitScript(() => { delete (MediaDevices.prototype as { getDisplayMedia?: unknown }).getDisplayMedia; });
      await bob.page.reload();
      await expect(bob.page.getByTitle("New Chat")).toBeVisible();
    }
    await link(alice, bob);
    await connect(alice, bob);
    await alice.page.getByTestId("call-video").click();
    await bob.page.getByTitle("Accept video call").click();
    await expect(bob.page.getByTestId("call-hang-up")).toBeVisible();
    await expect(bob.page.getByTestId("share-screen")).toHaveCount(share ? 1 : 0);
    await expect.poll(() => misshapen(bob.page)).toEqual([]);
    await bob.page.getByTestId("call-hang-up").click();
  });
}
