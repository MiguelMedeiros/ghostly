import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { chat, expect, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * Chromium's fake microphone plays this file on a loop: two seconds of a 220 Hz voice-like tone in
 * loud and quiet "syllables" (16 kHz mono PCM, generated once), so the waveform has a shape.
 */
const SAMPLE = fileURLToPath(new URL("../support/voice-sample.wav", import.meta.url));

test.use({
  launchOptions: {
    args: [
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${SAMPLE}`,
      // Headless has no one to click play first; the tests click anyway, this only keeps it steady under load.
      "--autoplay-policy=no-user-gesture-required",
    ],
  },
});

const mic = (page: Page) => page.getByTestId("voice-record");
const voices = (peer: Peer) => chat(peer).getByTestId("voice-bubble");

/** Presses the mic with the mouse, holds it for `ms` and lets go. */
async function hold(page: Page, ms: number) {
  const box = (await mic(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId("voice-bar")).toHaveAttribute("data-phase", "recording");
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

/**
 * How far any part of a voice bubble reaches past the message bubble around it, in pixels (0: all inside).
 * #194's bubble was sized by the window (70vw), so in a 900px Desktop window its mic badge hung outside.
 */
const overhang = (bubble: Locator) =>
  bubble.evaluate((voice) => {
    const outer = voice.closest("[data-message-bubble]")!.getBoundingClientRect();
    let worst = 0;
    for (const part of [voice, ...voice.querySelectorAll("*")]) {
      const box = part.getBoundingClientRect();
      if (box.width > 0) worst = Math.max(worst, outer.left - box.left, box.right - outer.right);
    }
    return worst;
  });

/** How many different bar heights a waveform has: a flat line has one. */
const shapes = (bubble: Locator) =>
  bubble.locator(".voice-wave-base .voice-wave-bar").evaluateAll((bars) => new Set(bars.map((bar) => (bar as HTMLElement).style.height)).size);

test("voice messages: hold to record, the contact plays it", { tag: ["@feature:files.voice.record", "@feature:files.voice.play", "@feature:files.voice.meta", "@feature:files.paired.send"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("voice-alice"), peer("voice-bob")]);
  await pair(alice, bob);

  // Nothing typed: the mic stands where send was.
  await expect(alice.page.getByRole("button", { name: "Send message" })).toHaveCount(0);
  await expect(mic(alice.page)).not.toHaveAttribute("aria-disabled");
  await hold(alice.page, 2_600);
  await expect(alice.page.getByTestId("voice-bar")).toHaveCount(0);

  const sent = voices(alice).last();
  await expect(sent).toBeVisible();
  await expect(sent.getByTestId("voice-time")).toHaveText(/^0:0[2-3]$/);

  const received = voices(bob).last();
  await expect(received).toBeVisible({ timeout: 30_000 });
  await expect(received.getByTestId("voice-play")).toBeEnabled({ timeout: 30_000 });
  await expect(received).toHaveAttribute("data-played", "false");
  await expect(received.getByTestId("voice-unplayed")).toBeVisible();
  // The sender measured the waveform; the receiver draws it as sent, not flat.
  expect(await shapes(received)).toBeGreaterThan(3);
  expect(await shapes(received)).toBe(await shapes(sent));

  await received.getByTestId("voice-play").click();
  await expect(received).toHaveAttribute("data-state", "playing");
  await expect(received).toHaveAttribute("data-played", "true");
  await expect(received.getByTestId("voice-speed")).toHaveText("1×");
  // Real decoding: the clock moves, and the recording plays to its end.
  await expect(received.getByTestId("voice-time")).toHaveText(/^0:0[1-3]$/);
  await expect(received).toHaveAttribute("data-state", "idle", { timeout: 15_000 });
  await expect(received.getByTestId("voice-time")).toHaveText(/^0:0[2-3]$/);

  // Scrubbing: a tap three quarters along the waveform moves the position there.
  const wave = received.getByTestId("voice-waveform");
  const box = (await wave.boundingBox())!;
  await bob.page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
  await expect(wave).toHaveAttribute("aria-valuenow", /^[12]$/);
  await expect(received.getByTestId("voice-time")).toHaveText(/^0:0[12]$/);
  // It plays on from there (seeking works in a recorder's WebM, which has no index), not from the start.
  await received.getByTestId("voice-play").click();
  await expect(received).toHaveAttribute("data-state", "playing");
  await expect(received.getByTestId("voice-time")).not.toHaveText("0:00");
  await expect(received).toHaveAttribute("data-state", "idle", { timeout: 5_000 });

  // Inside its bubble at every width, sent and received, with the speed showing: the default Desktop window
  // (900px, the sidebar beside the chat), a narrow one, and a phone.
  await received.getByTestId("voice-play").click();
  await expect(received).toHaveAttribute("data-state", "playing");
  await received.getByTestId("voice-play").click();
  await expect(received).toHaveAttribute("data-state", "paused");
  await expect(received.getByTestId("voice-speed")).toBeVisible();
  for (const width of [1280, 900, 640, 390]) {
    for (const [who, bubble] of [[bob, received], [alice, sent]] as const) {
      await who.page.setViewportSize({ width, height: 800 });
      await expect.poll(() => overhang(bubble), { message: `${width}px` }).toBeLessThanOrEqual(0.5);
    }
  }
  await bob.page.setViewportSize({ width: 1280, height: 800 });

  // Survives a reload: stored with its description, still played.
  await bob.page.reload();
  const again = voices(bob).last();
  await expect(again).toHaveAttribute("data-played", "true", { timeout: 30_000 });
  expect(await shapes(again)).toBeGreaterThan(3);
});

test("voice messages: hands-free with a click, pause and preview, Enter, Esc; the next one plays on", { tag: ["@feature:files.voice.record", "@feature:files.voice.autoplay", "@feature:files.voice.play"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("voice-free-alice"), peer("voice-free-bob")]);
  await pair(alice, bob);
  const page = alice.page;
  await expect(mic(page)).not.toHaveAttribute("aria-disabled");

  // A click records hands-free; Esc throws it away.
  await mic(page).click();
  await expect(page.getByTestId("voice-bar")).toHaveAttribute("data-mode", "locked");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("voice-bar")).toHaveCount(0);

  // One held, then one hands-free with a pause, a listen and more: two in a row from Alice.
  await hold(page, 1_600);
  await expect(voices(alice)).toHaveCount(1);
  await mic(page).click();
  await expect(page.getByTestId("voice-bar")).toHaveAttribute("data-phase", "recording");
  await page.waitForTimeout(1_500);
  await page.getByRole("button", { name: "Pause recording" }).click();
  await expect(page.getByTestId("voice-bar")).toHaveAttribute("data-phase", "paused");
  await page.getByTestId("voice-preview").click();
  await expect(page.getByRole("button", { name: "Pause preview" })).toBeVisible();
  await page.getByRole("button", { name: "Resume recording" }).click();
  await page.waitForTimeout(1_200);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("voice-bar")).toHaveCount(0);
  await expect(voices(alice)).toHaveCount(2);
  // Paused time is not recorded: about 2.7 s, however long the preview took.
  await expect(voices(alice).last().getByTestId("voice-time")).toHaveText(/^0:0[23]$/);

  await expect(voices(bob)).toHaveCount(2, { timeout: 30_000 });
  const [first, second] = [voices(bob).first(), voices(bob).last()];
  await expect(second.getByTestId("voice-play")).toBeEnabled({ timeout: 30_000 });
  await first.getByTestId("voice-play").click();
  await expect(first).toHaveAttribute("data-state", "playing");
  // The first ends, the second follows by itself.
  await expect(second).toHaveAttribute("data-state", "playing", { timeout: 15_000 });
  await expect(first).toHaveAttribute("data-state", "idle");
  await expect(second).toHaveAttribute("data-played", "true");

  // Only one at a time: starting the first again stops the second.
  await first.getByTestId("voice-play").click();
  await expect(first).toHaveAttribute("data-state", "playing");
  await expect(second).toHaveAttribute("data-state", "paused");

  // Speed is shared by every voice message.
  await first.getByTestId("voice-speed").click();
  await expect(first.getByTestId("voice-speed")).toHaveText("1.5×");
  await expect(second.getByTestId("voice-speed")).toHaveText("1.5×");
});
