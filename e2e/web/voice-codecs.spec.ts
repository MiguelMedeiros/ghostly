import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { loadFixtures, playInPage } from "../support/voice-media.mjs";

/**
 * The web app (and the extension, the same Chromium) plays what every Ghostly records: its own WebM/Opus and
 * Desktop on a Mac's WebM/Opus and MP4/AAC (e2e/support/voice-fixtures/), from `blob:` URLs, under the policy
 * nginx serves app.ghostly.tools with. The Desktop side of the pair is e2e/desktop/voice.spec.ts and
 * `npm run check:wkwebview-media`.
 */
const policy = /Content-Security-Policy "([^"]+)"/.exec(readFileSync(new URL("../../web/nginx-headers.conf", import.meta.url), "utf8"))![1]!;

test("voice recordings from every Ghostly play in the web app, under its CSP", { tag: ["@feature:files.voice.play"] }, async ({ page, baseURL }) => {
  await page.route("**/voice-codecs", (route) =>
    route.fulfill({ contentType: "text/html", headers: { "content-security-policy": policy }, body: "<!doctype html><title>codecs</title>" }));
  await page.goto(new URL("/voice-codecs", baseURL).href);
  const results = await page.evaluate(playInPage, loadFixtures());
  test.info().annotations.push({ type: "codecs", description: JSON.stringify(results) });
  for (const [name, result] of Object.entries(results)) expect(result, name).toMatchObject({ played: true });
});
