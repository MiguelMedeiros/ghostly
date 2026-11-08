import type { Page } from "@playwright/test";
import { connect, expect, link, test } from "../support/fixtures";
import { smallTargets } from "../support/touchTargets";

/**
 * A connected call on a phone on its side, in a browser whose toolbars leave 320-350 px of height. The avatars and names
 * are centred in the window and the buttons sit at its bottom: an avatar over its name (96 px, 16 px, a 28 px line) was
 * 140 px tall, and at 340 px high the names ran into Camera, Devices and Share screen. Measured: each avatar (with its
 * speaking ring, 12 px out at its widest) and each name against each button of the row.
 */
const overButtons = (page: Page) => page.getByTestId("call-hang-up").evaluate((hangUp) => {
  const buttons = [...hangUp.parentElement!.querySelectorAll("button")].map((b) => [b.dataset.testid ?? b.title, b.getBoundingClientRect()] as const);
  const call = hangUp.closest("[data-testid=call-window]")!;
  const parts = [
    ...[...call.querySelectorAll(".call-avatar")].map((a) => [`avatar ${a.getAttribute("data-testid")}`, a.getBoundingClientRect(), 12] as const),
    ...[...call.querySelectorAll(".call-name")].map((n) => [`name "${n.textContent}"`, n.getBoundingClientRect(), 0] as const),
  ];
  const out: string[] = [];
  for (const [part, r, ring] of parts) {
    for (const [button, b] of buttons) {
      if (r.left - ring < b.right && r.right + ring > b.left && r.top - ring < b.bottom && r.bottom + ring > b.top) {
        out.push(`${part} at ${Math.round(r.top - ring)}..${Math.round(r.bottom + ring)} over ${button} at ${Math.round(b.top)}..${Math.round(b.bottom)}`);
      }
    }
  }
  return out;
});

const sides = [{ width: 844, height: 340 }, { width: 740, height: 330 }, { width: 568, height: 320 }, { width: 640, height: 360 }];

test("a call on a phone on its side: the avatars and names stay clear of the buttons, voice and video", { tag: ["@feature:calls.audio", "@feature:calls.upgrade", "@feature:app.mobile-layout"] }, async ({ peer }, testInfo) => {
  const alice = await peer("alice");
  const bob = await peer("bob", { mobile: true, viewport: sides[0] });
  await link(alice, bob);
  await connect(alice, bob);
  await alice.page.getByTestId("call-audio").click();
  await bob.page.getByTitle("Accept audio call").click();
  await expect(bob.page.getByTestId("call-status")).toHaveAttribute("data-state", "connected");
  await expect(bob.page.getByTestId("call-self-avatar")).toBeVisible();
  await expect(bob.page.getByTestId("call-camera")).toBeVisible();

  // A voice call: the contact and you, side by side.
  for (const side of sides) {
    await bob.page.setViewportSize(side);
    await expect.poll(() => overButtons(bob.page), `voice call at ${side.width}x${side.height}`).toEqual([]);
    await bob.page.screenshot({ path: testInfo.outputPath(`voice-${side.width}x${side.height}.png`) });
  }

  // Your camera on: the contact alone, your picture in its corner.
  await bob.page.getByTestId("call-camera").click();
  await expect(bob.page.getByTestId("call-self-view")).toBeVisible();
  await expect(bob.page.getByTestId("call-self-avatar")).toHaveCount(0);
  for (const side of sides) {
    await bob.page.setViewportSize(side);
    await expect.poll(() => overButtons(bob.page), `camera on at ${side.width}x${side.height}`).toEqual([]);
    await bob.page.screenshot({ path: testInfo.outputPath(`camera-${side.width}x${side.height}.png`) });
  }

  // Every button keeps a 44 px target.
  await bob.page.setViewportSize(sides[2]);
  const tiny = (await smallTargets(bob.page, 44, "[data-testid=call-window] button")).map((t) => `${t.name} ${t.width}×${t.height} (${t.stops})`);
  expect(tiny, "the call window's buttons under 44 × 44 px").toEqual([]);
  await bob.page.getByTestId("call-hang-up").click();
  await expect(alice.page.getByTestId("call-status")).toHaveCount(0);
});
