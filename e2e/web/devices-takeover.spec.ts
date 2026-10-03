import { expect, test, chat, connect, link, say, type Peer } from "../support/fixtures";
import { DEVICE_SET_PASSWORD, enrollDevice, untilShown } from "../support/devices";

/**
 * A forced takeover (WISP 06 § Forced takeover, part 6). Two browser contexts are the person's two devices and a third
 * is a contact. The profile moves to the phone by a handoff, so the desktop keeps a frozen copy; then the phone's page
 * is closed for good (lost), and the desktop takes over with the lock password and the phone's name. The contact keeps
 * chatting with the desktop. The phone's page, opened again, reads the higher turn before its engine starts, shows
 * that it was replaced, and says nothing to the contact. Every password here is a test value.
 */

/** The contact's own record of its links (`[ghostly:link]` lines), with when each was seen. */
function traceLines(peer: Peer): { t: number; step: string }[] {
  const lines: { t: number; step: string }[] = [];
  peer.page.on("console", (message) => {
    const text = message.text();
    if (!text.startsWith("[ghostly:link] ")) return;
    try { lines.push(JSON.parse(text.slice(15)) as { t: number; step: string }); } catch { /* not a trace line */ }
  });
  return lines;
}
const traced = { beforeOpen: async (context: import("@playwright/test").BrowserContext) => { await context.addInitScript(() => { (globalThis as { __ghostlyLinkTrace?: boolean }).__ghostlyLinkTrace = true; }); } };

async function openTheChat(peer: Peer): Promise<void> {
  await peer.page.getByTestId("sidebar").getByTestId("chat-row").first().click();
  await expect(peer.page.getByPlaceholder("Message…")).toBeVisible();
}

test("the standby takes over with the password, the contact keeps chatting with it, and the old device opened again is replaced without a word", { tag: ["@feature:devices.takeover"] }, async ({ peer }) => {
  test.setTimeout(12 * 60_000);
  const [desktop, phone, contact] = await Promise.all([peer("desktop"), peer("phone"), peer("contact", traced)]);
  const lines = traceLines(contact);
  await link(desktop, contact);
  await connect(desktop, contact);
  await enrollDevice(desktop, phone);

  // The profile moves to the phone (a pull): the desktop is on standby now, with its frozen copy.
  await phone.page.getByTestId("handoff-use-here").click();
  await phone.page.getByTestId("handoff-password").fill(DEVICE_SET_PASSWORD);
  await phone.page.getByTestId("handoff-start").click();
  await untilShown(phone.page, phone.page.getByTitle("New Chat"), { timeout: 300_000 });
  await untilShown(desktop.page, desktop.page.getByTestId("device-standby").and(desktop.page.locator("[data-state=standby]")));
  await openTheChat(phone);
  await say(phone, "from the phone");
  await expect(chat(contact).getByText("from the phone")).toBeVisible({ timeout: 180_000 });

  // The phone is lost: its page goes, and nothing of it runs any more.
  const phoneUrl = phone.page.url();
  await phone.page.close();

  // My other device is lost or broken, on the desktop: a wrong password first, refused, and nothing changes.
  await desktop.page.getByTestId("takeover-open").click();
  const dialog = desktop.page.getByTestId("takeover-dialog");
  await expect(dialog).toContainText("Take over without Phone?");
  await dialog.getByTestId("takeover-password").fill("not the password");
  await dialog.getByTestId("takeover-name").fill("Phone");
  await dialog.getByTestId("takeover-lost-no").check();
  await dialog.getByTestId("takeover-go").click();
  await expect(dialog.getByTestId("takeover-error")).toHaveText("Wrong password.");
  // The right one: about 30 seconds of checking, then the desktop starts as the active device.
  await dialog.getByTestId("takeover-password").fill(DEVICE_SET_PASSWORD);
  const tookAt = Date.now();
  await dialog.getByTestId("takeover-go").click();
  await untilShown(desktop.page, desktop.page.getByTitle("New Chat"), { timeout: 240_000 });

  // The contact keeps chatting with it, both ways.
  await openTheChat(desktop);
  await say(desktop, "the desktop took over");
  await expect(chat(contact).getByText("the desktop took over")).toBeVisible({ timeout: 180_000 });
  await say(contact, "welcome back");
  await expect(chat(desktop).getByText("welcome back")).toBeVisible({ timeout: 180_000 });

  // The phone's page, opened again: replaced, before its engine started, and it said nothing to the contact.
  const reopenedAt = Date.now();
  phone.page = await phone.context.newPage();
  await phone.page.goto(phoneUrl);
  await untilShown(phone.page, phone.page.getByTestId("device-standby").and(phone.page.locator("[data-state=superseded]")));
  await expect(phone.page.getByTestId("device-standby-title")).toHaveText("This device was replaced");
  await expect(phone.page.getByTitle("New Chat")).toBeHidden();
  await say(contact, "still with the desktop");
  await expect(chat(desktop).getByText("still with the desktop")).toBeVisible({ timeout: 180_000 });
  await expect(chat(contact).getByText("the desktop took over")).toBeVisible();
  expect(lines.filter((line) => line.t >= reopenedAt && line.step === "peer-departed")).toEqual([]);
  test.info().annotations.push({ type: "measure", description: JSON.stringify({ takeoverToActiveMs: reopenedAt - tookAt }) });
});
