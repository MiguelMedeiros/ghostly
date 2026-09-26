import { expect, test } from "../support/fixtures";
import { pair } from "../support/paired";
import { INTERFACE_NOTES, NOTE, heard, listen } from "../support/sounds";

/**
 * The sound categories (src/lib/cues.ts, Settings > Notifications and sounds). Here the Connection category's knock:
 * the one who made the invite hears their contact arrive with it, once; the one who joined does not. The Interface
 * category is off by default: pairing, the chat list and Settings play none of its cues. A category's ▶ plays its
 * sound. What would be heard is recorded, not played (e2e/support/sounds.ts).
 */
test("the inviter hears the contact knock, once; Interface sounds stay off by default", { tag: ["@feature:app.attention.cues", "@feature:app.attention.sounds"] }, async ({ peer }) => {
  const [host, guest] = await Promise.all([peer("cues-host"), peer("cues-guest")]);
  await Promise.all([listen(host), listen(guest)]);
  await pair(host, guest);

  await expect.poll(() => heard(host, NOTE.knock), { timeout: 30_000 }).toBe(1);
  expect(await heard(guest, NOTE.knock)).toBe(0);

  // Settings: five categories, Interface off; Connection's ▶ plays the knock.
  await host.page.goto("/#/settings");
  await expect(host.page.getByTestId("settings-cues-interface")).toHaveAttribute("aria-checked", "false");
  for (const category of ["payments", "identities", "connection", "chat"]) await expect(host.page.getByTestId(`settings-cues-${category}`)).toHaveAttribute("aria-checked", "true");
  await host.page.getByTestId("settings-cues-connection-preview").click();
  await expect.poll(() => heard(host, NOTE.knock)).toBe(2);

  // Connection off: the knock is still there to preview, and is kept off after a reload.
  await host.page.getByTestId("settings-cues-connection").click();
  await host.page.reload();
  await expect(host.page.getByTestId("settings-cues-connection")).toHaveAttribute("aria-checked", "false");

  for (const p of [host, guest]) expect(await heard(p, ...INTERFACE_NOTES)).toBe(0);
});
