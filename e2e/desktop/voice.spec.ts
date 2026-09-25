import { loadFixtures, playInPage } from "../support/voice-media.mjs";
import { test, expect } from "../support/desktop";

/**
 * Voice messages play inside the real Desktop WebView, under the Content-Security-Policy Tauri serves the app
 * with. #194 shipped with a policy that had no `media-src`: every recording failed on Desktop alone
 * ("Could not play this recording."), while the web e2e — whose build serves no policy — passed.
 *
 * The recordings are what each engine's MediaRecorder makes (e2e/support/voice-fixtures/): the web app and the
 * extension (Chromium) and Desktop on a Mac (WKWebView). This harness runs Linux's WebKitGTK; the macOS
 * WKWebView is checked by `npm run check:wkwebview-media` (CI job "Desktop media").
 */
const fixtures = loadFixtures();

test("voice recordings from every Ghostly play in the Desktop WebView", { tag: ["@feature:files.voice.play"] }, async ({ app }) => {
  await expect.poll(() => app.text('[title="New Chat"]')).not.toBeNull();

  const results: Record<string, { canPlay: string; played: boolean; error?: string }> = {};
  for (const fixture of fixtures) {
    const result = await app.executeAsync<Record<string, { canPlay: string; played: boolean; error?: string }>>(
      `const done = arguments[arguments.length - 1];
       (${String(playInPage)})([arguments[0]]).then(done, (error) => done({ [arguments[0].name]: { played: false, error: String(error) } }));`,
      fixture,
    );
    Object.assign(results, result);
  }
  test.info().annotations.push({ type: "codecs", description: JSON.stringify(results) });

  // Opus in WebM is what every Ghostly records today: it must play, whoever sent it.
  for (const name of ["chromium.webm", "macos-wkwebview.webm"]) expect(results[name], name).toMatchObject({ played: true });
  // AAC (older Macs record it) needs a GStreamer AAC decoder on Linux, which not every system has. Where it is
  // missing the bubble offers the file to save; what must never happen is the policy refusing the blob.
  for (const [name, result] of Object.entries(results)) expect(result.error ?? "", name).not.toMatch(/Content Security Policy|NotAllowedError/i);
});
