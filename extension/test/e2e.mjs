/**
 * End-to-end proof of the milestone: two Chromium profiles, each running the
 * Ghostly extension, find each other through real Pkarr relays, connect over
 * WebRTC, chat, and one opens a local web app the other shares.
 *
 *   npm run build -w @ghostly/extension && npm run test:e2e -w @ghostly/extension
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { BIG_SHA256, startAtlas } from "./atlas.mjs";

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
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && console.log(`  [${name}] ${m.text()}`));
  await page.goto(`chrome-extension://${extensionId}/app.html`);
  await page.getByTestId("create-link").waitFor();
  return { name, context, page };
}

let failed = false;
const atlas = await startAtlas();
let a, b;
try {
  step("Two browsers install Ghostly");
  [a, b] = await Promise.all([launchPeer("chrome-a"), launchPeer("chrome-b")]);
  ok("both peers are up");

  step("A creates a link, B joins with the invite");
  await a.page.getByTestId("create-link").click();
  const invite = (await a.page.getByTestId("invite-code").textContent()).trim();
  await b.page.getByTestId("invite-input").fill(invite);
  await b.page.getByTestId("join-link").click();
  await b.page.getByTestId("message-input").waitFor();
  ok("linked");

  step("Text through Pkarr (the path Ghostly Desktop uses)");
  await b.page.getByTestId("message-input").fill("boo from B");
  await b.page.getByTestId("message-send").click();
  await a.page.getByTestId("message").filter({ hasText: "boo from B" }).waitFor({ timeout: 90_000 });
  ok("A received B's message via the DHT");
  await a.page.getByTestId("peer-presence").filter({ hasText: "Online" }).waitFor({ timeout: 60_000 });
  ok("A sees B online");

  step(`A shares Atlas → http://localhost:${atlas.port}`);
  await a.page.getByTestId("add-service").click();
  await a.page.getByTestId("service-name").fill("Atlas");
  await a.page.getByTestId("service-target").fill(`localhost:${atlas.port}`);
  await a.page.getByTestId("service-save").click();
  await a.page.getByTestId("service-item").filter({ hasText: "Shared with your peers" }).waitFor();
  ok("A advertises the service");

  step("B discovers Atlas and opens it");
  await b.page.getByTestId("peer-service").filter({ hasText: "Atlas" }).waitFor({ timeout: 90_000 });
  ok("B sees Atlas in A's services (from the signed, encrypted _svc record)");
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

  step("Navigation and redirects stay inside the virtual origin");
  await viewer.locator("#next").click();
  await viewer.waitForSelector("text=Page two");
  expect("redirect followed by the client", new URL(viewer.url()).pathname, "/page2");

  step("Chat now flows over the data link");
  await b.page.bringToFront();
  await b.page.getByTestId("datalink-state").filter({ hasText: "Connected peer to peer" }).waitFor();
  await a.page.getByTestId("message-input").fill("boo back over WebRTC");
  await a.page.getByTestId("message-send").click();
  await b.page.getByTestId("message").filter({ hasText: "boo back over WebRTC" }).filter({ hasText: "WebRTC" }).waitFor({ timeout: 15_000 });
  ok("B received A's message over WebRTC");

  step("A stops sharing: the service id no longer resolves");
  await a.page.getByTestId("service-item").getByRole("button", { name: "Stop" }).click();
  await viewer.goto(viewer.url().replace("/page2", "/"));
  await viewer.waitForSelector("text=This peer does not share that service");
  ok("requests are refused by A");
  await a.page.getByTestId("service-item").getByRole("button", { name: "Share" }).click();
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
