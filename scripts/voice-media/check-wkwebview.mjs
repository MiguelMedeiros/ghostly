#!/usr/bin/env node
import { loadFixtures, playInPage } from "../../e2e/support/voice-media.mjs";
import { desktopPolicy, inWebView } from "./webview.mjs";

/**
 * Ghostly Desktop on a Mac plays every committed voice recording (`e2e/support/voice-fixtures/`: what the
 * web app, the extension and Desktop record) in the system WKWebView, under the policy tauri.conf.json ships.
 * macOS only — WKWebView has no WebDriver, so the Desktop e2e harness cannot run here. `npm run check:wkwebview-media`.
 * `--policy none` plays without any policy, to tell a policy problem from a codec one.
 */
if (process.platform !== "darwin") {
  console.log("check:wkwebview-media runs on macOS only; skipped.");
  process.exit(0);
}
const policy = process.argv.includes("--policy") && process.argv[process.argv.indexOf("--policy") + 1] === "none" ? undefined : desktopPolicy();
const results = inWebView(playInPage, [loadFixtures()], { csp: policy });
let failed = 0;
for (const [name, result] of Object.entries(results)) {
  if (!result.played) failed++;
  console.log(`${result.played ? "✓" : "✗"} ${name.padEnd(28)} canPlayType=${JSON.stringify(result.canPlay)}${result.error ? `  ${result.error}` : ""}`);
}
if (failed) {
  console.error(`\n${failed} recording(s) do not play in WKWebView${policy ? " under Desktop's CSP (try --policy none: a policy problem, or a codec one?)" : ""}.`);
  process.exit(1);
}
