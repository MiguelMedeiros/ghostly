#!/usr/bin/env node
import { decodeInPage, loadFixtures, playInPage, rateInPage } from "../../e2e/support/voice-media.mjs";
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

// The speed pill: 2× must really play faster, with the pitch kept. The same timing reads 0.85 to 0.95 at 1× and
// 1.55 to 2.3 at 2× on a Mac, so over 1.4 is really faster. A shared CI runner can stall the audio for a moment,
// which only ever reads slower, so a recording that reads too slow is timed once more in a fresh WebView.
const fastEnough = (result) => result.rate === 2 && result.preservesPitch === true && result.speed > 1.4;
const fixtures = loadFixtures();
const fast = inWebView(rateInPage, [fixtures, 2], { csp: policy });
const slow = fixtures.filter(({ name }) => !fastEnough(fast[name]) && fast[name].rate === 2 && fast[name].preservesPitch === true);
if (slow.length) {
  for (const { name } of slow) console.log(`… ${name.padEnd(28)} at 2×: speed=${fast[name].speed ?? "?"} (plays ${JSON.stringify(fast[name].speeds)}), timing again`);
  Object.assign(fast, inWebView(rateInPage, [slow, 2], { csp: policy }));
}
for (const [name, result] of Object.entries(fast)) {
  const ok = fastEnough(result);
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(28)} at 2×: playbackRate=${result.rate} preservesPitch=${result.preservesPitch} speed=${result.speed ?? "?"} (plays ${JSON.stringify(result.speeds)}, pooled ${result.pooled ?? "?"})${result.error ? `  ${result.error}` : ""}`);
}
if (failed) {
  console.error(`\n${failed} recording(s) do not play faster with the pitch kept in WKWebView.`);
  process.exit(1);
}

// Download as MP3: WKWebView's Web Audio decodes every recording to one channel at 24 kHz, as the app does before
// its worker encodes (the encoder is plain JavaScript, checked on the web in e2e/web/voice-codecs.spec.ts).
const decoded = inWebView(decodeInPage, [loadFixtures(), 24_000], { csp: policy });
for (const [name, result] of Object.entries(decoded)) {
  const expected = result.duration * 24_000;
  const ok = !result.error && result.duration > 0.5 && Math.abs(result.samples / expected - 1) < 0.01 && result.peak > 0.05;
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(28)} for MP3: ${result.error ?? `${result.duration?.toFixed(3)} s, ${result.samples} samples at 24 kHz, peak ${result.peak?.toFixed(2)}`}`);
}
if (failed) {
  console.error(`\n${failed} recording(s) do not decode in WKWebView for Download as MP3.`);
  process.exit(1);
}
