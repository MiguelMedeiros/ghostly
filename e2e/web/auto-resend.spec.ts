import type { CDPSession } from "@playwright/test";
import { chat, connect, expect, link, say, test, type Peer } from "../support/fixtures";

// A message that goes into a session the contact is leaving (a reload, an app closing) gets no receipt.
// It is not the person's job to notice: the app sends it again, under the same id, once the chat is live,
// and the contact shows it once (packages/browser/src/engine/outbox.ts, RESEND_POLICY).

const bubble = (p: Peer, text: string) => chat(p).locator(".group").filter({ hasText: text });
const UNCONFIRMED = "Not confirmed yet · sends again by itself";
const connected = (p: Peer) => expect(p.page.getByTestId("connection-options")).toHaveAttribute("aria-label", /Connected/, { timeout: 120_000 });

/**
 * Bob's app stops mid-session, its connection still up: what Alice sends now reaches a session that will
 * never read it, exactly like one that is closing. Then that session is gone for good.
 */
async function freeze(bob: Peer): Promise<CDPSession> {
  const cdp = await bob.context.newCDPSession(bob.page);
  await cdp.send("Debugger.enable");
  await cdp.send("Debugger.pause");
  return cdp;
}
/** Bob's frozen session closes without reading anything, and Bob opens the chat again. */
async function reopen(bob: Peer): Promise<void> {
  const url = bob.page.url();
  await bob.page.close();
  bob.page = await bob.context.newPage();
  await bob.page.goto(url);
  await expect(bob.page.getByPlaceholder("Message…")).toBeVisible({ timeout: 60_000 });
}

test("a message sent while the contact's session is closing arrives once when it is back, without Retry", { tag: ["@feature:chat.paired.offline-send", "@feature:chat.paired.receipts", "@feature:chat.paired.reconnect"] }, async ({ peer }) => {
  test.setTimeout(6 * 60_000);
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  for (const p of [alice, bob]) await connected(p);

  await freeze(bob);
  const text = "sent while you were reloading";
  await say(alice, text);
  // No receipt: it waits to go again by itself, and asks nothing of Alice.
  await expect(bubble(alice, text)).toContainText(UNCONFIRMED, { timeout: 90_000 });
  await expect(bubble(alice, text).getByRole("button", { name: "Retry message" })).toHaveCount(0);

  await reopen(bob);
  await expect(chat(bob).getByText(text, { exact: true })).toBeVisible({ timeout: 150_000 });
  await expect(bubble(alice, text)).toContainText("Received by peer", { timeout: 60_000 });
  // Once, however many times it went: the same id is kept once.
  await expect(chat(bob).getByText(text, { exact: true })).toHaveCount(1);
  await bob.page.reload();
  await expect(chat(bob).getByText(text, { exact: true })).toHaveCount(1);
  await expect(chat(alice).getByRole("button", { name: "Retry message" })).toHaveCount(0);
});

test("an unconfirmed message is still sent again after the sender's app restarts", { tag: ["@feature:chat.paired.offline-send", "@feature:chat.paired.receipts"] }, async ({ peer }) => {
  test.setTimeout(6 * 60_000);
  const [alice, bob] = await Promise.all([peer("alice"), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  for (const p of [alice, bob]) await connected(p);

  await freeze(bob);
  const text = "written before my app restarted";
  await say(alice, text);
  await expect(bubble(alice, text)).toContainText(UNCONFIRMED, { timeout: 90_000 });
  // Alice's app restarts while it is still unconfirmed: it is picked up again from storage, and goes by
  // whatever path the chat has now (the DHT fallback while Bob is unreachable, the link once Bob is back).
  await alice.page.reload();
  await expect(bubble(alice, text)).toBeVisible();
  await expect(bubble(alice, text)).not.toContainText("Delivery unconfirmed");
  await expect(bubble(alice, text).getByRole("button", { name: "Retry message" })).toHaveCount(0);

  await reopen(bob);
  await expect(chat(bob).getByText(text, { exact: true })).toBeVisible({ timeout: 150_000 });
  await expect(bubble(alice, text)).toContainText("Received by peer", { timeout: 60_000 });
  await expect(chat(bob).getByText(text, { exact: true })).toHaveCount(1);
});
