import { fileURLToPath } from "node:url";
import type { Locator } from "@playwright/test";
import { chat, expect, test } from "../support/fixtures";
import { pair } from "../support/paired";
import { CHROMIUM_SANDBOX } from "../support/chromiumSandbox";

/**
 * Forced colors (Windows Contrast themes) paint every background the page's colour. A voice message's waveform (its
 * bars, the part played and the knob) and, while recording, the live bars and the red dot were drawn by backgrounds
 * alone: the bubble showed Play and the time over an empty strip, the recording nothing that heard the mic.
 */

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

/** A part's background as drawn, and the background of what it sits on (the first opaque one around it). */
const drawn = (part: Locator) => part.evaluate((node) => {
  const opaque = (c: string) => c !== "transparent" && !/rgba\(.*, 0\)$/.test(c);
  let around = "rgb(255, 255, 255)";
  for (let n = node.parentElement; n; n = n.parentElement) {
    const c = getComputedStyle(n).backgroundColor;
    if (opaque(c)) { around = c; break; }
  }
  return { bg: getComputedStyle(node).backgroundColor, around };
});

/** Drawn, in a colour unlike what it sits on. */
async function shows(part: Locator, name: string): Promise<string> {
  const { bg, around } = await drawn(part);
  expect.soft(bg, `${name}: drawn against ${around}`).not.toBe(around);
  return bg;
}

test("forced colors keep a voice message's waveform, its played part and knob, and the recording's live bars and dot", { tag: ["@feature:app.accessibility", "@feature:app.theme", "@feature:files.voice.record", "@feature:files.voice.play"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("fc-voice-alice"), peer("fc-voice-bob")]);
  await pair(alice, bob);
  const page = alice.page;
  await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });

  // Recording: the live bars and the dot.
  const mic = page.getByTestId("voice-record");
  const box = (await mic.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const bar = page.getByTestId("voice-bar");
  await expect(bar).toHaveAttribute("data-phase", "recording");
  await page.waitForTimeout(2_600);
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ forcedColors: "active", colorScheme: scheme });
    await shows(page.getByTestId("voice-live").locator("span").last(), `a live bar (${scheme})`);
    await shows(bar.locator(".voice-bar-dot"), `the recording dot (${scheme})`);
  }
  await page.emulateMedia({ forcedColors: "none" });
  await page.mouse.up();

  // The message as received, played a moment and paused: bars on both sides of the knob.
  const voice = chat(bob).getByTestId("voice-bubble").last();
  await expect(voice.getByTestId("voice-play")).toBeEnabled({ timeout: 30_000 });
  await voice.getByTestId("voice-play").click();
  await expect(voice).toHaveAttribute("data-state", "playing");
  await expect(voice.getByTestId("voice-time")).not.toHaveText("0:00");
  await voice.getByTestId("voice-play").click();
  await expect(voice).toHaveAttribute("data-state", "paused");
  const wave = voice.getByTestId("voice-waveform");
  for (const scheme of ["dark", "light"] as const) {
    await bob.page.emulateMedia({ forcedColors: "active", colorScheme: scheme });
    const unplayed = await shows(wave.locator(".voice-wave-base .voice-wave-bar").first(), `a bar (${scheme})`);
    const played = await shows(wave.locator(".voice-wave-fill .voice-wave-bar").first(), `a played bar (${scheme})`);
    expect.soft(played, `the played part unlike the rest (${scheme})`).not.toBe(unplayed);
    await shows(wave.locator(".voice-wave-knob"), `the knob (${scheme})`);
  }
});
