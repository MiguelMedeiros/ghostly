/**
 * End-to-end proof of the milestone: two Chromium profiles, each running the
 * Ghostly extension, find each other through real Pkarr relays, connect over
 * WebRTC, chat, and one opens a local web app the other shares.
 *
 *   npm run build -w @ghostly/extension && npm run test:e2e -w @ghostly/extension
 */
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Wallet, getEncodedToken } from "@cashu/cashu-ts";
import { BIG, BIG_SHA256, startAtlas } from "./atlas.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), "ghostly-e2e-"));
const headless = process.env.HEADED !== "1";
const step = (text) => console.log(`\n▸ ${text}`);
const ok = (text) => console.log(`  ✓ ${text}`);

// Chrome's permission prompt cannot be clicked by automation, so the test build
// has the localhost permission granted up front. Everything else is the shipped code.
const extensionDir = join(work, "extension");
cpSync(join(here, "..", "dist"), extensionDir, { recursive: true });
const manifestPath = join(extensionDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.host_permissions = manifest.optional_host_permissions;
delete manifest.optional_host_permissions;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

async function launchPeer(name) {
  const context = await chromium.launchPersistentContext(join(work, name), {
    channel: "chromium",
    headless,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      // Both peers share one machine: let ICE use plain host addresses.
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      // getDisplayMedia without a person to pick the source.
      "--auto-select-desktop-capture-source=Entire screen",
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && console.log(`  [${name}] ${m.text()}`));
  await page.goto(`chrome-extension://${extensionId}/app.html`);
  await page.getByTitle("New Chat").waitFor();
  return { name, context, page };
}

let failed = false;
const atlas = await startAtlas();
let a, b;
try {
  step("Two browsers install Ghostly");
  [a, b] = await Promise.all([launchPeer("chrome-a"), launchPeer("chrome-b")]);
  ok("both peers are up");

  step("A creates a chat, B joins with the invite code");
  await a.page.getByTitle("New Chat").click();
  await a.page.getByRole("button", { name: "Create New Chat" }).first().click();
  const invite = (await a.page.locator("code").first().textContent()).trim();
  await b.page.getByTitle("New Chat").click();
  await b.page.getByPlaceholder("Invite code...").fill(invite);
  await b.page.getByPlaceholder("Invite code...").press("Enter");
  await b.page.getByPlaceholder("Type a message").waitFor();
  ok("linked");

  const say = async (peer, text) => {
    await peer.page.getByPlaceholder("Type a message").fill(text);
    await peer.page.getByPlaceholder("Type a message").press("Enter");
  };

  step("Text through Pkarr (the path Ghostly Desktop uses)");
  await say(b, "boo from B");
  await a.page.getByText("boo from B").first().waitFor({ timeout: 120_000 });
  ok("A received B's message via the DHT");
  const textBox = await a.page.getByText("boo from B").first().boundingBox();
  const chatPane = await a.page.locator(".chat-wallpaper").boundingBox();
  if (textBox.x - chatPane.x < 40) throw new Error(`chat bubbles lost their side padding (${textBox.x - chatPane.x}px from the edge)`);
  ok("bubbles keep their distance from the edge of the chat");
  await a.page.getByText("joined").first().waitFor({ timeout: 60_000 });
  ok("the join announcement Desktop sends arrived too");

  step(`A shares Atlas → http://localhost:${atlas.port}`);
  await a.page.getByTestId("add-service").click();
  await a.page.getByTestId("service-name").fill("Atlas");
  await a.page.getByTestId("service-target").fill(`localhost:${atlas.port}`);
  await a.page.getByTestId("service-save").click();
  await a.page.getByTestId("service-item").filter({ hasText: "Shared with your contacts" }).waitFor();
  ok("A advertises the service");

  step("B discovers Atlas and opens it");
  await b.page.getByTestId("open-service").filter({ hasText: "Atlas" }).waitFor({ timeout: 120_000 });
  ok("B sees Atlas among A's services");
  const viewerPromise = b.context.waitForEvent("page");
  await b.page.getByTestId("open-service").click();
  const viewer = await viewerPromise;
  await viewer.waitForSelector("body[data-ready='1']", { timeout: 150_000 });
  const out = JSON.parse(await viewer.locator("#out").textContent());
  console.log("  page reported:", JSON.stringify(out));

  const expect = (label, actual, wanted) => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
    ok(label);
  };
  expect("virtual origin", new URL(viewer.url()).hostname.endsWith(".ghostly.invalid"), true);
  expect("inline script ran", out.inline, true);
  expect("secure context", out.secure, true);
  expect("stylesheet applied", out.css, "rgb(1, 2, 3)");
  expect("POST with JSON body, query and custom header", out.echo, { body: { hello: "ghost" }, query: "?x=1", header: "yes" });
  expect("3 MiB binary download intact", out.bigSha, BIG_SHA256);
  expect("404 passes through", out.missing, 404);
  expect("image decoded", out.image, 1);
  expect("requests reached A's localhost", atlas.requests.some((r) => r.path === "/lib/hash.js"), true);
  expect("the local app never received cookies", atlas.requests.every((r) => !r.headers.cookie), true);
  const post = atlas.requests.find((r) => r.method === "POST");
  console.log(`  local app saw: origin=${post.headers.origin} referer=${post.headers.referer} host=${post.headers.host}`);

  step("Navigation and redirects stay inside the virtual origin");
  await viewer.locator("#next").click();
  await viewer.waitForSelector("text=Page two");
  expect("redirect followed by the client", new URL(viewer.url()).pathname, "/page2");

  step("Chat now flows over the data link");
  await b.page.bringToFront();
  await b.page.getByTestId("datalink-state").filter({ hasText: "Peer to peer" }).waitFor();
  await say(a, "boo back over WebRTC");
  await b.page.getByText("boo back over WebRTC").first().waitFor({ timeout: 10_000 });
  ok("B received A's message over WebRTC");

  step("A file, peer to peer");
  const filePath = join(work, "haunted house.bin");
  writeFileSync(filePath, BIG);
  await a.page.getByTestId("file-input").setInputFiles(filePath);
  const bubble = b.page.getByTestId("file-bubble").filter({ hasText: "haunted house.bin" });
  await bubble.waitFor({ timeout: 30_000 });
  ok("B sees the file arriving");
  await bubble.getByTestId("file-save").waitFor({ timeout: 120_000 });
  const downloadPromise = b.page.waitForEvent("download");
  await bubble.getByTestId("file-save").click();
  const download = await downloadPromise;
  const saved = readFileSync(await download.path());
  expect("3 MiB file intact after the transfer", createHash("sha256").update(saved).digest("hex"), BIG_SHA256);
  expect("suggested name", download.suggestedFilename(), "haunted house.bin");
  await a.page.getByTestId("file-bubble").getByTestId("file-status").filter({ hasText: "3.0 MB" }).waitFor();
  ok("A shows the file as sent");

  step("Sats: Lightning in, ecash between the peers (public test mint, worthless test sats)");
  // Wallets start with real mints; the test never touches them. The test mint becomes primary.
  for (const peer of [a, b]) {
    await peer.page.getByTestId("wallet-settings").click();
    await peer.page.getByTestId("wallet-test-mint").click();
    await peer.page.getByTestId("wallet-test-balance").waitFor({ timeout: 30_000 });
    await peer.page.getByTestId("wallet-settings").click();
  }
  await a.page.getByTestId("wallet-receive").click({ timeout: 30_000 });
  await a.page.getByTestId("wallet-receive-amount").fill("100");
  await a.page.getByTestId("wallet-create-invoice").click();
  const invoice = (await a.page.getByTestId("wallet-invoice").textContent({ timeout: 30_000 })).trim();
  expect("the mint issued a Lightning invoice", invoice.startsWith("lnbc"), true);
  // The test mint marks its invoices as paid by itself.
  await a.page.getByTestId("wallet-test-balance").filter({ hasText: /^100 test sats/ }).waitFor({ timeout: 60_000 });
  ok("paid invoice became 100 sats of ecash in A's wallet");

  await a.page.getByTestId("payment-button").click();
  await a.page.getByTestId("payment-amount").fill("21");
  await a.page.getByTestId("payment-send").click();
  await b.page.getByTestId("payment-bubble").filter({ hasText: "21" }).locator("[data-testid=payment-state]").filter({ hasText: "Received" }).waitFor({ timeout: 60_000 });
  await a.page.getByTestId("payment-bubble").filter({ hasText: "21" }).locator("[data-testid=payment-state]").filter({ hasText: "Received" }).waitFor({ timeout: 30_000 });
  await b.page.getByTestId("wallet-test-balance").filter({ hasText: /^21 test sats/ }).waitFor({ timeout: 30_000 });
  ok("A sent 21 sats, B redeemed them and A got the receipt");

  await b.page.getByTestId("payment-button").click();
  await b.page.getByTestId("payment-amount").fill("10");
  await b.page.getByTestId("payment-request").click();
  await a.page.getByTestId("payment-pay").click({ timeout: 60_000 });
  for (const peer of [a, b]) {
    await peer.page.getByTestId("payment-bubble").filter({ hasText: "equest" }).locator("[data-testid=payment-state]").filter({ hasText: "Paid" }).waitFor({ timeout: 60_000 });
  }
  await b.page.getByTestId("wallet-test-balance").filter({ hasText: /^31 test sats/ }).waitFor({ timeout: 30_000 });
  ok("B requested 10 sats, A paid the request, both see it paid");

  await a.page.getByTestId("wallet-history").click();
  const txs = await a.page.getByTestId("wallet-tx").allTextContents();
  expect("A's history lists the invoice and both payments", txs.length, 3);
  // The test mint charges 100 ppk: each ecash payment costs A a sat or two, the Lightning receive nothing.
  expect("every movement shows what it cost", [txs[2].includes("no fee"), /fee \d/.test(txs[1]), /fee \d/.test(txs[0])], [true, true, true]);
  const feesPaid = Number((await a.page.getByTestId("wallet-fees-paid").textContent()).match(/(\d+) sats/)[1]);
  const left = Number((await a.page.getByTestId("wallet-test-balance").textContent()).match(/^([\d,]+)/)[1].replace(",", ""));
  expect("balance = received - sent - fees, to the sat", left, 100 - 21 - 10 - feesPaid);
  await a.page.getByTestId("wallet-history").click();
  await a.page.getByTestId("wallet-settings").click();
  await a.page.getByTestId("mint-fees").filter({ hasText: "0.1 sat per proof" }).waitFor({ timeout: 30_000 });
  ok("the mint's own fee schedule is shown");
  await a.page.getByTestId("wallet-settings").click();

  step("Money pasted into the chat is shown as a card (still the test mint)");
  // B asks its mint for an invoice and pastes it, the way people share invoices everywhere else.
  await b.page.getByTestId("wallet-receive").click();
  await b.page.getByTestId("wallet-receive-amount").fill("12");
  await b.page.getByTestId("wallet-create-invoice").click();
  const pasted = (await b.page.getByTestId("wallet-invoice").textContent({ timeout: 30_000 })).trim();
  await b.page.getByTestId("wallet-receive").click();
  await b.page.getByPlaceholder("Type a message").fill(`coffee? ${pasted}`);
  await b.page.getByPlaceholder("Type a message").press("Enter");
  const card = a.page.getByTestId("invoice-bubble").last();
  await card.waitFor({ timeout: 60_000 });
  expect("A sees the amount instead of a wall of characters", (await card.getByTestId("money-amount").textContent()).trim(), "12");
  expect("the rest of the message is kept", await a.page.getByText("coffee?", { exact: true }).count(), 1);
  expect("the card carries a QR code", await card.locator("svg").count() > 0, true);
  expect("B cannot pay its own invoice", await b.page.getByTestId("invoice-bubble").last().getByTestId("invoice-pay").count(), 0);
  await card.getByTestId("invoice-pay").click();
  await card.getByTestId("invoice-confirm").waitFor({ timeout: 30_000 });
  ok("the wallet quotes the invoice, fee reserve included, before anything is paid");
  // The test mint settles its own invoices by itself, so by now this one is already paid. The card
  // has to end up saying so without spending anything; a real payment takes the same path minus the refusal.
  await card.getByTestId("invoice-confirm").click();
  await card.getByTestId("invoice-paid").waitFor({ timeout: 60_000 }).catch(async (error) => {
    console.log("    card says:", (await card.textContent()).slice(0, 400));
    throw error;
  });
  ok("the card ends up paid");

  // An ecash token minted outside Ghostly (worthless test sats), pasted like any other text.
  const outside = new Wallet("https://testnut.cashu.space", { unit: "sat" });
  await outside.loadMint();
  const minted = await outside.createMintQuoteBolt11(7);
  let proofs;
  for (let attempt = 0; !proofs; attempt++) {
    try {
      proofs = await outside.mintProofsBolt11(7, minted.quote);
    } catch (error) {
      if (attempt > 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  const token = getEncodedToken({ mint: "https://testnut.cashu.space", proofs, unit: "sat", memo: "lunch" });
  const before = Number((await a.page.getByTestId("wallet-test-balance").textContent()).match(/^([\d,]+)/)[1].replace(",", ""));
  await b.page.getByPlaceholder("Type a message").fill(token);
  await b.page.getByPlaceholder("Type a message").press("Enter");
  const tokenCard = a.page.getByTestId("cashu-token-bubble").last();
  await tokenCard.waitFor({ timeout: 60_000 });
  expect("an ecash token shows its amount, mint and memo", [(await tokenCard.getByTestId("money-amount").textContent()).trim(), /testnut\.cashu\.space/.test(await tokenCard.textContent()), /lunch/.test(await tokenCard.textContent())], ["7", true, true]);
  await tokenCard.getByTestId("token-redeem").click();
  await tokenCard.getByTestId("token-redeemed").waitFor({ timeout: 60_000 });
  const after = Number((await a.page.getByTestId("wallet-test-balance").textContent()).match(/^([\d,]+)/)[1].replace(",", ""));
  expect("redeeming it adds the sats, minus the mint's fee", after > before && after <= before + 7, true);

  if (process.env.SHOTS) {
    await a.page.screenshot({ path: `${process.env.SHOTS}/invoice-card-payer.png` });
    await b.page.screenshot({ path: `${process.env.SHOTS}/invoice-card-owner.png` });
  }

  step("Video call with the signaling Ghostly Desktop uses (_call)");
  await a.page.bringToFront();
  await a.page.getByTitle("Video call").click();
  await b.page.getByTitle("Accept video call").click({ timeout: 90_000 });
  await Promise.all([a, b].map((peer) => peer.page.getByText(/^\d{1,2}:\d{2}$/).first().waitFor({ timeout: 90_000 })));
  ok("both sides connected with audio and video");

  // Screen sharing swaps the track the video sender carries: no new signaling, so any peer in a video call gets it.
  const remoteSize = () =>
    b.page.evaluate(() => {
      const video = [...document.querySelectorAll("video")].find((v) => !v.muted);
      return video ? `${video.videoWidth}x${video.videoHeight}` : "none";
    });
  const until = async (check, what) => {
    for (let i = 0; i < 60; i++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  await until(async () => (await remoteSize()) !== "0x0" && (await remoteSize()) !== "none", "B to see A's camera");
  const cameraSize = await remoteSize();
  await a.page.getByTestId("share-screen").click();
  await a.page.getByTitle("Stop sharing your screen").waitFor({ timeout: 30_000 });
  await until(async () => (await remoteSize()) !== cameraSize, "B to see A's screen");
  ok(`B sees A's screen instead of the camera (${cameraSize} → ${await remoteSize()})`);
  await a.page.getByTestId("share-screen").click();
  await until(async () => (await remoteSize()) === cameraSize, "the camera to come back");
  ok("and the camera again when A stops sharing");

  // Your own picture can be moved out of the way and resized from any corner, and never leaves the window.
  const selfView = a.page.getByTestId("call-self-view");
  const inside = (box) => box.x >= 0 && box.y >= 0 && box.x + box.width <= 1280 && box.y + box.height <= 720;
  const selfBefore = await selfView.boundingBox();
  await selfView.hover();
  await a.page.mouse.move(selfBefore.x + 5, selfBefore.y + selfBefore.height - 5);
  await a.page.mouse.down();
  await a.page.mouse.move(selfBefore.x - 200, selfBefore.y + selfBefore.height + 150, { steps: 8 });
  await a.page.mouse.up();
  const bigger = await selfView.boundingBox();
  expect("pulling the bottom left corner makes it bigger, the opposite corner stays put", [bigger.width > selfBefore.width + 150, Math.abs(bigger.x + bigger.width - (selfBefore.x + selfBefore.width)) < 2, Math.abs(bigger.y - selfBefore.y) < 2], [true, true, true]);
  expect("it keeps the shape of the camera picture", Math.abs(bigger.width / bigger.height - 4 / 3) < 0.02, true);
  await a.page.mouse.move(bigger.x + bigger.width - 5, bigger.y + bigger.height - 5);
  await a.page.mouse.down();
  await a.page.mouse.move(2000, 1500, { steps: 8 });
  await a.page.mouse.up();
  expect("pulled past the edge, it stops at the edge", inside(await selfView.boundingBox()), true);
  const wide = await selfView.boundingBox();
  await a.page.mouse.move(wide.x + wide.width / 2, wide.y + wide.height / 2);
  await a.page.mouse.down();
  await a.page.mouse.move(-500, 2000, { steps: 8 });
  await a.page.mouse.up();
  const placed = await selfView.boundingBox();
  expect("dragged away, it moves, keeps its size and stays inside", [placed.x < wide.x - 100 || placed.y > wide.y + 100, Math.abs(placed.width - wide.width) < 2, inside(placed)], [true, true, true]);
  await selfView.dblclick();
  const reset = await selfView.boundingBox();
  expect("a double click puts it back", [Math.round(reset.width), Math.round(reset.x)], [240, 1280 - 256]);

  // The call can shrink into a floating window so the chat stays usable.
  await a.page.getByTestId("call-minimize").click();
  const mini = await a.page.getByTestId("call-window").boundingBox();
  expect("the call fits in a small window", mini.width < 500 && mini.height < 400, true);
  await a.page.getByPlaceholder("Type a message").fill("still here, on the call");
  await a.page.getByPlaceholder("Type a message").press("Enter");
  await b.page.getByTestId("call-minimize").click();
  await b.page.getByText("still here, on the call").first().waitFor({ timeout: 60_000 });
  ok("A chats while the call goes on, and B reads it");
  await a.page.mouse.move(mini.x + mini.width / 2, mini.y + mini.height / 2);
  await a.page.mouse.down();
  await a.page.mouse.move(200, 200, { steps: 8 });
  await a.page.mouse.up();
  const moved = await a.page.getByTestId("call-window").boundingBox();
  if (process.env.SHOTS) await b.page.screenshot({ path: `${process.env.SHOTS}/call-mini.png` });
  expect("the window can be dragged", Math.abs(moved.x - mini.x) > 50 || Math.abs(moved.y - mini.y) > 50, true);
  expect("the call is still up", /^\d{1,2}:\d{2}$/.test((await a.page.getByText(/^\d{1,2}:\d{2}$/).first().textContent()).trim()), true);
  await a.page.getByTestId("call-minimize").click();
  await b.page.getByTestId("call-minimize").click();
  await a.page.getByTitle("End call").click();
  await b.page.getByTitle("End call").waitFor({ state: "detached", timeout: 60_000 });
  ok("hang up reaches the peer");

  // A call can also start as a screen share; to B it is a video call like any other.
  await new Promise((resolve) => setTimeout(resolve, 6500));
  await a.page.getByTestId("call-screen").click();
  await b.page.getByTitle("Accept video call").click({ timeout: 90_000 });
  await b.page.getByText(/^\d{1,2}:\d{2}$/).first().waitFor({ timeout: 90_000 });
  await until(async () => (await remoteSize()) !== "none" && (await remoteSize()) !== "0x0" && (await remoteSize()) !== cameraSize, "B to see the shared screen");
  ok(`a call started from "Share your screen" shows the screen (${await remoteSize()})`);
  await a.page.getByTitle("End call").click();
  await b.page.getByTitle("End call").waitFor({ state: "detached", timeout: 60_000 });

  step("A stops sharing: the service id no longer resolves");
  await a.page.getByTestId("service-item").getByRole("button", { name: "Stop" }).click();
  await viewer.goto(viewer.url().replace("/page2", "/"));
  await viewer.waitForSelector("text=This peer does not share that service");
  ok("requests are refused by A");
  await a.page.getByTestId("service-item").getByRole("button", { name: "Share", exact: true }).click();
  await viewer.reload();
  await viewer.waitForSelector("body[data-ready='1']");
  ok("and served again once shared");

  step("A closes Ghostly: Atlas is gone");
  await a.context.close();
  a = null;
  await viewer.reload({ timeout: 200_000 });
  await viewer.waitForSelector("text=This service is not reachable", { timeout: 200_000 });
  ok("B can no longer reach Atlas");

  console.log("\nAll good. 👻");
} catch (error) {
  failed = true;
  console.error("\n✗", error);
  for (const peer of [a, b]) {
    if (!peer) continue;
    await peer.page.screenshot({ path: join(here, `failure-${peer.name}.png`) }).catch(() => {});
  }
} finally {
  await a?.context.close().catch(() => {});
  await b?.context.close().catch(() => {});
  atlas.server.close();
  rmSync(work, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
