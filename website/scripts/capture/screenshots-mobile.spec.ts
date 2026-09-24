// Phone screenshots for "What happens next" (file, services, wallet, call), plus the
// desktop call. The calls run in a legacy chat, the only kind the web client can call in
// (see e2e/support/fixtures.ts linkLegacy).
import { test, expect, type Browser } from "@playwright/test";
import { createLink, encodeInviteCode } from "@ghostly/core";
import { LocalRelay } from "../../../e2e/support/relay";
import { pasteInvite } from "../../../e2e/support/clipboard";
import { open, shot, setNickname, sceneImage, say, chat, toBottom, pair, converse, dressUp, CLIPBOARD, type Peer } from "./helpers";

const clock = /^\d{1,2}:\d{2}$/;

/** A peer that may also use the (fake) camera and microphone: the calls ring without a prompt. */
const openCaller = (browser: Browser, relay: LocalRelay, baseURL: string, name: string, mobile = false) =>
  open(browser, relay, baseURL, name, mobile, ["camera", "microphone", ...CLIPBOARD]);

/** A chat of the kind the web client can call in: the host plants the session, the guest joins with its code. */
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

/** Both sides have seen each other's message and the WebRTC link is up (a legacy chat says so in its strip). */
async function connected(a: Peer, b: Peer) {
  for (const p of [a, b]) {
    await expect(
      p.page.getByTestId("datalink-state").filter({ hasText: "Peer to peer" })
        .or(p.page.locator("[data-testid=connection-options][aria-label*=\"Connected · WebRTC\"]")),
    ).toBeVisible({ timeout: 90_000 }).catch(() => console.log(`  [${p.name}] no WebRTC strip yet`));
  }
}

/** Boo rings, Casper answers, both see the clock. */
async function audioCall(boo: Peer, casper: Peer) {
  await expect(boo.page.getByTitle("Audio call")).toBeEnabled({ timeout: 60_000 });
  await boo.page.getByTitle("Audio call").click();
  await expect(casper.page.getByText("Incoming audio call...")).toBeVisible({ timeout: 60_000 });
  await casper.page.getByTitle("Accept audio call").click();
  for (const p of [boo, casper]) await expect(p.page.getByText(clock).first()).toBeVisible({ timeout: 60_000 });
  // Let the clock leave 00:00 and the "connected" line settle.
  await boo.page.waitForTimeout(3500);
}

test("phone: file, services, wallet", async ({ browser, baseURL }) => {
  const relay = new LocalRelay();
  const [mboo, casper] = await Promise.all([openCaller(browser, relay, baseURL!, "mBoo", true), openCaller(browser, relay, baseURL!, "Casper")]);
  await setNickname(mboo, "Boo");
  await setNickname(casper, "Casper");
  await dressUp(mboo, casper);
  await pair(mboo, casper);
  await converse(mboo, casper);

  // file: the picture Boo sent and Casper's answer, newest message at the bottom (like file.png).
  await mboo.page.getByTestId("file-input").setInputFiles({ name: "haunted-house.png", mimeType: "image/png", buffer: await sceneImage(mboo) });
  await expect(casper.page.getByTestId("file-bubble").first()).toBeVisible();
  await say(casper, "oh that's the one. see you there");
  await expect(chat(mboo).getByText("oh that's the one. see you there")).toBeVisible();
  await expect(mboo.page.getByTestId("file-bubble").first().locator("img")).toBeVisible().catch(() => {});
  await mboo.page.waitForTimeout(2500);
  await toBottom(mboo);
  await shot(mboo, "file-mobile.png");

  // services: chat Options → Services… (like services-chat.png).
  await mboo.page.getByTitle("Options").click();
  await expect(mboo.page.getByTestId("chat-options-menu")).toBeVisible();
  await mboo.page.getByTestId("chat-services-open").click();
  await mboo.page.waitForTimeout(600);
  await shot(mboo, "services-mobile.png");
  await mboo.page.keyboard.press("Escape");
  await mboo.page.waitForTimeout(300);

  // wallet: on a phone it is a bottom tab, reachable from the chat list.
  await mboo.page.getByTestId("chat-back").click();
  await expect(mboo.page.getByTestId("mobile-tabs")).toBeVisible();
  await mboo.page.getByTestId("mobile-tabs").getByRole("button", { name: "Wallet" }).click();
  await expect(mboo.page.getByTestId("wallet")).toBeVisible();
  await mboo.page.waitForTimeout(1500);
  await shot(mboo, "wallet-mobile.png");
  relay.close();
});

test("phone: audio call", async ({ browser, baseURL }) => {
  const relay = new LocalRelay();
  const [mboo, casper] = await Promise.all([openCaller(browser, relay, baseURL!, "mBoo", true), openCaller(browser, relay, baseURL!, "Casper")]);
  await setNickname(mboo, "Boo");
  await setNickname(casper, "Casper");
  await linkLegacy(mboo, casper);
  await converse(mboo, casper);
  await connected(mboo, casper);
  await audioCall(mboo, casper);
  await shot(mboo, "call-mobile.png");
  await mboo.page.getByTitle("End call").click().catch(() => {});
  relay.close();
});

test("desktop: audio call", async ({ browser, baseURL }) => {
  const relay = new LocalRelay();
  const [boo, casper] = await Promise.all([openCaller(browser, relay, baseURL!, "Boo"), openCaller(browser, relay, baseURL!, "Casper")]);
  await setNickname(boo, "Boo");
  await setNickname(casper, "Casper");
  await linkLegacy(boo, casper);
  await converse(boo, casper);
  await connected(boo, casper);
  await audioCall(boo, casper);
  await shot(boo, "call.png");
  await boo.page.getByTitle("End call").click().catch(() => {});
  relay.close();
});
