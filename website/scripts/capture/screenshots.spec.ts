// The desktop set (invite, chat, file, services, connection, wallet, settings, profile, backups)
// plus the first phone pair (invite, chat, chat list). One long take with Boo and Casper.
import { test, expect } from "@playwright/test";
import { LocalRelay } from "../../../e2e/support/relay";
import { open, shot, setNickname, sceneImage, say, chat, toBottom, pair, converse, dressUp } from "./helpers";

test("capture", async ({ browser, baseURL }) => {
  const relay = new LocalRelay();
  const [boo, casper] = await Promise.all([open(browser, relay, baseURL!, "Boo"), open(browser, relay, baseURL!, "Casper")]);
  await setNickname(boo, "Boo");
  await setNickname(casper, "Casper");

  // Profile pictures (real uploads through the profile page).
  await dressUp(boo, casper);

  // 1. invite
  await pair(boo, casper, async () => { await shot(boo, "invite.png"); });

  // 2. chat
  await converse(boo, casper);
  await expect(chat(boo).getByText("spooky good. haunting the old house tonight?")).toBeVisible();
  await say(boo, "always. bring snacks 🍪");
  await expect(chat(casper).getByText("always. bring snacks 🍪")).toBeVisible();
  await boo.page.waitForTimeout(2500);
  await shot(boo, "chat.png");
  await shot(casper, "chat-casper.png");

  // 3. file
  await boo.page.getByTestId("file-input").setInputFiles({ name: "haunted-house.png", mimeType: "image/png", buffer: await sceneImage(boo) });
  await expect(casper.page.getByTestId("file-bubble").first()).toBeVisible();
  await say(casper, "oh that's the one. see you there");
  await expect(chat(boo).getByText("oh that's the one. see you there")).toBeVisible();
  await expect(casper.page.getByTestId("file-bubble").first().locator("img")).toBeVisible().catch(() => {});
  await boo.page.waitForTimeout(2500);
  for (const p of [boo, casper]) await toBottom(p);
  await shot(boo, "file.png");
  await shot(casper, "file-received.png");

  // chat options / services dialog
  await boo.page.getByTitle("Options").click();
  await shot(boo, "x-options.png");
  await boo.page.getByTestId("chat-services-open").click().catch(() => {});
  await shot(boo, "services-chat.png");
  await boo.page.keyboard.press("Escape");
  await boo.page.mouse.click(5, 5);

  // connection panel
  await boo.page.getByTestId("connection-options").click().catch(() => {});
  await shot(boo, "connection.png");
  await boo.page.keyboard.press("Escape");

  // 4. wallet
  await boo.page.getByTestId("wallet-chip").click();
  await expect(boo.page.getByTestId("wallet")).toBeVisible();
  await shot(boo, "wallet-mainnet.png");
  await boo.page.getByTestId("wallet-mode").getByRole("radio", { name: "Testnet" }).click();
  await expect(boo.page.getByTestId("testnet-notice")).toBeVisible();
  await expect(boo.page.getByTestId("wallet-card-usdt")).not.toContainText("Connecting", { timeout: 45_000 }).catch(() => console.log("  usdt still connecting"));
  await expect(boo.page.getByText("Not reachable right now")).toHaveCount(0, { timeout: 30_000 }).catch(() => console.log("  mint still unreachable"));
  await shot(boo, "wallet.png");
  for (const card of ["cashu", "arkade", "usdt", "lightning"]) {
    const c = boo.page.getByTestId(`wallet-card-${card}`);
    if (await c.count()) { await c.click(); await shot(boo, `x-wallet-${card}.png`); }
  }
  // Back to Mainnet so the other shots carry no TESTNET badge.
  await boo.page.getByTestId("wallet-card-cashu").click();
  await boo.page.getByTestId("wallet-mode").getByRole("radio", { name: "Mainnet" }).click();
  await expect(boo.page.getByTestId("testnet-notice")).toHaveCount(0);
  await boo.page.goto("/#/");

  // 6. services
  await boo.page.getByTestId("account-services").click();
  await expect(boo.page.getByTestId("my-services")).toBeVisible();
  await shot(boo, "services.png");

  // 8. settings
  await boo.page.goto("/#/settings");
  await expect(boo.page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await shot(boo, "settings.png");
  await boo.page.evaluate(() => window.scrollTo(0, 0));

  // 5 + 7. profile page and backups
  await boo.page.goto("/#/");
  await boo.page.getByTestId("account-profile").click();
  await expect(boo.page.getByTestId("profile-page")).toBeVisible();
  await shot(boo, "profiles-single.png");
  const backups = boo.page.getByTestId("profile-backups");
  await backups.scrollIntoViewIfNeeded();
  await shot(boo, "x-backup-closed.png");
  await backups.getByTestId("backup-open").click().catch(() => {});
  await backups.scrollIntoViewIfNeeded();
  await shot(boo, "backup.png");
  await backups.getByTestId("s3-setup").click().catch(() => {});
  await backups.scrollIntoViewIfNeeded();
  await shot(boo, "backup-s3.png");

  // Mobile pair
  const [mboo, mcasper] = await Promise.all([open(browser, relay, baseURL!, "mBoo", true), open(browser, relay, baseURL!, "mCasper")]);
  await setNickname(mboo, "Boo"); await setNickname(mcasper, "Casper");
  await dressUp(mboo, mcasper);
  await pair(mboo, mcasper, async () => { await shot(mboo, "invite-mobile.png"); });
  await converse(mboo, mcasper);
  await mboo.page.waitForTimeout(2500);
  await toBottom(mboo);
  await shot(mboo, "chat-mobile.png");
  await mboo.page.getByTestId("chat-back").click().catch(() => {});
  await shot(mboo, "chats-mobile.png");

  // Profiles: a second profile, then back (switching restarts the app).
  await boo.page.goto("/#/");
  await boo.page.getByTestId("account-profile").click();
  await boo.page.getByTestId("profile-new").click();
  await shot(boo, "x-profile-new.png");
  await boo.page.getByTestId("profile-new-name").fill("Haunted House");
  await boo.page.getByTestId("profile-create").click();
  await expect(boo.page.getByTestId("profile-name")).toHaveValue("Haunted House", { timeout: 30000 });
  await boo.page.getByTestId("profile-row").filter({ hasText: "Boo" }).getByTestId("profile-switch").click();
  await expect(boo.page.getByTestId("profile-name")).toHaveValue("Boo", { timeout: 30000 });
  await expect(boo.page.getByTestId("profile-row")).toHaveCount(2);
  await boo.page.getByTestId("profile-row").last().scrollIntoViewIfNeeded();
  await boo.page.mouse.wheel(0, 400);
  await shot(boo, "profiles.png");
  relay.close();
});
