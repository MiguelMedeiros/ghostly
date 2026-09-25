// "Be a little closer": Boo calls Casper and Casper answers. Calls ring in chats of the kind a
// legacy invite makes (paired chats and groups don't ring yet, as the section says), so this chat is
// planted the way e2e/support/fixtures.ts linkLegacy does. Desktop and phone from Boo's side.
import { test, expect, type Browser } from "@playwright/test";
import { createLink, encodeInviteCode } from "@ghostly/core";
import { LocalRelay } from "../../../e2e/support/relay";
import { pasteInvite } from "../../../e2e/support/clipboard";
import { CAST, MEDIA, converse, person, shot, type Peer } from "./helpers";

const clock = /^\d{1,2}:\d{2}$/;

/** A chat the web client can call in: the host plants the session, the guest joins with its code. */
async function linkLegacy(host: Peer, guest: Peer) {
  const keys = createLink();
  const invite = encodeInviteCode(keys.invite);
  await host.page.evaluate(({ mine, invite }) => {
    const id = crypto.randomUUID().replaceAll("-", "");
    localStorage.setItem(`ghostly_${id}`, JSON.stringify({ id, mySeedB64: mine.seedB64, peerPubKeyB64: mine.peerPubKeyZ32, encKeyB64: mine.encKeyB64, messages: [], createdAt: Date.now() }));
    localStorage.setItem(`ghostly_invite_${id}`, invite);
    window.dispatchEvent(new Event("session-updated"));
    location.hash = `/chat/${id}`;
  }, { mine: keys.mine, invite });
  await guest.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
  await pasteInvite(guest.page, invite);
  for (const p of [host, guest]) await expect(p.page.getByPlaceholder("Message…")).toBeEnabled();
}

async function call(browser: Browser, baseURL: string, mobile: boolean) {
  const relay = new LocalRelay();
  const [boo, casper] = await Promise.all([
    person(browser, relay, baseURL, CAST.boo, { mobile, permissions: MEDIA }),
    person(browser, relay, baseURL, CAST.casper, { permissions: MEDIA }),
  ]);
  await linkLegacy(boo, casper);
  await converse([[casper, "got a minute? easier to say it out loud"], [boo, "calling you now"]], [boo, casper]);
  for (const p of [boo, casper]) {
    await expect(p.page.getByTestId("datalink-state").filter({ hasText: "Peer to peer" })).toBeVisible({ timeout: 90_000 })
      .catch(() => console.log(`  [${p.name}] no WebRTC strip yet`));
  }
  await expect(boo.page.getByTitle("Audio call")).toBeEnabled({ timeout: 60_000 });
  await boo.page.getByTitle("Audio call").click();
  await expect(casper.page.getByText("Incoming audio call...")).toBeVisible({ timeout: 60_000 });
  await casper.page.getByTitle("Accept audio call").click();
  for (const p of [boo, casper]) await expect(p.page.getByText(clock).first()).toBeVisible({ timeout: 60_000 });
  // Let the clock leave 00:00 and the "connected" line settle.
  await boo.page.waitForTimeout(6500);
  return { relay, boo };
}

test("desktop: an audio call", async ({ browser, baseURL }) => {
  const { relay, boo } = await call(browser, baseURL!, false);
  await shot(boo, "call.png");
  await boo.page.getByTitle("End call").click().catch(() => {});
  relay.close();
});

test("phone: an audio call", async ({ browser, baseURL }) => {
  const { relay, boo } = await call(browser, baseURL!, true);
  await shot(boo, "call-mobile.png");
  await boo.page.getByTitle("End call").click().catch(() => {});
  relay.close();
});
