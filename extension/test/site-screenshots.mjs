/**
 * Regenerates the app screenshots the website shows (website/public/screenshots/app-*.png)
 * from the real UI: two Ghostly Browser peers talking to each other through real relays,
 * with a small local site to share and worthless test sats for the wallet.
 *
 *   npm run build:extension && node extension/test/site-screenshots.mjs
 */
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "..", "website", "public", "screenshots");
const work = mkdtempSync(join(tmpdir(), "ghostly-shots-"));
const VIEWPORT = { width: 1024, height: 793 };
const TITLE_BAR = 28;

// -- something worth sharing: a tiny photo gallery on localhost ------------------
const TILES = ["#22d3ee,#0e7490", "#34d399,#047857", "#a78bfa,#5b21b6", "#fbbf24,#b45309", "#f472b6,#9d174d", "#38bdf8,#075985", "#fb7185,#9f1239", "#4ade80,#166534", "#c084fc,#6b21a8"];
const GALLERY = `<!doctype html><meta charset="utf-8"><title>My photos</title>
<body style="margin:0;background:#0b1220;color:#e5e7eb;font:16px system-ui">
<header style="display:flex;justify-content:space-between;align-items:center;padding:28px 40px">
  <h1 style="margin:0;font-size:26px">My photos</h1><span style="color:#64748b">summer ’26 · 9 photos</span></header>
<main style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:0 40px 40px">
${TILES.map((t) => `<div style="aspect-ratio:4/3;border-radius:14px;background:linear-gradient(135deg,${t})"></div>`).join("")}
</main>`;
const gallery = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(GALLERY));
await new Promise((resolve) => gallery.listen(0, "127.0.0.1", resolve));
const galleryPort = gallery.address().port;

// -- two peers ---------------------------------------------------------------------
const extensionDir = join(work, "extension");
cpSync(join(here, "..", "dist"), extensionDir, { recursive: true });
const manifestPath = join(extensionDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.host_permissions = manifest.optional_host_permissions;
delete manifest.optional_host_permissions;
writeFileSync(manifestPath, JSON.stringify(manifest));

async function launchPeer(name, nickname) {
  const context = await chromium.launchPersistentContext(join(work, name), {
    channel: "chromium",
    headless: true,
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/app.html`);
  await page.getByTitle("New Chat").waitFor();
  await page.evaluate((nick) => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings"));
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, defaultNickname: nick }));
  }, nickname);
  await page.reload();
  await page.getByTitle("New Chat").waitFor();
  return { name, context, page };
}

// -- window chrome around a raw screenshot -------------------------------------------
const framer = await chromium.launch({ channel: "chromium", headless: true });
async function frame(png, file, chrome) {
  const page = await framer.newPage({ viewport: { width: VIEWPORT.width, height: VIEWPORT.height + TITLE_BAR }, deviceScaleFactor: 2 });
  const lights = `<span style="display:flex;gap:8px;position:absolute;left:12px">${["#ff5f57", "#febc2e", "#28c840"]
    .map((c) => `<i style="width:12px;height:12px;border-radius:50%;background:${c}"></i>`)
    .join("")}</span>`;
  const bar =
    chrome.kind === "app"
      ? `<b style="font:600 13px system-ui;color:#b4b4b4">${chrome.title}</b>`
      : `<span style="font:12px ui-monospace,monospace;color:#9ca3af;background:#111827;border-radius:6px;padding:3px 14px;min-width:60%;text-align:center">🔒 ${chrome.url}</span>`;
  await page.setContent(`<body style="margin:0;background:#1f1f1f">
    <div style="height:${TITLE_BAR}px;display:flex;align-items:center;justify-content:center;position:relative;background:#2a2a2a">${lights}${bar}</div>
    <img src="data:image/png;base64,${png.toString("base64")}" style="display:block;width:${VIEWPORT.width}px;height:${VIEWPORT.height}px"></body>`);
  await page.screenshot({ path: join(out, file) });
  await page.close();
  console.log("✓", file);
}
const APP = { kind: "app", title: "Ghostly" };
const shoot = async (peer, file) => {
  // Images load after the chat scrolled; make sure the newest message is what shows.
  await peer.page.evaluate(() => document.querySelector(".chat-wallpaper")?.scrollTo(0, 1e9));
  await peer.page.waitForTimeout(300);
  await frame(await peer.page.screenshot(), file, APP);
};
const say = async (peer, text) => {
  await peer.page.getByPlaceholder("Type a message").fill(text);
  await peer.page.getByPlaceholder("Type a message").press("Enter");
  await peer.page.waitForTimeout(700);
};

const [boo, casper] = await Promise.all([launchPeer("boo", "Boo"), launchPeer("casper", "Casper")]);
try {
  await shoot(casper, "app-home.png");

  await boo.page.getByTitle("New Chat").click();
  await boo.page.waitForTimeout(600);
  await shoot(boo, "app-new-chat.png");
  await boo.page.getByRole("button", { name: "Create New Chat" }).first().click();
  const invite = (await boo.page.locator("code").first().textContent()).trim();
  await casper.page.getByTitle("New Chat").click();
  await casper.page.getByPlaceholder("Invite code...").fill(invite);
  await casper.page.getByPlaceholder("Invite code...").press("Enter");
  await casper.page.getByPlaceholder("Type a message").waitFor();

  await say(casper, "boo! 👻");
  await boo.page.getByText("boo! 👻").first().waitFor({ timeout: 120_000 });
  await Promise.all([boo, casper].map((p) => p.page.getByTestId("datalink-state").filter({ hasText: "Peer to peer" }).waitFor({ timeout: 120_000 })));
  await say(boo, "who goes there?");
  await say(casper, "just a friendly ghost. what are you building?");
  await say(boo, "a photo gallery. it only lives on my localhost…");

  await boo.page.getByTestId("add-service").click();
  await boo.page.getByTestId("service-name").fill("My photos");
  await boo.page.getByTestId("service-target").fill(`localhost:${galleryPort}`);
  await boo.page.waitForTimeout(400);
  await shoot(boo, "app-share-form.png");
  await boo.page.getByTestId("service-save").click();
  await casper.page.getByTestId("open-service").filter({ hasText: "My photos" }).waitFor({ timeout: 120_000 });
  await say(boo, "…not anymore ✨ open it!");

  // Sats: worthless ones from the public test mint.
  for (const peer of [boo, casper]) {
    await peer.page.getByTestId("wallet-settings").click();
    await peer.page.getByTestId("wallet-test-mint").click();
    await peer.page.getByTestId("wallet-test-balance").waitFor({ timeout: 30_000 });
    await peer.page.getByTestId("wallet-settings").click();
  }
  await casper.page.getByTestId("wallet-receive").click();
  await casper.page.getByTestId("wallet-receive-amount").fill("5000");
  await casper.page.getByTestId("wallet-create-invoice").click();
  await casper.page.getByTestId("wallet-paid").waitFor({ timeout: 60_000 });
  await casper.page.getByRole("button", { name: "Done" }).click();

  const photo = join(work, "haunted-house.png");
  cpSync(join(here, "..", "..", "hero-banner.png"), photo);
  await boo.page.getByTestId("file-input").setInputFiles(photo);
  await casper.page.getByTestId("file-save").first().waitFor({ timeout: 120_000 });
  await say(casper, "love it. here, for the pizza 🍕");
  await casper.page.getByTestId("payment-button").click();
  await casper.page.getByTestId("payment-amount").fill("2100");
  await casper.page.getByPlaceholder("What for? (optional)").fill("pizza 🍕");
  await casper.page.getByTestId("payment-send").click();
  await boo.page.getByTestId("payment-bubble").filter({ hasText: "2,100" }).waitFor({ timeout: 60_000 });
  await boo.page.waitForTimeout(2500);

  await shoot(boo, "app-share.png");
  await shoot(casper, "app-chat-conversation.png");

  await boo.page.getByTestId("wallet-history").click();
  await boo.page.waitForTimeout(800);
  await shoot(boo, "app-sats.png");
  await boo.page.getByTestId("wallet-history").click();

  // The shared app, in a tab of its own on its virtual origin.
  const viewerPromise = casper.context.waitForEvent("page");
  await casper.page.getByTestId("open-service").filter({ hasText: "My photos" }).click();
  const viewer = await viewerPromise;
  await viewer.waitForSelector("text=My photos", { timeout: 180_000 });
  await viewer.setViewportSize(VIEWPORT);
  await viewer.waitForTimeout(800);
  const host = new URL(viewer.url()).hostname;
  await frame(await viewer.screenshot(), "app-friend-app.png", { kind: "browser", url: `${host.slice(0, 18)}…${host.slice(-22)}` });
  await viewer.close();

  await casper.page.bringToFront();
  await boo.page.getByTitle("Video call").click();
  await casper.page.getByTitle("Accept video call").waitFor({ timeout: 90_000 });
  await casper.page.waitForTimeout(600);
  await shoot(casper, "app-incoming-call.png");
  await casper.page.getByTitle("Decline").click();
  await boo.page.getByTitle("Video call").waitFor({ timeout: 30_000 });

  await casper.page.waitForTimeout(6000);
  await boo.page.getByTitle("Audio call").click();
  await casper.page.getByTitle("Accept audio call").click({ timeout: 90_000 });
  await casper.page.getByText(/^\d{1,2}:\d{2}$/).first().waitFor({ timeout: 90_000 });
  await casper.page.waitForTimeout(2500);
  await shoot(casper, "app-audio-call.png");
  await casper.page.getByTitle("End call").click();

  await casper.page.getByRole("button", { name: "Settings" }).click();
  await casper.page.waitForTimeout(800);
  await shoot(casper, "app-settings.png");
} finally {
  await boo.context.close();
  await casper.context.close();
  await framer.close();
  gallery.close();
  rmSync(work, { recursive: true, force: true });
}
