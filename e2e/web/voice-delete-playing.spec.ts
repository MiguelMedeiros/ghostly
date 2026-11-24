import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { chat, expect, test } from "../support/fixtures";
import { pair } from "../support/paired";
import { CHROMIUM_SANDBOX } from "../support/chromiumSandbox";

/** Chromium's fake microphone plays this on a loop (voice-messages.spec.ts). */
const SAMPLE = fileURLToPath(new URL("../support/voice-sample.wav", import.meta.url));

test.use({
  launchOptions: {
    chromiumSandbox: CHROMIUM_SANDBOX,
    args: [
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${SAMPLE}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
});

/** Records a voice message about `ms` long by holding the mic. */
async function record(page: Page, ms: number) {
  const mic = page.getByTestId("voice-record");
  await expect(mic).not.toHaveAttribute("aria-disabled");
  const box = (await mic.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId("voice-bar")).toHaveAttribute("data-phase", "recording");
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

/** Keeps every media element the page plays: the voice bubble's `<audio>` is never in the page. */
const watchAudio = (page: Page) => page.evaluate(() => {
  const seen: HTMLMediaElement[] = ((window as unknown as { voiceAudio: HTMLMediaElement[] }).voiceAudio = []);
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
    if (!seen.includes(this)) seen.push(this);
    return play.call(this);
  };
});
const playing = (page: Page) => page.evaluate(() => (window as unknown as { voiceAudio: HTMLMediaElement[] }).voiceAudio.filter((audio) => !audio.paused && !audio.ended).length);

test("a voice message deleted while it plays stops, and no now-playing bar comes", { tag: ["@feature:files.voice.now-playing", "@feature:chat.paired.delete-message"] }, async ({ peer }) => {
  // Its bubble leaving the screen handed it to the app's player, as a change of page does: it played on to its end with
  // the bar, the message gone from the chat.
  const [alice, bob] = await Promise.all([peer("vdp-alice"), peer("vdp-bob")]);
  await pair(alice, bob);
  await record(alice.page, 8_000);
  const voice = chat(bob).getByTestId("voice-bubble").last();
  await expect(voice.getByTestId("voice-play")).toBeEnabled({ timeout: 60_000 });
  await watchAudio(bob.page);
  await voice.getByTestId("voice-play").click();
  await expect(voice).toHaveAttribute("data-state", "playing");
  await expect.poll(() => playing(bob.page)).toBe(1);

  const row = chat(bob).locator("[data-message-row]").filter({ has: bob.page.getByTestId("voice-bubble") }).last();
  await row.hover();
  await row.getByTestId("message-options").click();
  await bob.page.getByTestId("message-delete").click();
  await bob.page.getByTestId("message-delete-confirm").click();
  await expect(chat(bob).getByTestId("voice-bubble")).toHaveCount(0);
  expect(await playing(bob.page)).toBe(0);
  await expect(bob.page.getByTestId("now-playing")).toHaveCount(0);
});
