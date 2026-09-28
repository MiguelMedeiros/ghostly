import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { chat, expect, openProfilePage, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * Forwards (WISP 400 § Forwards). Bo sends Ana a voice note and a picture; Ana chooses both (⋮ → Select, then the
 * other row) and forwards them to Cy. Cy's copies say Forwarded and nothing of Bo; the voice note plays with its
 * waveform, the picture shows. Ana never asks Bo for the bytes again: they go from her device.
 */

/** Chromium's fake microphone plays this on a loop (see voice-messages.spec.ts). */
const SAMPLE = fileURLToPath(new URL("../support/voice-sample.wav", import.meta.url));
const PICTURE = fileURLToPath(new URL("../support/avatar-fixtures/avatar.png", import.meta.url));

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

async function setName(peer: Peer, name: string): Promise<void> {
  await openProfilePage(peer.page);
  await peer.page.getByTestId("account-nickname").fill(name);
  await expect(peer.page.getByTestId("account-nickname")).toHaveValue(name);
  await peer.page.goBack();
  await expect(peer.page.getByTitle("New Chat")).toBeVisible();
}

/** Presses the mic with the mouse, holds it for `ms` and lets go. */
async function record(page: Page, ms: number): Promise<void> {
  const mic = page.getByTestId("voice-record");
  const box = (await mic.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId("voice-bar")).toHaveAttribute("data-phase", "recording");
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

const rows = (peer: Peer) => chat(peer).locator("[data-message-row]");

test("forward a voice note and a picture to another chat: the copies say Forwarded, play and show", {
  tag: ["@feature:chat.forward", "@feature:chat.forward.files", "@feature:chat.forward.wire"],
}, async ({ peer }, testInfo) => {
  test.setTimeout(6 * 60_000);
  const [ana, bo, cy] = await Promise.all([peer("forward-ana"), peer("forward-bo"), peer("forward-cy")]);
  await Promise.all([setName(bo, "Bo"), setName(cy, "Cy")]);
  await pair(ana, bo);
  const withBo = new URL(ana.page.url()).hash;
  await pair(ana, cy);
  const withCy = new URL(ana.page.url()).hash;

  // Bo sends a voice note and a picture.
  await expect(bo.page.getByTestId("voice-record")).toBeVisible();
  await record(bo.page, 2_600);
  await bo.page.getByTestId("file-input").setInputFiles(PICTURE);

  // Ana has both, all here.
  await ana.page.evaluate((hash) => { location.hash = hash; }, withBo);
  const voiceRow = rows(ana).filter({ has: ana.page.getByTestId("voice-bubble") }).last();
  await expect(voiceRow.getByTestId("voice-play")).toBeEnabled({ timeout: 60_000 });
  const picture = rows(ana).filter({ has: ana.page.getByTestId("file-bubble") }).last();
  await expect(picture.locator("img")).toBeVisible({ timeout: 60_000 });

  // ⋮ → Select on the voice note, then a tap on the picture: two chosen.
  await voiceRow.hover();
  await voiceRow.getByTestId("message-options").click();
  await ana.page.getByTestId("message-select-start").click();
  await expect(ana.page.getByTestId("select-count")).toHaveText("1 selected");
  await picture.click();
  await expect(ana.page.getByTestId("select-count")).toHaveText("2 selected");
  await ana.page.screenshot({ path: testInfo.outputPath("forward-selecting.png") });
  await ana.page.getByTestId("select-forward").click();

  // The picker: found by name, Send, and Cy's chat opens.
  const dialog = ana.page.getByTestId("forward-dialog");
  await expect(dialog.getByTestId("forward-count")).toHaveText("2 messages");
  await dialog.getByTestId("forward-search").fill("Cy");
  await expect(dialog.getByTestId("forward-target")).toHaveCount(1);
  await dialog.getByTestId("forward-target").click();
  await ana.page.screenshot({ path: testInfo.outputPath("forward-picker.png") });
  await dialog.getByTestId("forward-send").click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => new URL(ana.page.url()).hash).toBe(withCy);
  await expect(chat(ana).getByTestId("message-forwarded")).toHaveCount(2, { timeout: 30_000 });

  // Cy: two messages from Ana that say Forwarded, never Bo.
  const forwarded = rows(cy).filter({ has: cy.page.getByTestId("message-forwarded") });
  await expect(forwarded).toHaveCount(2, { timeout: 60_000 });
  await expect(forwarded.getByTestId("message-forwarded").first()).toHaveText("Forwarded");
  await expect(chat(cy).getByTestId("message-nick").filter({ hasText: "Bo" })).toHaveCount(0);
  // The voice note plays, with the waveform it was recorded with.
  const copy = forwarded.getByTestId("voice-bubble");
  await expect(copy.getByTestId("voice-play")).toBeEnabled({ timeout: 60_000 });
  const bars = await copy.locator(".voice-wave-base .voice-wave-bar").evaluateAll((all) => new Set(all.map((bar) => (bar as HTMLElement).style.height)).size);
  expect(bars).toBeGreaterThan(3);
  await copy.getByTestId("voice-play").click();
  await expect(copy).toHaveAttribute("data-played", "true");
  await expect(copy).toHaveAttribute("data-state", "idle", { timeout: 15_000 });
  // The picture shows, drawn from bytes that arrived whole.
  const image = forwarded.filter({ has: cy.page.getByTestId("file-bubble") }).locator("img");
  await expect(image).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await cy.page.screenshot({ path: testInfo.outputPath("forwarded-copies.png") });
});
