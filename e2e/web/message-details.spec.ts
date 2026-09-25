import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { GIF, chat, expect, say, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * A message's details (WISP 400 § Message details), between two people on the web: a text, a file and a voice
 * message, opened on the side that sent them and on the side that received them, say what carried them and how far
 * they got. The mic is Chromium's fake one, playing e2e/support/voice-sample.wav.
 */

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

const rowOf = (peer: Peer, text: string) => chat(peer).locator("[data-message-row]").filter({ hasText: text }).last();
const panel = (page: Page) => page.getByTestId("message-details");
const field = (page: Page, label: string) => panel(page).locator(`[data-testid="message-details-row"][data-label="${label}"]`);

/** Opens a message's details from its ⋮ menu (the row must be hovered for the ⋮ to show on a pointer). */
async function openFromMenu(peer: Peer, row: Locator) {
  await row.hover();
  await row.getByTestId("message-options").click();
  await peer.page.getByTestId("message-details").click();
  await expect(panel(peer.page)).toHaveAttribute("data-loaded", "yes");
}

async function close(page: Page) {
  await page.keyboard.press("Escape");
  await expect(panel(page)).toHaveCount(0);
}

/** Presses the mic with the mouse, holds it for `ms` and lets go. */
async function holdMic(page: Page, ms: number) {
  const mic = page.getByTestId("voice-record");
  const box = (await mic.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId("voice-bar")).toHaveAttribute("data-phase", "recording");
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

test("message details: a text, a file and a voice message, on both sides", { tag: ["@feature:chat.paired.message-details"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("details-alice"), peer("details-bob")]);
  await pair(alice, bob);

  // A text, seen from the side that sent it (double click) and from the side that got it (the ⋮ menu).
  await say(alice, "how did this travel?");
  await expect(chat(bob).getByText("how did this travel?")).toBeVisible();
  await rowOf(alice, "how did this travel?").dblclick();
  await expect(panel(alice.page)).toHaveAttribute("data-loaded", "yes");
  await expect(panel(alice.page)).toHaveAttribute("data-side", "end");
  await expect(rowOf(alice, "how did this travel?")).toHaveAttribute("data-details-open", "true");
  await expect(field(alice.page, "Sent over")).toHaveText("WebRTC, direct");
  await expect(field(alice.page, "Protocol").first()).toHaveText("chat/1");
  await expect(field(alice.page, "Frame")).toHaveText("paired-message");
  await expect(field(alice.page, "State")).toHaveText("Delivered (receipt received)");
  await expect(field(alice.page, "Receipt after")).toHaveText(/^\d+ ms$|^\d+\.\d+ s$/);
  await expect(field(alice.page, "Sender key")).toHaveAttribute("data-value", /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/);
  await expect(panel(alice.page).getByTestId("message-details-summary")).toContainText("sent live over WebRTC, direct, encrypted end to end, receipt in");
  await expect(panel(alice.page).getByTestId("message-details-keys-hint")).toHaveText("Keys are never shown here.");
  await expect(field(alice.page, "Contact key pinned")).toContainText("trusted on first use");
  // Copy all as JSON gives the engine's view too.
  await panel(alice.page).getByTestId("message-details-copy-all").click();
  const copied = JSON.parse(await alice.page.evaluate(() => navigator.clipboard.readText()));
  expect(copied).toMatchObject({ kind: "Text", path: { "Sent over": "WebRTC, direct" }, engine: { message: { kind: "text" } } });
  await close(alice.page);
  await expect(rowOf(alice, "how did this travel?")).not.toHaveAttribute("data-details-open");

  await openFromMenu(bob, rowOf(bob, "how did this travel?"));
  await expect(field(bob.page, "Received over")).toHaveText("WebRTC, direct");
  await expect(field(bob.page, "Direction")).toHaveText("Received");
  await expect(field(bob.page, "After composing")).toContainText("by the two devices' clocks");
  await expect(field(bob.page, "Channel")).toHaveText("WebRTC data channel: DTLS 1.2+ with SCTP");
  await close(bob.page);

  // A file: files/3 between two current apps, its digest and chunking on both sides.
  await alice.page.getByTestId("file-input").setInputFiles({ name: "ghost.gif", mimeType: "image/gif", buffer: GIF });
  const bobsFile = chat(bob).getByTestId("file-bubble").filter({ hasText: "ghost.gif" });
  await expect(bobsFile).toBeVisible();
  await openFromMenu(alice, rowOf(alice, "ghost.gif"));
  await expect(field(alice.page, "Kind")).toHaveText("File");
  await expect(field(alice.page, "Name")).toHaveText("ghost.gif");
  await expect(field(alice.page, "Type")).toHaveText("image/gif");
  await expect(field(alice.page, "Size")).toHaveText(`${GIF.length} bytes`);
  await expect(field(alice.page, "Protocol").last()).toHaveText("files/3");
  await expect(field(alice.page, "Chunks")).toHaveText("1 × 16.0 KB (16,384 bytes)");
  await expect(field(alice.page, "Transfer")).toHaveText("done");
  await expect(field(alice.page, "SHA-256")).toHaveAttribute("data-value", /^[A-Za-z0-9_-]{43}$|^[a-f0-9]{64}$/);
  await close(alice.page);
  await openFromMenu(bob, rowOf(bob, "ghost.gif"));
  await expect(field(bob.page, "Received over")).toHaveText("WebRTC, direct");
  await expect(field(bob.page, "Transfer")).toHaveText("done");
  await expect(field(bob.page, "Stored as")).toContainText(/private file system|IndexedDB/);
  await close(bob.page);

  // A voice message: its codec, length and waveform, on both sides.
  await holdMic(alice.page, 1_500);
  const bobsVoice = chat(bob).getByTestId("voice-bubble").last();
  await expect(bobsVoice.getByTestId("voice-play")).toBeEnabled({ timeout: 30_000 });
  await openFromMenu(bob, chat(bob).locator("[data-message-row]").filter({ has: bobsVoice }));
  await expect(field(bob.page, "Kind")).toHaveText("Voice message");
  await expect(field(bob.page, "Codec")).toHaveText(/Opus in WebM|Opus in Ogg/);
  await expect(field(bob.page, "Length")).toHaveText(/^\d+(\.\d+)? s$/);
  await expect(field(bob.page, "Waveform")).toHaveText("64 peaks");
  await expect(field(bob.page, "Received over")).toHaveText("WebRTC, direct");
  await close(bob.page);
  await openFromMenu(alice, chat(alice).locator("[data-message-row]").filter({ has: chat(alice).getByTestId("voice-bubble").last() }));
  await expect(field(alice.page, "Sent over")).toHaveText("WebRTC, direct");
  await expect(field(alice.page, "Waveform")).toHaveText("64 peaks");
  await expect(panel(alice.page).getByTestId("message-details-summary")).toContainText("Voice message sent live over WebRTC");
  await close(alice.page);
});

test("message details on a phone: a long press opens a sheet from the bottom", { tag: ["@feature:chat.paired.message-details", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("details-phone-alice"), peer("details-phone-bob", { mobile: true })]);
  await pair(alice, bob);
  await say(alice, "press and hold me");
  const row = rowOf(bob, "press and hold me");
  await expect(row).toBeVisible();
  // A finger held on the message: the same pointer events a touch screen sends.
  const box = (await row.boundingBox())!;
  const at = { pointerType: "touch", button: 0, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, bubbles: true };
  await row.dispatchEvent("pointerdown", at);
  await bob.page.waitForTimeout(700);
  await row.dispatchEvent("pointerup", at);
  await expect(panel(bob.page)).toHaveAttribute("data-loaded", "yes");
  await expect(panel(bob.page)).toHaveAttribute("data-side", "bottom");
  await expect(field(bob.page, "Received over")).toHaveText("WebRTC, direct");
  // A tap outside closes it.
  await bob.page.getByTestId("message-details-backdrop").click({ position: { x: 10, y: 10 } });
  await expect(panel(bob.page)).toHaveCount(0);
});
