#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { FIXTURES_DIR, recordInPage } from "../../e2e/support/voice-media.mjs";
import { inWebView } from "./webview.mjs";

/**
 * Records the fixtures in `e2e/support/voice-fixtures/`: what each engine's MediaRecorder makes of the same
 * 1.6 s tone, in every type Ghostly may record in (`RECORDING_TYPES` in packages/core/src/voice.ts).
 * Chromium stands for the web app, the extension and Desktop on Windows; the macOS system WKWebView for
 * Desktop on a Mac. Run on a Mac: `node scripts/voice-media/make-fixtures.mjs`. No microphone is used.
 */
const TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4;codecs=mp4a.40.2"];
const EXT = { "audio/webm;codecs=opus": "webm", "audio/ogg;codecs=opus": "ogg", "audio/mp4;codecs=mp4a.40.2": "m4a" };
const MS = 1_600;

function save(engine, recorded) {
  for (const [type, base64] of Object.entries(recorded)) {
    if (!base64) { console.log(`${engine}: cannot record ${type}`); continue; }
    const file = join(FIXTURES_DIR, `${engine}.${EXT[type]}`);
    writeFileSync(file, Buffer.from(base64, "base64"));
    console.log(`${engine}: ${type} → ${file}`);
  }
}

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
await page.goto("about:blank");
save("chromium", await page.evaluate(([fn, types, ms]) => new Function(`return (${fn})`)()(types, ms), [String(recordInPage), TYPES, MS]));
await browser.close();

if (process.platform === "darwin") save("macos-wkwebview", inWebView(recordInPage, [TYPES, MS]) ?? {});
else console.log("Not a Mac: the WKWebView recordings were left as they are.");
