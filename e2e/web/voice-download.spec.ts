import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Download, Locator, Page } from "@playwright/test";
import { chat, expect, say, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";

/** The same fake microphone as voice-messages.spec.ts: a voice-like tone on a loop. */
const SAMPLE = fileURLToPath(new URL("../support/voice-sample.wav", import.meta.url));

test.use({
  launchOptions: {
    args: [
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${SAMPLE}`,
    ],
  },
});

/** The last voice message's row in a peer's chat (a `has` locator is relative to the row, so it starts from the page). */
const voiceRow = (peer: Peer) => chat(peer).locator("[data-message-row]").filter({ has: peer.page.getByTestId("voice-bubble") }).last();

/** Opens a message's ⋮ and returns its menu's rows, in order. */
async function openMenu(page: Page, message: Locator): Promise<string[]> {
  await message.hover();
  await message.getByTestId("message-options").click();
  const menu = page.getByTestId("message-menu");
  await expect(menu).toBeVisible();
  return menu.locator("[data-menu-item]").evaluateAll((items) => items.map((item) => item.getAttribute("data-testid") ?? ""));
}

async function download(page: Page, message: Locator): Promise<Download> {
  await openMenu(page, message);
  const [file] = await Promise.all([page.waitForEvent("download"), page.getByTestId("message-download").click()]);
  await expect(page.getByTestId("message-menu")).toHaveCount(0);
  return file;
}

test("a voice message downloads from its ⋮ menu, under a readable name, the same bytes on both sides", { tag: ["@feature:files.download"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("vdl-alice"), peer("vdl-bob")]);
  await pair(alice, bob);

  // Hold the mic for a moment and let go: the voice message goes to Bob.
  const mic = alice.page.getByTestId("voice-record");
  const box = (await mic.boundingBox())!;
  await alice.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await alice.page.mouse.down();
  await expect(alice.page.getByTestId("voice-bar")).toHaveAttribute("data-phase", "recording");
  await alice.page.waitForTimeout(1_600);
  await alice.page.mouse.up();

  const received = chat(bob).getByTestId("voice-bubble").last();
  await expect(received.getByTestId("voice-play")).toBeEnabled({ timeout: 30_000 });
  const message = voiceRow(bob);

  // Reply, then Download, then Details, then Delete last.
  const items = await openMenu(bob.page, message);
  expect(items[0]).toBe("message-reply");
  expect(items[1]).toBe("message-download");
  expect(items.indexOf("message-details")).toBe(2);
  await expect(bob.page.getByTestId("message-download")).toBeEnabled();
  await bob.page.keyboard.press("Escape");

  const got = await download(bob.page, message);
  const name = /^Ghostly voice \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.(webm|ogg|m4a|wav)$/;
  expect(got.suggestedFilename()).toMatch(name);
  const bytes = await readFile((await got.path())!);
  expect(bytes.length).toBeGreaterThan(1_000);

  // The sender's own copy is the same recording, byte for byte, in its own container.
  const sent = await download(alice.page, voiceRow(alice));
  expect(sent.suggestedFilename()).toMatch(name);
  expect((await readFile((await sent.path())!)).equals(bytes)).toBe(true);

  // A text message carries no file: nothing to download.
  await say(alice, "just words");
  const text = chat(bob).locator("[data-message-row]").filter({ hasText: "just words" }).last();
  await expect(text).toBeVisible({ timeout: 30_000 });
  expect(await openMenu(bob.page, text)).not.toContain("message-download");
});
