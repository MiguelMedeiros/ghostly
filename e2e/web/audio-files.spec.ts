import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chat, expect, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";

/** Two seconds of a 440 Hz tone, sent as a file (`tools/scripts/video-media/make-fixtures.mjs`). */
const MP3 = fileURLToPath(new URL("../support/audio-fixtures/ghost-tune.mp3", import.meta.url));

test.use({
  launchOptions: {
    args: [
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      // Headless has no one to click play first; the tests click anyway, this only keeps it steady under load.
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
});

const audios = (peer: Peer) => chat(peer).getByTestId("audio-bubble");

test("an audio file plays in the chat: name, play, seek bar, time and the shared speed", { tag: ["@feature:files.audio.play", "@feature:files.paired.send"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("audio-alice"), peer("audio-bob")]);
  await pair(alice, bob);

  await alice.page.getByTestId("file-input").setInputFiles(MP3);
  await expect(audios(alice).last().getByTestId("audio-name")).toHaveText("ghost-tune.mp3", { timeout: 30_000 });

  const received = audios(bob).last();
  await expect(received.getByTestId("audio-name")).toHaveText("ghost-tune.mp3", { timeout: 30_000 });
  await expect(received.getByTestId("audio-play")).toBeEnabled({ timeout: 30_000 });
  await received.getByTestId("audio-play").click();

  const element = received.getByTestId("audio-element");
  await expect(received).toHaveAttribute("data-state", "playing");
  await expect.poll(() => element.evaluate((audio: HTMLAudioElement) => audio.currentTime), { timeout: 15_000 }).toBeGreaterThan(0.3);
  await expect(received.getByTestId("audio-time")).toHaveText(/^0:0\d \/ 0:02$/);

  // The speed voice messages share: one tap, 1.5×, on the element too.
  await received.getByTestId("voice-speed").click();
  await expect(received.getByTestId("voice-speed")).toHaveAttribute("data-rate", "1.5");
  expect(await element.evaluate((audio: HTMLAudioElement) => audio.playbackRate)).toBe(1.5);

  // It ends by itself and goes back to the start, ready to play again.
  await expect(received).toHaveAttribute("data-state", "idle", { timeout: 10_000 });
  await expect(received.getByTestId("audio-play")).toHaveAccessibleName("Play audio");
});

test("an audio file's status reads whole: it wraps instead of being cut", { tag: ["@feature:files.audio.play"] }, async ({ peer }, testInfo) => {
  const [alice, bob] = await Promise.all([peer("audio-alice"), peer("audio-bob")]);
  await pair(alice, bob);

  // Over the 25 MiB a receiver takes without asking: the sender waits for an answer, a line longer than the bubble.
  const path = testInfo.outputPath("long concert recording.mp3");
  writeFileSync(path, Buffer.alloc(26 * 1024 * 1024, 7));
  await alice.page.getByTestId("file-input").setInputFiles(path);
  const status = audios(alice).last().getByTestId("audio-status");
  await expect(status).toHaveText("· Waiting for your contact to accept · 26.0 MB", { timeout: 30_000 });
  const box = await status.evaluate((el) => ({ cut: el.scrollWidth > el.clientWidth + 1, right: el.getBoundingClientRect().right, bubble: el.closest("[data-testid=audio-bubble]")!.getBoundingClientRect().right }));
  expect(box.cut, "the status is not cut with …").toBe(false);
  expect(box.right).toBeLessThanOrEqual(box.bubble + 1);
});
