/**
 * Ghostly on the web talking to Ghostly Browser (the extension): same protocol,
 * same UI, different hosts.
 *
 *   docker compose up --build -d     # the web app on http://localhost:8080
 *   npm run build:extension && node web/test/e2e.mjs
 *
 * Original note of the extension test, which this one borrows its setup from:
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
import { BIG, BIG_SHA256 } from "../../extension/test/atlas.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), "ghostly-e2e-"));
const headless = process.env.HEADED !== "1";
const step = (text) => console.log(`\n▸ ${text}`);
const ok = (text) => console.log(`  ✓ ${text}`);

// Chrome's permission prompt cannot be clicked by automation, so the test build
// has the localhost permission granted up front. Everything else is the shipped code.
const extensionDir = join(work, "extension");
cpSync(join(here, "..", "..", "extension", "dist"), extensionDir, { recursive: true });
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


const WEB_URL = process.env.WEB_URL ?? "http://localhost:8080";

async function launchWebPeer(name) {
  const context = await chromium.launchPersistentContext(join(work, name), {
    channel: "chromium",
    headless,
    args: ["--disable-features=WebRtcHideLocalIpsWithMdns", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && console.log(`  [${name}] ${m.text()}`));
  await page.goto(WEB_URL);
  await page.getByTitle("New Chat").waitFor();
  return { name, context, page };
}

let failed = false;
let ext, web;
const expect = (label, actual, wanted) => {
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
  ok(label);
};
const say = async (peer, text) => {
  await peer.page.getByPlaceholder("Type a message").fill(text);
  await peer.page.getByPlaceholder("Type a message").press("Enter");
};

try {
  step("One peer is the extension, the other is a plain web page");
  [ext, web] = await Promise.all([launchPeer("extension"), launchWebPeer("web")]);
  ok("both are up");

  step("A second tab of the web app stays out of the way");
  const second = await web.context.newPage();
  await second.goto(WEB_URL);
  await second.getByText("already open in another tab").waitFor({ timeout: 15_000 });
  await second.close();
  ok("only one tab runs the peer");

  step("The web page creates a chat, the extension joins");
  await web.page.getByTitle("New Chat").click();
  await web.page.getByRole("button", { name: "Create New Chat" }).first().click();
  const invite = (await web.page.locator("code").first().textContent()).trim();
  await ext.page.getByTitle("New Chat").click();
  await ext.page.getByPlaceholder("Invite code...").fill(invite);
  await ext.page.getByPlaceholder("Invite code...").press("Enter");
  await ext.page.getByPlaceholder("Type a message").waitFor();
  await say(ext, "boo from the extension");
  await web.page.getByText("boo from the extension").first().waitFor({ timeout: 120_000 });
  await say(web, "boo from the web");
  await ext.page.getByText("boo from the web").first().waitFor({ timeout: 120_000 });
  ok("messages in both directions");
  await web.page.getByTestId("datalink-state").filter({ hasText: "Peer to peer" }).waitFor({ timeout: 120_000 });
  ok("connected over WebRTC");

  step("A file from the web page to the extension");
  const filePath = join(work, "from the web.bin");
  writeFileSync(filePath, BIG);
  await web.page.getByTestId("file-input").setInputFiles(filePath);
  const bubble = ext.page.getByTestId("file-bubble").filter({ hasText: "from the web.bin" });
  await bubble.getByTestId("file-save").waitFor({ timeout: 120_000 });
  const downloadPromise = ext.page.waitForEvent("download");
  await bubble.getByTestId("file-save").click();
  const saved = readFileSync(await (await downloadPromise).path());
  expect("3 MiB file intact", createHash("sha256").update(saved).digest("hex"), BIG_SHA256);

  step("Sats (public test mint, worthless test sats)");
  for (const peer of [ext, web]) {
    await peer.page.getByTestId("wallet-settings").click();
    await peer.page.getByTestId("wallet-test-mint").click();
    await peer.page.getByTestId("wallet-test-balance").waitFor({ timeout: 30_000 });
    await peer.page.getByTestId("wallet-settings").click();
  }
  await web.page.getByTestId("wallet-receive").click();
  await web.page.getByTestId("wallet-receive-amount").fill("100");
  await web.page.getByTestId("wallet-create-invoice").click();
  await web.page.getByTestId("wallet-test-balance").filter({ hasText: /^100 test sats/ }).waitFor({ timeout: 60_000 });
  await web.page.getByTestId("payment-button").click();
  await web.page.getByTestId("payment-amount").fill("21");
  await web.page.getByTestId("payment-send").click();
  await ext.page.getByTestId("wallet-test-balance").filter({ hasText: /^21 test sats/ }).waitFor({ timeout: 60_000 });
  ok("the web page received over Lightning and paid the extension 21 sats");

  step("What a web page cannot do is said plainly");
  expect("no way to share a local service", await web.page.getByTestId("add-service").count(), 0);
  await web.page.getByText("needs the Ghostly browser extension or desktop app").first().waitFor();
  ok("the UI explains why");

  step("Video call between the web page and the extension");
  await web.page.getByTitle("Video call").click();
  await ext.page.getByTitle("Accept video call").click({ timeout: 90_000 });
  await Promise.all([ext, web].map((peer) => peer.page.getByText(/^\d{1,2}:\d{2}$/).first().waitFor({ timeout: 90_000 })));
  ok("connected");
  await web.page.getByTitle("End call").click();

  console.log("\nAll good. 👻");
} catch (error) {
  failed = true;
  console.error("\n✗", error);
  for (const peer of [ext, web]) await peer?.page.screenshot({ path: join(here, `failure-${peer.name}.png`) }).catch(() => {});
} finally {
  await ext?.context.close().catch(() => {});
  await web?.context.close().catch(() => {});
  rmSync(work, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
