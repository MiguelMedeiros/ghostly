import type { Page } from "@playwright/test";
import { chat } from "../support/fixtures";
import { expect, test } from "../support/extension";
import { pair } from "../support/paired";

/** Presses the mic with the mouse, holds it for `ms` and lets go. Chromium's fake microphone beeps. */
async function hold(page: Page, ms: number) {
  const mic = page.getByTestId("voice-record");
  await expect(mic).not.toHaveAttribute("aria-disabled");
  const box = (await mic.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId("voice-bar")).toHaveAttribute("data-phase", "recording");
  await page.waitForTimeout(ms);
  await page.mouse.up();
  await expect(page.getByTestId("voice-bar")).toHaveCount(0);
}

test("voice messages between the extension and the web app, both ways", { tag: ["@client:extension", "@client:web", "@feature:extension.interop", "@feature:files.voice.record", "@feature:files.voice.play"] }, async ({ extensionPeer, webPeer }) => {
  const [ext, web] = await Promise.all([extensionPeer("voice-ext"), webPeer("voice-web")]);
  await pair(web, ext);
  for (const [sender, receiver] of [[ext, web], [web, ext]]) {
    // The extension's page asks for the microphone like any tab; its engine (offscreen) only carries the file.
    await hold(sender.page, 1_800);
    const received = chat(receiver).getByTestId("voice-bubble").last();
    await expect(received).toHaveAttribute("data-played", "false", { timeout: 30_000 });
    await expect(received.getByTestId("voice-time")).toHaveText(/^0:0[12]$/);
    await expect(received.getByTestId("voice-play")).toBeEnabled({ timeout: 30_000 });
    await received.getByTestId("voice-play").click();
    await expect(received).toHaveAttribute("data-state", "playing");
    await expect(received).toHaveAttribute("data-state", "idle", { timeout: 15_000 });
    await expect(received).toHaveAttribute("data-played", "true");
  }
});
