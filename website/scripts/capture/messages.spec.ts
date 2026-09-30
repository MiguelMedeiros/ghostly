// "Paste it. See it.": what a message turns into. Casper sends formatted text, a link whose preview his own app made,
// an invite for another chat and a bitcoin: request; Boo's side shows each as its card. Desktop from Boo's side; the
// phone test is the same story on Boo's phone.
//
// The linked article lives at a reserved `.example` name, answered by Playwright inside Casper's browser only: the
// preview is read by the sender's app, and Boo's app never asks for it (so nothing answers there).
import { test, expect, type Browser } from "@playwright/test";
import { LocalRelay } from "../../../e2e/support/relay";
import { copyInvite } from "../../../e2e/support/clipboard";
import { TB1Q } from "../../../apps/ui/src/test/payments/moneyFormatFixtures";
import { CAST, chat, go, pair, person, say, sceneImage, shot, toBottom, type Peer } from "./helpers";

/** `from` sends `text`; `to` shows `seen` (the text as drawn: marks and links turn into formatting and cards). */
async function send(from: Peer, to: Peer, text: string, seen: string) {
  await say(from, text);
  await expect(chat(to).locator("[data-message-row]").filter({ hasText: seen }).last()).toBeVisible({ timeout: 60_000 });
}

const ARTICLE = "https://gazette.example/old-house-by-the-lake";
const PAGE = `<!doctype html><html><head><title>Gazette</title>
  <meta property="og:title" content="The old house by the lake">
  <meta property="og:description" content="Empty since 1887. The neighbours say its lights still come on at night.">
  <meta property="og:site_name" content="The Ghost Town Gazette">
  <meta property="og:image" content="https://gazette.example/lake.jpg">
  </head><body>…</body></html>`;

async function story(browser: Browser, baseURL: string, mobile: boolean) {
  const relay = new LocalRelay();
  const boo = await person(browser, relay, baseURL, CAST.boo, { mobile });
  const casper = await person(browser, relay, baseURL, CAST.casper);
  const picture = await sceneImage(casper);
  await casper.context.route("https://gazette.example/**", (route) => {
    const jpeg = route.request().url().endsWith(".jpg");
    return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*" }, contentType: jpeg ? "image/jpeg" : "text/html; charset=utf-8", body: jpeg ? picture : PAGE });
  });

  const casperChat = await pair(casper, boo);

  // An invite for another chat, sent inside a sentence: a card with Join on Boo's side. It comes first, so the long
  // link scrolls up and the cards below it fill the shot.
  await casper.page.getByTitle("New Chat").first().click();
  const invite = await copyInvite(casper.page);
  await go(casper, casperChat);
  await send(casper, boo, `a chat for friday, with Wendy and Mara: ${invite}`, "a chat for friday");
  await expect(chat(boo).getByTestId("entity-invite").last()).toBeVisible();
  await send(boo, casper, "_so_ spooky. where are we going?", "where are we going?");
  await send(casper, boo, "found it! *the old house by the lake* 👻", "the old house by the lake");

  // The link: Casper's app reads the page and redraws its picture before he sends.
  const box = casper.page.getByPlaceholder("Message…");
  await box.fill(`the story ${ARTICLE}`);
  await expect(casper.page.getByTestId("composer-link-preview")).toHaveAttribute("data-status", "ready", { timeout: 30_000 });
  await box.press("Enter");
  await expect(chat(boo).getByTestId("link-preview-card").last()).toBeVisible({ timeout: 60_000 });

  // A payment request as plain bitcoin: text, on a test network.
  await send(casper, boo, `and the flashlight was mine 🔦 bitcoin:${TB1Q}?amount=0.00021&message=Flashlight`, "the flashlight was mine");
  await boo.page.waitForTimeout(2500);
  await toBottom(boo);
  return { relay, boo, casper };
}

test("desktop: what a message turns into", async ({ browser, baseURL }) => {
  const { relay, boo } = await story(browser, baseURL!, false);
  await shot(boo, "messages.png");
  relay.close();
});

test("phone: what a message turns into", async ({ browser, baseURL }) => {
  const { relay, boo } = await story(browser, baseURL!, true);
  await shot(boo, "messages-mobile.png");
  relay.close();
});
