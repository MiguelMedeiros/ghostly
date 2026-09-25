/**
 * Screenshots of the phone layout (375x812) next to an unchanged desktop peer.
 *
 *   npm run build -w web && npx vite preview --port 5199   (in web/)
 *   node web/test/mobile-shots.mjs <outDir>
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? join(here, "shots");
const URL_ = process.env.WEB_URL ?? "http://localhost:5199";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--disable-features=WebRtcHideLocalIpsWithMdns"],
});

async function peer(name, options) {
  const context = await browser.newContext({ ...options, permissions: ["camera", "microphone"] });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log(`[${name}] pageerror`, error.message));
  await page.goto(URL_);
  await page.getByTitle("New Chat").waitFor();
  await page.evaluate((nick) => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings"));
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, defaultNickname: nick }));
  }, name);
  await page.reload();
  await page.getByTitle("New Chat").waitFor();
  return page;
}

const phone = await peer("Boo", { viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const desk = await peer("Casper", { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
let n = 0;
const shot = async (page, name) => {
  await page.waitForTimeout(500);
  const file = `${String(++n).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: join(out, file) });
  console.log("✓", file);
};
const say = async (page, text) => {
  await page.getByPlaceholder("Type a message").fill(text);
  await page.getByPlaceholder("Type a message").press("Enter");
  await page.waitForTimeout(600);
};
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

try {
  await shot(phone, "chats-empty");
  await phone.getByTitle("New Chat").click();
  await shot(phone, "new-chat");
  await phone.getByRole("button", { name: "Create New Chat" }).first().click();
  await phone.getByPlaceholder("Type a message").waitFor();
  await shot(phone, "chat-invite");
  const invite = (await phone.locator("code").first().textContent()).trim();

  await desk.getByTitle("New Chat").click();
  await desk.getByPlaceholder("Invite code...").fill(invite);
  await desk.getByPlaceholder("Invite code...").press("Enter");
  await desk.getByPlaceholder("Type a message").waitFor();
  await say(desk, "boo! 👻");
  await phone.getByText("boo! 👻").first().waitFor({ timeout: 180_000 });
  await say(phone, "who goes there?");
  await Promise.all([phone, desk].map((p) => p.getByTestId("datalink-state").filter({ hasText: "Peer to peer" }).waitFor({ timeout: 180_000 })));
  await say(desk, "just a friendly ghost. I heard the phone version looks like a real app now");
  await say(phone, "it does ✨ one screen at a time, thumbs only");

  // Test sats so there is a payment to look at.
  await desk.getByTestId("wallet-settings").click();
  await desk.getByTestId("wallet-test-mint").click();
  await desk.getByTestId("wallet-test-balance").waitFor({ timeout: 30_000 });
  await desk.getByTestId("wallet-settings").click();
  await desk.getByTestId("wallet-receive").click();
  await desk.getByTestId("wallet-receive-amount").fill("5000");
  await desk.getByTestId("wallet-create-invoice").click();
  await desk.getByTestId("wallet-paid").waitFor({ timeout: 60_000 });
  await desk.getByRole("button", { name: "Done" }).click();

  await desk.getByTestId("file-input").setInputFiles(join(here, "..", "..", "hero-banner.png"));
  await phone.getByTestId("file-save").first().waitFor({ timeout: 120_000 });
  await desk.getByTestId("payment-button").click();
  await desk.getByTestId("payment-amount").fill("2100");
  await desk.getByPlaceholder("What for? (optional)").fill("pizza 🍕");
  await desk.getByTestId("payment-send").click();
  await phone.getByTestId("payment-bubble").filter({ hasText: "2,100" }).waitFor({ timeout: 60_000 });
  await phone.waitForTimeout(2500);
  await phone.evaluate(() => document.querySelector(".chat-wallpaper")?.scrollTo(0, 1e9));
  await shot(phone, "chat");
  console.log("horizontal overflow in chat:", await overflow(phone));

  await phone.getByTestId("composer-expressions").click();
  await phone.waitForTimeout(1200);
  await shot(phone, "sheet-emoji");
  await phone.mouse.click(180, 80);
  await phone.getByTestId("composer-more").click();
  await shot(phone, "composer-more");
  await phone.getByTitle("GIF").click();
  await phone.getByRole("button", { name: "Retro" }).click();
  await phone.getByPlaceholder("Search retro GIFs...").fill("ghost");
  await phone.waitForTimeout(6000);
  await shot(phone, "sheet-gif");
  await phone.mouse.click(180, 80);
  await phone.getByTestId("composer-more").click();
  await phone.getByTestId("payment-button").click();
  await shot(phone, "sheet-payment");
  await phone.mouse.click(180, 80);
  await phone.getByTitle("Options").click();
  await shot(phone, "chat-options");
  await phone.mouse.click(100, 400);

  await phone.getByTestId("chat-back").click();
  await shot(phone, "chats");
  const tabs = phone.getByTestId("mobile-tabs").getByRole("button");
  await tabs.nth(1).click();
  await shot(phone, "tab-wallet");
  await phone.getByTestId("wallet-history").click();
  await shot(phone, "tab-wallet-history");
  await tabs.nth(2).click();
  await shot(phone, "tab-share");
  await tabs.nth(3).click();
  await shot(phone, "tab-settings");
  console.log("horizontal overflow in settings:", await overflow(phone));
  await tabs.nth(0).click();
  await phone.getByText("Casper").first().click();
  await phone.getByPlaceholder("Type a message").waitFor();

  await desk.getByTitle("Video call").click();
  await phone.getByTitle("Accept video call").waitFor({ timeout: 90_000 });
  await shot(phone, "call-incoming");
  await phone.getByTitle("Accept video call").click();
  await phone.getByText(/^\d{1,2}:\d{2}$/).first().waitFor({ timeout: 90_000 });
  await phone.waitForTimeout(2000);
  await shot(phone, "call");
  console.log("viewport meta:", await phone.evaluate(() => document.querySelector('meta[name=viewport]').content), "| manifest:", await phone.evaluate(() => fetch("/manifest.json").then((r) => r.json()).then((m) => m.display)));
  await phone.getByTitle("End call").click();

  await shot(desk, "desktop-unchanged");
} finally {
  await browser.close();
}
