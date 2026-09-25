// "Say it your way" and "Send the actual thing": Boo's chats with four friends, the one with Casper
// open (text and a voice message), then the photo Casper sends. Desktop from Boo's side; the phone test is the same story on
// Boo's phone.
import { test, expect, type Browser } from "@playwright/test";
import { LocalRelay } from "../../../e2e/support/relay";
import { CAST, chat, converse, pair, person, sceneImage, shot, toBottom, voice, type Peer } from "./helpers";

/** The friends Boo talked to earlier today, oldest first: they fill the chat list under Casper. */
const EARLIER = [
  [CAST.mara, [["them", "market tomorrow at 10?"], ["boo", "yes! I'll bring the tote bags"]]],
  [CAST.spooky, [["them", "costume ideas for friday? 🎃"], ["boo", "a sheet with two holes. timeless"]]],
  [CAST.wendy, [["them", "did you get home ok?"], ["boo", "yes, thanks for the ride 🧹"]]],
] as const;

async function story(browser: Browser, baseURL: string, mobile: boolean) {
  const relay = new LocalRelay();
  const boo = await person(browser, relay, baseURL, CAST.boo, { mobile });
  const casper = await person(browser, relay, baseURL, CAST.casper);

  for (const [who, lines] of EARLIER) {
    const friend = await person(browser, relay, baseURL, who);
    await pair(friend, boo);
    await converse(lines.map(([s, text]) => [s === "boo" ? boo : friend, text] as const), [boo, friend]);
    await friend.context.close();
  }

  const route = await pair(casper, boo);
  await converse([
    [casper, "are you still up?"],
    [boo, "always 👻 what's up?"],
    [casper, "found the photos from saturday. the old house by the lake"],
    [boo, "send them! no cloud this time please"],
    [casper, "straight to you. nothing in between"],
    [boo, "perfect. and friday?"],
    [casper, "8pm at the old gate. bring the good flashlight 🔦"],
  ], [boo, casper]);
  // Casper says the rest out loud.
  await voice(casper);
  await expect(chat(boo).getByTestId("voice-bubble").last().getByTestId("voice-play")).toBeEnabled({ timeout: 60_000 });
  await converse([[boo, "deal. I'll bring snacks too 🍪"]], [boo, casper]);
  // Casper has read everything: Boo's last bubbles carry the receipt.
  await boo.page.waitForTimeout(2500);
  await toBottom(boo);
  return { relay, boo, casper, route };
}

async function photo(boo: Peer, casper: Peer) {
  await casper.page.getByTestId("file-input").setInputFiles({ name: "lake-house.jpg", mimeType: "image/jpeg", buffer: await sceneImage(casper) });
  await expect(boo.page.getByTestId("file-bubble").first()).toBeVisible({ timeout: 90_000 });
  await expect(boo.page.getByTestId("file-bubble").first().locator("img")).toBeVisible({ timeout: 90_000 }).catch(() => console.log("  no preview yet"));
  await converse([[boo, "that moon 😍 framing this one"]], [boo, casper]);
  await boo.page.waitForTimeout(2000);
  await toBottom(boo);
}

test("desktop: chats and a photo", async ({ browser, baseURL }) => {
  const { relay, boo, casper } = await story(browser, baseURL!, false);
  await expect(chat(boo).getByText("deal. I'll bring snacks too 🍪")).toBeVisible();
  await shot(boo, "chat.png");
  await photo(boo, casper);
  await shot(boo, "file.png");
  relay.close();
});

test("phone: chats and a photo", async ({ browser, baseURL }) => {
  const { relay, boo, casper } = await story(browser, baseURL!, true);
  await shot(boo, "chat-mobile.png");
  await photo(boo, casper);
  await shot(boo, "file-mobile.png");
  await boo.page.getByTestId("chat-back").click();
  await shot(boo, "x-chats-mobile.png");
  relay.close();
});
