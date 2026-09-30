import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { encodeMp3, MP3_KBPS, MP3_SAMPLE_RATE } from "../../apps/ui/src/lib/mp3Encode";
import { mp3Info } from "../../apps/ui/src/test/voice/mp3Info";
import { decodeInPage, loadFixtures, playInPage, rateInPage } from "../support/voice-media.mjs";

/**
 * The web app (and the extension, the same Chromium) plays what every Ghostly records: its own WebM/Opus and
 * Desktop on a Mac's WebM/Opus and MP4/AAC (e2e/support/voice-fixtures/), from `blob:` URLs, under the policy
 * nginx serves app.ghostly.tools with. The Desktop side of the pair is e2e/desktop/voice.spec.ts and
 * `npm run check:wkwebview-media`.
 */
const policy = /Content-Security-Policy "([^"]+)"/.exec(readFileSync(new URL("../../apps/web/nginx-headers.conf", import.meta.url), "utf8"))![1]!;

test("voice recordings from every Ghostly play in the web app, under its CSP", { tag: ["@feature:files.voice.play"] }, async ({ page, baseURL }) => {
  await page.route("**/voice-codecs", (route) =>
    route.fulfill({ contentType: "text/html", headers: { "content-security-policy": policy }, body: "<!doctype html><title>codecs</title>" }));
  await page.goto(new URL("/voice-codecs", baseURL).href);
  const results = await page.evaluate(playInPage, loadFixtures());
  test.info().annotations.push({ type: "codecs", description: JSON.stringify(results) });
  for (const [name, result] of Object.entries(results)) expect(result, name).toMatchObject({ played: true });
});

test("voice recordings from every Ghostly play twice as fast with the pitch kept, under the web CSP", { tag: ["@feature:files.voice.play"] }, async ({ page, baseURL }) => {
  await page.route("**/voice-codecs", (route) =>
    route.fulfill({ contentType: "text/html", headers: { "content-security-policy": policy }, body: "<!doctype html><title>codecs</title>" }));
  await page.goto(new URL("/voice-codecs", baseURL).href);
  const results = await page.evaluate(rateInPage, loadFixtures());
  test.info().annotations.push({ type: "rates", description: JSON.stringify(results) });
  // At 1× the same timing reads under 1, so over 1.4 is really faster, not a clock's jitter.
  for (const [name, result] of Object.entries(results)) expect(result, name).toMatchObject({ rate: 2, preservesPitch: true, speed: expect.any(Number) });
  for (const [name, result] of Object.entries(results)) expect(result.speed, name).toBeGreaterThan(1.4);
});

test("voice recordings from every Ghostly convert to a mono MP3 of the same length (Download as MP3)", { tag: ["@feature:files.download"] }, async ({ page, baseURL }) => {
  await page.route("**/voice-codecs", (route) =>
    route.fulfill({ contentType: "text/html", headers: { "content-security-policy": policy }, body: "<!doctype html><title>codecs</title>" }));
  await page.goto(new URL("/voice-codecs", baseURL).href);
  // decodeInPage runs in the page, sent as source: it takes the fixtures alone and decodes at 24 kHz, the MP3's rate.
  expect(MP3_SAMPLE_RATE).toBe(24_000);
  const decoded = await page.evaluate(decodeInPage, loadFixtures());
  expect(Object.keys(decoded).sort()).toEqual(["chromium.webm", "macos-wkwebview.m4a", "macos-wkwebview.webm"]);
  for (const [name, result] of Object.entries(decoded)) {
    expect(result.error, name).toBeUndefined();
    // The same encoder the conversion worker runs (the page only decodes; Web Audio has no decoder in a worker).
    const raw = Buffer.from(result.pcm!, "base64");
    const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
    const mp3 = await encodeMp3(Float32Array.from(pcm, (sample) => sample / 0x8000));
    const info = mp3Info(mp3);
    test.info().annotations.push({ type: "mp3", description: `${name}: ${result.duration.toFixed(3)} s → ${JSON.stringify(info)}` });
    expect(info, name).toMatchObject({ mono: true, sampleRate: MP3_SAMPLE_RATE, bitrate: MP3_KBPS });
    expect(result.peak, `${name} is not silence`).toBeGreaterThan(0.05);
    expect(Math.abs(info.durationMs / (result.duration * 1000) - 1), name).toBeLessThan(0.05);
  }
});
