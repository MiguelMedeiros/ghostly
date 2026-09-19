/**
 * Deleted chats stay deleted. "Delete all chats" used to remove every `ghostly_`
 * key, including the marker of the one-time import of the peer's links, so the
 * next reconcile brought every chat back, empty. It also took the settings.
 *
 *   npm run build -w @ghostly/web && npx vite preview --port 4173 web &
 *   WEB_URL=http://localhost:4173 node web/test/delete-chats.mjs
 */
import { chromium } from "playwright";

const url = process.env.WEB_URL ?? "http://localhost:4173";
const step = (text) => console.log(`\n▸ ${text}`);
const ok = (text) => console.log(`  ✓ ${text}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await chromium.launch({ channel: "chromium", headless: process.env.HEADED !== "1" });
const page = await browser.newPage();
page.on("pageerror", (error) => console.log(`  [page] ${error.message}`));
const chats = () => page.evaluate(() => Object.keys(localStorage).filter((key) => {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "");
    return key.startsWith("ghostly_") && value?.mySeedB64 && value?.peerPubKeyB64;
  } catch {
    return false;
  }
}).length);
async function expectChats(n, what) {
  // reconcile runs every 5 s; a chat that comes back does so within two rounds
  await sleep(12_000);
  const count = await chats();
  if (count !== n) throw new Error(`${what}: ${count} chats, expected ${n}`);
  ok(`${what}: ${n} chats`);
}
async function newChats(n) {
  for (let i = 0; i < n; i++) {
    const before = await chats();
    await page.getByTitle("New Chat").click();
    await page.getByRole("button", { name: "Create New Chat" }).first().click();
    for (let t = 0; t < 50 && (await chats()) === before; t++) await sleep(200);
    await page.goto(`${url}/#/`);
    await page.getByTitle("New Chat").waitFor();
  }
  // links younger than 15 s are never dropped; make these old enough to matter
  await sleep(16_000);
}

let failed = false;
try {
  step(`open ${url}`);
  await page.goto(url);
  await page.getByTitle("New Chat").waitFor();
  await page.evaluate(() => localStorage.setItem("ghostly_app_settings", JSON.stringify({ theme: "purple", mode: "dark", language: "en" })));

  step("delete all chats");
  await newChats(2);
  await expectChats(2, "before");
  await page.getByTitle("Delete all chats").click();
  await page.getByRole("button", { name: "Delete all chats" }).click();
  await expectChats(0, "after deleting");
  await page.reload();
  await page.getByTitle("New Chat").waitFor();
  await expectChats(0, "after a reload");
  const settings = await page.evaluate(() => localStorage.getItem("ghostly_app_settings"));
  if (!settings?.includes("purple")) throw new Error(`settings were lost: ${settings}`);
  ok("settings kept");

  step("clear all data");
  await newChats(1);
  await page.goto(`${url}/#/settings`);
  await page.getByRole("button", { name: "Clear all data" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await page.goto(`${url}/#/`);
  await expectChats(0, "after clearing all data");
} catch (error) {
  failed = true;
  console.log(`  ✗ ${error.message}`);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
