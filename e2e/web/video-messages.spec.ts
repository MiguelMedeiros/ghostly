import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Locator } from "@playwright/test";
import { chat, expect, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * Two seconds of a test pattern, VP9 in MP4 (`scripts/video-media/make-fixtures.mjs`): Chromium plays it on every
 * OS, open-source Linux builds included, which have no H.264.
 */
const FIXTURE = fileURLToPath(new URL("../support/video-fixtures/ghosts.mp4", import.meta.url));

test.use({
  launchOptions: {
    args: [
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      // Headless has no one to click play first; the tests click anyway, this only keeps it steady under load.
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
});

const videos = (peer: Peer) => chat(peer).getByTestId("video-bubble");
/** Where the playing video is, in seconds. */
const position = (bubble: Locator) => bubble.getByTestId("video-player").evaluate((video: HTMLVideoElement) => video.currentTime);

/** How far any part of a video bubble reaches past the message bubble around it, in pixels (0: all inside). */
const overhang = (bubble: Locator) =>
  bubble.evaluate((video) => {
    const outer = video.closest("[data-message-bubble]")!.getBoundingClientRect();
    let worst = 0;
    for (const part of [video, ...video.querySelectorAll("*")]) {
      const box = part.getBoundingClientRect();
      if (box.width > 0) worst = Math.max(worst, outer.left - box.left, box.right - outer.right);
    }
    return worst;
  });

test("a video plays in the chat: poster and length before it plays, then in place", { tag: ["@feature:files.video.play", "@feature:files.video.meta", "@feature:files.paired.send"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("video-alice"), peer("video-bob")]);
  await pair(alice, bob);

  await alice.page.getByTestId("media-input").setInputFiles(FIXTURE);

  // The sender read its length and first frame before it went.
  const sent = videos(alice).last();
  await expect(sent).toBeVisible({ timeout: 30_000 });
  await expect(sent.getByTestId("video-duration")).toHaveText("0:02");
  await expect(sent.getByTestId("video-poster")).toHaveAttribute("src", /^data:image\/jpeg;base64,/);

  // The contact sees the same poster, then plays it where it is.
  const received = videos(bob).last();
  await expect(received.getByTestId("video-play")).toBeVisible({ timeout: 30_000 });
  await expect(received.getByTestId("video-duration")).toHaveText("0:02");
  await expect(received.getByTestId("video-poster")).toHaveAttribute("src", await sent.getByTestId("video-poster").getAttribute("src") ?? "");
  expect(await overhang(received)).toBeLessThanOrEqual(1);

  await received.getByTestId("video-play").click();
  await expect(received).toHaveAttribute("data-phase", "playing");
  const player = received.getByTestId("video-player");
  await expect(player).toHaveAttribute("src", /^blob:/);
  expect(await player.evaluate((video: HTMLVideoElement) => video.controls)).toBe(true);
  await expect.poll(() => position(received), { timeout: 15_000 }).toBeGreaterThan(0.3);

  // Space on the video pauses it.
  await received.getByTestId("video-frame").focus();
  await bob.page.keyboard.press("Space");
  await expect.poll(() => player.evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
});

test("a large video asks first: Download <size>, then it plays", { tag: ["@feature:files.video.play", "@feature:files.large.offer"] }, async ({ peer }, testInfo) => {
  test.setTimeout(180_000);
  const [alice, bob] = await Promise.all([peer("video-big-alice"), peer("video-big-bob")]);
  await pair(alice, bob);

  // Above the 25 MiB a receiver takes without asking: the fixture, then zeros after its last box (players stop
  // reading at the end of what the index describes).
  const path = testInfo.outputPath("big ghosts.mp4");
  const fd = openSync(path, "w");
  writeSync(fd, readFileSync(FIXTURE));
  const zeros = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < 26; i++) writeSync(fd, zeros);
  closeSync(fd);
  await alice.page.getByTestId("media-input").setInputFiles(path);

  const received = videos(bob).last();
  const accept = received.getByTestId("video-accept");
  await expect(accept).toBeVisible({ timeout: 60_000 });
  await expect(accept).toHaveText(/^Download 26\.0 MB$/);
  // Its poster is there before a byte of it is.
  await expect(received.getByTestId("video-poster")).toBeVisible();
  await accept.click();

  await expect(received.getByTestId("video-play")).toBeVisible({ timeout: 150_000 });
  await received.getByTestId("video-play").click();
  await expect.poll(() => position(received), { timeout: 15_000 }).toBeGreaterThan(0.3);
});
