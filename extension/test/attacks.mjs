/**
 * A malicious contact against a real Ghostly Browser. Two Chromium profiles
 * link through real Pkarr relays; "mallory" then attacks "victim":
 *
 * - through the viewer: a web app mallory shares tries to reach another app
 *   (requests, images, frames, navigation) and to plant a cookie in every
 *   viewer origin;
 * - through payments: forged `pay` frames that try to settle the victim's
 *   request with worthless test sats or with less than was asked.
 *
 * Mallory's forged frames go through the peer itself (the offscreen document
 * of a `--mode e2e` build exposes it as `__ghostly`), so the victim receives
 * exactly what a modified client would send.
 *
 *   npm run test:attacks -w @ghostly/extension
 *
 * EXT_DIR=<built extension> runs the same attacks against another build (the
 * payment attacks need an e2e build and are skipped otherwise).
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Wallet, getEncodedToken } from "@cashu/cashu-ts";
import { startAtlas } from "./atlas.mjs";
import { startEvil } from "./evil.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), "ghostly-attacks-"));
const headless = process.env.HEADED !== "1";
const TEST_MINT = "https://testnut.cashu.space";
const step = (text) => console.log(`\n▸ ${text}`);
const ok = (text) => console.log(`  ✓ ${text}`);
const results = [];
const check = (label, passed, detail = "") => {
  results.push({ label, passed });
  console.log(`  ${passed ? "✓" : "✗ VULNERABLE:"} ${label}${detail ? ` (${detail})` : ""}`);
};

const source = resolve(process.env.EXT_DIR ?? join(here, "..", "dist-e2e"));
if (!existsSync(join(source, "manifest.json"))) throw new Error(`no extension build at ${source}`);
const extensionDir = join(work, "extension");
cpSync(source, extensionDir, { recursive: true });
const manifestPath = join(extensionDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.host_permissions = manifest.optional_host_permissions;
delete manifest.optional_host_permissions;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

async function launchPeer(name, debugPort) {
  const context = await chromium.launchPersistentContext(join(work, name), {
    channel: "chromium",
    headless,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      `--remote-debugging-port=${debugPort}`,
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/app.html`);
  await page.getByTitle("New Chat").waitFor();
  return { name, context, page, debugPort };
}

/** Evaluates in the peer's offscreen document (the engine), over the DevTools protocol. */
async function engine(peer, expression) {
  const targets = await (await fetch(`http://127.0.0.1:${peer.debugPort}/json/list`)).json();
  const target = targets.find((t) => t.url.endsWith("/offscreen.html"));
  if (!target) throw new Error(`${peer.name}: no offscreen document`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  try {
    socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    const reply = await new Promise((resolve) => {
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id === 1) resolve(message);
      };
    });
    if (reply.result?.exceptionDetails) throw new Error(`${peer.name}: ${reply.result.exceptionDetails.exception?.description}`);
    return reply.result?.result?.value;
  } finally {
    socket.close();
  }
}

async function testSats(amount) {
  const wallet = new Wallet(TEST_MINT, { unit: "sat" });
  await wallet.loadMint();
  const quote = await wallet.createMintQuoteBolt11(amount);
  for (let attempt = 0; ; attempt++) {
    try {
      const proofs = await wallet.mintProofsBolt11(amount, quote.quote);
      return getEncodedToken({ mint: TEST_MINT, proofs, unit: "sat" });
    } catch (error) {
      if (attempt > 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

const until = async (check, what, ms = 60_000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log(`    (timed out waiting for ${what})`);
  return false;
};

let failed = false;
const atlas = await startAtlas();
const evil = await startEvil();
let victim, mallory;
try {
  step("Victim and mallory link up");
  [victim, mallory] = await Promise.all([launchPeer("victim", 9331), launchPeer("mallory", 9332)]);
  await mallory.page.getByTitle("New Chat").click();
  await mallory.page.getByRole("button", { name: "Create New Chat" }).first().click();
  const invite = (await mallory.page.locator("code").first().textContent()).trim();
  await victim.page.getByTitle("New Chat").click();
  await victim.page.getByPlaceholder("Invite code...").fill(invite);
  await victim.page.getByPlaceholder("Invite code...").press("Enter");
  await victim.page.getByPlaceholder("Type a message").waitFor();
  ok("linked");

  step("Mallory shares two apps: Atlas (stands for someone else's app) and Evil");
  for (const [name, port] of [
    ["Atlas", atlas.port],
    ["Evil", evil.port],
  ]) {
    await mallory.page.getByTestId("add-service").click();
    await mallory.page.getByTestId("service-name").fill(name);
    await mallory.page.getByTestId("service-target").fill(`localhost:${port}`);
    await mallory.page.getByTestId("service-save").click();
  }
  await victim.page.getByTestId("open-service").filter({ hasText: "Evil" }).waitFor({ timeout: 150_000 });
  ok("victim sees both");

  step("Victim opens Evil");
  let viewerPromise = victim.context.waitForEvent("page");
  await victim.page.getByTestId("open-service").filter({ hasText: "Evil" }).click();
  const evilTab = await viewerPromise;
  await evilTab.waitForSelector("body[data-ready='1']", { timeout: 150_000 });
  const out = JSON.parse(await evilTab.locator("#out").textContent());
  console.log(`  Evil runs on ${new URL(evilTab.url()).hostname.replace(/[a-z0-9]{52}/, "<peer>")}, reports ${JSON.stringify({ ...out, sibling: undefined })}`);
  const reached = (tag) => atlas.requests.some((r) => r.path.includes(`from=${tag}`));
  check("fetch to another app is refused", out.fetch === "blocked" && !reached("evil-fetch"));
  check("image from another app is refused", out.img === "blocked" && !reached("evil-img"));
  check("another app cannot be framed", !reached("evil-iframe"));
  check("no extension APIs in the app", out.chrome === false);
  await evilTab.evaluate((url) => (location.href = `${url}/?from=evil-nav`), out.sibling).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 5000));
  check("navigating the tab to another app is refused", !reached("evil-nav"));

  step("Victim opens Atlas: did Evil's cookie follow?");
  viewerPromise = victim.context.waitForEvent("page");
  await victim.page.bringToFront();
  await victim.page.getByTestId("open-service").filter({ hasText: "Atlas" }).click();
  const atlasTab = await viewerPromise;
  await atlasTab.waitForSelector("body[data-ready='1']", { timeout: 150_000 });
  const atlasCookies = await atlasTab.evaluate(() => document.cookie);
  check(`a cookie for "${out.parent}" does not reach another app`, !atlasCookies.includes("planted"), `Atlas sees "${atlasCookies}"`);

  const hooked = await engine(mallory, "typeof __ghostly !== 'undefined'").catch(() => false);
  if (!hooked) {
    console.log("\n  (payment attacks skipped: this build has no e2e hook)");
  } else {
    step("Payments: victim asks for 50 sats; its wallet only has real mints");
    await victim.page.bringToFront();
    await victim.page.getByTestId("datalink-state").filter({ hasText: "Peer to peer" }).waitFor({ timeout: 120_000 });
    const requestOnce = async () => {
      await victim.page.getByTestId("payment-button").click();
      await victim.page.getByTestId("payment-amount").fill("50");
      await victim.page.getByTestId("payment-request").click();
      let id = null;
      await until(async () => {
        id = await engine(mallory, `[...__ghostly.node.desk.payments.values()].filter(p => p.kind === "request" && p.direction === "in" && p.state === "pending").sort((a, b) => b.createdAt - a.createdAt)[0]?.id ?? null`);
        return id;
      }, "mallory to receive the request");
      return id;
    };
    const forgePay = async (requestId, amount, token) =>
      engine(
        mallory,
        `(async () => {
          const live = [...__ghostly.node.links.values()][0];
          await live.link.sendPayment({ id: "forged" + Date.now().toString(36) + "xx", timestamp: Date.now(), requestId: ${JSON.stringify(requestId)},
            amount: { value: "${amount}", asset: "sat" }, endpoint: ["cashu", ${JSON.stringify(token)}] });
          return true;
        })()`,
      );
    const victimRequest = (id) => engine(victim, `__ghostly.node.desk.payments.get(${JSON.stringify(id)})?.state ?? null`);
    const victimMints = () => engine(victim, `__ghostly.node.settings.mints`);

    const first = await requestOnce();
    if (!first) throw new Error("the request never reached mallory (is a default mint reachable?)");
    const mintsBefore = await victimMints();
    await forgePay(first, 50, await testSats(50));
    await new Promise((resolve) => setTimeout(resolve, 8000));
    check("50 worthless test sats do not pay a real request", (await victimRequest(first)) === "pending", `state ${await victimRequest(first)}`);
    const mintsAfter = await victimMints();
    check("a contact's ecash never adds a mint to the victim's wallet", !mintsAfter.includes(TEST_MINT) && mintsAfter.length === mintsBefore.length, mintsAfter.join(", "));

    step("Victim now uses the test mint too and asks for 50 again");
    await victim.page.getByTestId("wallet-settings").click();
    await victim.page.getByTestId("wallet-test-mint").click();
    await victim.page.getByTestId("wallet-test-balance").waitFor({ timeout: 30_000 });
    await victim.page.getByTestId("wallet-settings").click();
    const second = await requestOnce();
    await forgePay(second, 50, await testSats(5));
    const credited = await until(async () => (await engine(victim, `__ghostly.node.walletView.balance`)) > 0 || (await engine(victim, `[...__ghostly.node.desk.payments.values()].some(p => p.kind === "payment" && p.direction === "in")`)), "the 5 sats to arrive", 30_000);
    console.log(`    5 sats ${credited ? "arrived" : "did not arrive"} with a claim of 50`);
    check("5 sats claimed as 50 do not pay a 50 sat request", (await victimRequest(second)) === "pending", `state ${await victimRequest(second)}`);
  }

  failed = results.some((r) => !r.passed);
  console.log(failed ? `\n${results.filter((r) => !r.passed).length} attack(s) worked.` : "\nEvery attack was refused. 👻");
} catch (error) {
  failed = true;
  console.error("\n✗", error);
  for (const peer of [victim, mallory]) await peer?.page.screenshot({ path: join(here, `failure-${peer.name}.png`) }).catch(() => {});
} finally {
  await victim?.context.close().catch(() => {});
  await mallory?.context.close().catch(() => {});
  atlas.server.close();
  evil.server.close();
  rmSync(work, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
