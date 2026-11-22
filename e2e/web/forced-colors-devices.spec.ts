import { test } from "../support/fixtures";
import { enrollDevice } from "../support/devices";
import { keepsAnEdge } from "../support/forcedColors";

/**
 * The device screens in forced colors (Windows Contrast themes): there every background is the page's, so a button
 * drawn by its fill alone reads as bare text. The main action of each step (Add a device's Next, the join's Paste,
 * the standby's Use here, Remove) keeps an edge there, as the app's own Button does (forced-colors-controls.spec.ts),
 * and shows none in normal colours.
 */

test("forced colors keep an edge on the device screens' main buttons", { tag: ["@feature:app.accessibility", "@feature:devices.screens"] }, async ({ peer }) => {
  test.setTimeout(5 * 60_000);
  const [desktop, phone, other] = await Promise.all([peer("desktop"), peer("phone"), peer("other")]);

  // Add a device: the password step's Next.
  await desktop.page.goto("/#/profile");
  await desktop.page.getByTestId("device-add-open").click();
  await keepsAnEdge(desktop.page, desktop.page.getByTestId("device-add").getByTestId("device-add-next"), "Add a device's Next");
  await desktop.page.keyboard.press("Escape");

  // The new device's side: Add this device to my profile, Paste.
  await other.page.getByTestId("home-already").click();
  await other.page.getByTestId("device-join-add").click();
  await keepsAnEdge(other.page, other.page.getByRole("dialog").getByRole("button", { name: /Paste/ }), "the join's Paste");

  // The standby's Use here, and Remove on the active device.
  await enrollDevice(desktop, phone);
  await keepsAnEdge(phone.page, phone.page.getByTestId("handoff-use-here"), "the standby's Use here");
  await desktop.page.getByTestId("device-menu").first().click();
  await desktop.page.getByTestId("device-remove-open").click();
  await keepsAnEdge(desktop.page, desktop.page.getByTestId("device-remove-go"), "Remove");
});
