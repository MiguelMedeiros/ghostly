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
  const downloadPromise = b.page.waitForEvent("download");
  await bubble.getByTestId("file-save").click({ timeout: 60_000 });
  const download = await downloadPromise;
  const saved = readFileSync(await download.path());
  expect("3 MiB file intact after the transfer", createHash("sha256").update(saved).digest("hex"), BIG_SHA256);
  expect("suggested name", download.suggestedFilename(), "haunted house.bin");
  await a.page.getByTestId("file-bubble").getByTestId("file-status").filter({ hasText: "3.0 MB" }).waitFor();
  ok("A shows the file as sent");

  step("Video call with the signaling Ghostly Desktop uses (_call)");
  await a.page.bringToFront();
  await a.page.getByTitle("Video call").click();
  await b.page.getByTitle("Accept video call").click({ timeout: 90_000 });
  await Promise.all([a, b].map((peer) => peer.page.getByText(/^\d{1,2}:\d{2}$/).first().waitFor({ timeout: 90_000 })));
  ok("both sides connected with audio and video");
  await a.page.getByTitle("End call").click();
  await b.page.getByTitle("End call").waitFor({ state: "detached", timeout: 60_000 });
  ok("hang up reaches the peer");

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
