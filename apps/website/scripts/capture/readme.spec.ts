// The README's hero (docs/assets/readme/hero*.webp): Boo's chat with Casper on a computer and on a phone, in the
// app's default Dark. Shots are named x-readme-*, so run.mjs leaves them in the scratch folder; readme-hero.mjs turns
// them into the README's images. Nothing leaves this machine: Pkarr from the in-process relay, STUN from a local
// server, Iroh off, every other host refused.
import { test, expect, type Browser } from "@playwright/test";
import { LocalRelay } from "../../../../e2e/support/relay";
// Not a React hook, despite the name: renamed so the website's lint does not read it as one.
import { useLocalStun as localStun } from "../../../../e2e/support/stun";
import { CAST, CLIPBOARD, DESKTOP, EVENING, PHONE, chat, converse, dress, pair, sceneImage, shot, toBottom, voice, type Peer, type Person } from "./helpers";

const local = (url: URL) => url.hostname === "localhost" || url.hostname === "127.0.0.1";

/** A person on the app, dressed, with no way out to the Internet. */
async function offline(browser: Browser, relay: LocalRelay, baseURL: string, who: Person, mobile = false): Promise<Peer> {
  const context = await browser.newContext({
    baseURL, colorScheme: "dark", deviceScaleFactor: 2, locale: "en-US", timezoneId: EVENING, permissions: CLIPBOARD,
    viewport: mobile ? PHONE : DESKTOP, ...(mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  // Added first, so it runs last: the relay's own route answers Pkarr before this refuses every other host.
  await context.route((url) => !local(url) && url.protocol.startsWith("http"), (route) => route.abort("blockedbyclient"));
  await context.routeWebSocket((url) => !local(url), (ws) => { void ws.close({ code: 1008, reason: "Offline capture" }); });
  await relay.attach(context);
  await localStun(context);
  await context.addInitScript(() => { try { localStorage.setItem("ghostly-test-iroh", "off"); } catch { /* opaque origin */ } });
  const page = context.pages()[0] ?? await context.newPage();
  page.on("pageerror", (e) => console.log(`  [${who.name}] ${e.message}`));
  await page.goto("/");
  await expect(page.getByTitle("New Chat").first()).toBeVisible();
  const p = { name: who.name, page, context };
  await dress(p, who);
  return p;
}

/** The friends Boo talked to earlier: they fill the chat list under Casper. */
const EARLIER = [
  [CAST.mara, [["them", "market tomorrow at 10?"], ["boo", "yes! I'll bring the tote bags"]]],
  [CAST.spooky, [["them", "costume ideas for friday? 🎃"], ["boo", "a sheet with two holes. timeless"]]],
  [CAST.wendy, [["them", "did you get home ok?"], ["boo", "yes, thanks for the ride 🧹"]]],
] as const;

async function story(browser: Browser, baseURL: string, mobile: boolean) {
  const relay = new LocalRelay();
  const boo = await offline(browser, relay, baseURL, CAST.boo, mobile);
  const casper = await offline(browser, relay, baseURL, CAST.casper);
  for (const [who, lines] of EARLIER) {
    const friend = await offline(browser, relay, baseURL, who);
    await pair(friend, boo);
    await converse(lines.map(([s, text]) => [s === "boo" ? boo : friend, text] as const), [boo, friend]);
    await friend.context.close();
  }
  await pair(casper, boo);
  await converse([
    [casper, "are you still up?"],
    [boo, "always 👻 what's up?"],
    [casper, "found the photos from saturday. the old house by the lake"],
    [boo, "send them! no cloud this time please"],
    [casper, "straight to you. nothing in between"],
  ], [boo, casper]);
  await voice(casper);
  await expect(chat(boo).getByTestId("voice-bubble").last().getByTestId("voice-play")).toBeEnabled({ timeout: 60_000 });
  await casper.page.getByTestId("file-input").setInputFiles({ name: "lake-house.jpg", mimeType: "image/jpeg", buffer: await sceneImage(casper) });
  await expect(boo.page.getByTestId("file-bubble").first().locator("img")).toBeVisible({ timeout: 90_000 });
  await converse([[boo, "that moon 😍 framing this one"]], [boo, casper]);
  await boo.page.waitForTimeout(2500);
  await toBottom(boo);
  return { relay, boo };
}

test("readme: desktop", async ({ browser, baseURL }) => {
  const { relay, boo } = await story(browser, baseURL!, false);
  await shot(boo, "x-readme-desktop.png");
  relay.close();
});

test("readme: phone", async ({ browser, baseURL }) => {
  const { relay, boo } = await story(browser, baseURL!, true);
  await shot(boo, "x-readme-phone.png");
  relay.close();
});
