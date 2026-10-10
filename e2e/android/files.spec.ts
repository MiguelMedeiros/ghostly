import { fileURLToPath } from "node:url";
import { chat } from "../support/fixtures";
import { expect, pairWithWeb, test } from "./support/android";

/**
 * Files between the Android app and a web peer. The app keeps files in Rust (the Desktop host's native file bytes),
 * which on Android arrive over `postMessage` IPC as JSON arrays (docs/ANDROID.md, "Files over IPC"); a video it
 * received plays from the `ghostly-file` scheme, served at http://ghostly-file.localhost/<token> on Android.
 */

/** Two seconds of H.264 in MP4: the emulator's WebView (Chrome 124) plays it. */
const VIDEO = fileURLToPath(new URL("../support/video-fixtures/ghosts-h264.mp4", import.meta.url));

test("a small file goes each way, with its receipt", { tag: ["@feature:android.files.send", "@gated"] }, async ({ app, webPeer }) => {
  const web = await webPeer("web-files");
  await pairWithWeb(app, web);

  // From the app: the picker's input given the file, as the system's document picker would.
  await app.page.getByTestId("file-input").setInputFiles({ name: "from-android.txt", mimeType: "text/plain", buffer: Buffer.from("ghostly on android\n".repeat(64)) });
  await expect(chat(web).getByText("from-android.txt")).toBeVisible({ timeout: 90_000 });
  const sent = chat(app.peer).locator("[data-message-row]").filter({ hasText: "from-android.txt" }).last();
  await expect(sent.getByTestId("message-delivery")).toHaveAttribute("data-delivery", "delivered", { timeout: 60_000 });

  // To the app: stored through Rust, receipt back to the web peer.
  await web.page.getByTestId("file-input").setInputFiles({ name: "from-web.txt", mimeType: "text/plain", buffer: Buffer.from("ghostly on the web\n".repeat(64)) });
  await expect(chat(app.peer).getByText("from-web.txt")).toBeVisible({ timeout: 90_000 });
  const received = chat(web).locator("[data-message-row]").filter({ hasText: "from-web.txt" }).last();
  await expect(received.getByTestId("message-delivery")).toHaveAttribute("data-delivery", "delivered", { timeout: 60_000 });
});

test("a received video plays from the ghostly-file scheme, and seeks", { tag: ["@feature:android.files.video", "@gated"] }, async ({ app, webPeer }) => {
  const web = await webPeer("web-video");
  await pairWithWeb(app, web);

  await web.page.getByTestId("media-input").setInputFiles(VIDEO);
  const bubble = chat(app.peer).getByTestId("video-bubble").last();
  await expect(bubble.getByTestId("video-play")).toBeVisible({ timeout: 90_000 });
  await bubble.getByTestId("video-play").click();
  await expect(bubble).toHaveAttribute("data-phase", "playing");
  // Rust serves it (file_stream.rs): not a blob the page made, as on the web.
  const player = bubble.getByTestId("video-player");
  await expect(player).toHaveAttribute("src", /^http:\/\/ghostly-file\.localhost\/[A-Za-z0-9_-]+$/);
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.currentTime), { timeout: 20_000 }).toBeGreaterThan(0.3);
  // A seek asks the scheme for a range (206).
  const seeked = await player.evaluate((video: HTMLVideoElement) => new Promise<string>((done) => {
    video.addEventListener("seeked", () => done(`seeked at ${video.currentTime.toFixed(2)}`), { once: true });
    video.addEventListener("error", () => done(`error ${video.error?.code}`), { once: true });
    setTimeout(() => done("timeout"), 15_000);
    video.currentTime = Math.min(1.5, video.duration - 0.1);
  }));
  expect(seeked).toMatch(/^seeked at /);
});
