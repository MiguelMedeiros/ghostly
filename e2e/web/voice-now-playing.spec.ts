import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { chat, expect, test } from "../support/fixtures";
import { pair } from "../support/paired";

/** Chromium's fake microphone plays this on a loop (voice-messages.spec.ts). */
const SAMPLE = fileURLToPath(new URL("../support/voice-sample.wav", import.meta.url));

test.use({
  launchOptions: {
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

test("voice messages: one playing keeps playing on another page, with a bar; back in the chat it is where it was", { tag: ["@feature:files.voice.now-playing", "@feature:files.voice.play"] }, async ({ peer }) => {
  // A listener switched chats in the middle of a voice message: it stopped, and started over from 0:00 when they came back.
  const [alice, bob] = await Promise.all([peer("np-alice"), peer("np-bob")]);
  await pair(alice, bob);
  await record(alice.page, 6_000);

  const received = chat(bob).getByTestId("voice-bubble").last();
  await expect(received.getByTestId("voice-play")).toBeEnabled({ timeout: 30_000 });
  await received.getByTestId("voice-play").click();
  await expect(received).toHaveAttribute("data-state", "playing");

  // Another page: the chat is gone from the screen, the voice message plays on, and the bar says so.
  await bob.page.evaluate(() => { location.hash = "#/settings"; });
  const bar = bob.page.getByRole("region", { name: "Now playing" });
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute("data-state", "playing");
  await expect(bar.getByTestId("now-playing-title")).toHaveText("Voice message");
  await expect(bar.getByTestId("now-playing-time")).toContainText(/^0:0[2-5] \/ 0:0[5-7]/, { timeout: 5_000 });

  // Paused from the bar, at some point part-way.
  await bar.getByTestId("now-playing-play").click();
  await expect(bar).toHaveAttribute("data-state", "paused");
  const at = (await bar.getByTestId("now-playing-time").locator("[aria-hidden]").textContent())!.split(" / ")[0]!;

  // A tap on the bar opens the chat at the message: its bubble has it, paused where the bar left it, and the bar goes.
  await bar.getByTestId("now-playing-open").click();
  await expect(bar).toHaveCount(0);
  const again = chat(bob).getByTestId("voice-bubble").last();
  await expect(again).toHaveAttribute("data-state", "paused");
  await expect(again.getByTestId("voice-time")).toHaveText(at);
  expect(at).not.toBe("0:00");

  // It goes on from there, not from the start, and ends in its bubble.
  await again.getByTestId("voice-play").click();
  await expect(again).toHaveAttribute("data-state", "playing");
  await expect(again.getByTestId("voice-time")).not.toHaveText("0:00");
  await expect(again).toHaveAttribute("data-state", "idle", { timeout: 15_000 });
});

test("voice messages: on a phone the now-playing bar sits above the tab bar", { tag: ["@feature:files.voice.now-playing", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("np-phone-alice"), peer("np-phone-bob", { mobile: true, viewport: { width: 390, height: 800 } })]);
  await pair(alice, bob);
  await record(alice.page, 6_000);

  const received = chat(bob).getByTestId("voice-bubble").last();
  await expect(received.getByTestId("voice-play")).toBeEnabled({ timeout: 30_000 });
  await received.getByTestId("voice-play").click();
  await expect(received).toHaveAttribute("data-state", "playing");

  // Back to the chat list: the bar right above the tabs, not over them.
  await bob.page.evaluate(() => { location.hash = "#/"; });
  const bar = bob.page.getByTestId("now-playing");
  const tabs = bob.page.getByTestId("mobile-tabs");
  await expect(bar).toBeVisible();
  await expect(tabs).toBeVisible();
  const [barBox, tabsBox] = [(await bar.boundingBox())!, (await tabs.boundingBox())!];
  expect(Math.abs(barBox.y + barBox.height - tabsBox.y)).toBeLessThanOrEqual(1);
  // Closed: it stops, and the bar goes.
  await bar.getByTestId("now-playing-close").click();
  await expect(bar).toHaveCount(0);
});
