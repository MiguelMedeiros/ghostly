import { createWriteStream, readFileSync, statSync } from "node:fs";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { TEST_COINS, chat, expect, getTestCoins, openProfilePage, openWallet, say, test, useTestnet } from "../support/fixtures";
import { pair } from "../support/paired";

// WISP 05 § Light backups: everything of a profile but the bytes of its larger files. A 20 MB file and a voice
// message arrive in a chat; the light backup keeps the voice message and leaves the 20 MB file out.
const PASSPHRASE = "a light backup passphrase";
const MIB = 1024 * 1024;
/** Chromium's fake microphone plays this on a loop (see voice-messages.spec.ts). */
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

/** Deterministic bytes on disk, a step at a time. */
async function generate(path: string, size: number): Promise<void> {
  const out = createWriteStream(path);
  for (let offset = 0; offset < size; offset += MIB) {
    const part = Buffer.alloc(Math.min(MIB, size - offset));
    for (let i = 0; i < part.length; i++) part[i] = ((offset + i) * 31 + ((offset + i) >> 11)) & 0xff;
    if (!out.write(part)) await once(out, "drain");
  }
  out.end();
  await once(out, "finish");
}

/** Records a voice message by holding the mic. */
async function record(page: Page, ms: number): Promise<void> {
  const mic = page.getByTestId("voice-record");
  const box = (await mic.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId("voice-bar")).toHaveAttribute("data-phase", "recording");
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

/** Downloads a backup of the profile open on the page, with `content` chosen; its bytes. */
async function backUp(page: Page, content: "Everything" | "Light"): Promise<Buffer> {
  const backups = page.getByTestId("profile-backups");
  await backups.getByTestId("backup-content").getByRole("radio", { name: content }).click();
  await backups.getByTestId("backup-passphrase").fill(PASSPHRASE);
  await backups.getByTestId("backup-confirm").fill(PASSPHRASE);
  const downloading = page.waitForEvent("download");
  await backups.getByTestId("backup-download").click();
  const path = (await (await downloading).path())!;
  await expect(backups.getByTestId("backup-done")).toContainText("Downloaded");
  return readFileSync(path);
}

test("a light backup leaves the 20 MB file out, keeps every message, the voice message and the wallet, and says what it left out", { tag: ["@feature:backup.light", "@feature:backup.profile.file", "@feature:backup.profile.same-device"] }, async ({ peer, browserName }, testInfo) => {
  test.skip(browserName !== "chromium", "The voice message is recorded from Chromium's fake microphone");
  test.setTimeout(8 * 60_000);
  const [alice, bob] = await Promise.all([peer("light-alice"), peer("light-bob")]);
  await pair(alice, bob);

  // A conversation: texts both ways, a 20 MB file and a voice message from Alice.
  for (const [who, text] of [[alice, "first from alice"], [bob, "answer from bob"], [alice, "second from alice"]] as const) {
    await say(who, text);
    await expect(chat(who === alice ? bob : alice).getByText(text)).toBeVisible();
  }
  const big = testInfo.outputPath("holiday video.bin");
  await generate(big, 20 * MIB);
  await alice.page.getByTestId("file-input").setInputFiles(big);
  const arrived = chat(bob).getByTestId("file-bubble").filter({ hasText: "holiday video.bin" });
  await expect(arrived.getByTestId("file-save")).toBeVisible({ timeout: 150_000 });
  await record(alice.page, 2_600);
  const voice = chat(bob).getByTestId("voice-bubble").last();
  await expect(voice.getByTestId("voice-play")).toBeEnabled({ timeout: 60_000 });

  // Test sats in Bob's wallet.
  await useTestnet(bob);
  await getTestCoins(bob);
  await expect(bob.page.getByTestId("wallet-balance")).toHaveText(/^10,000\s*test sats/);

  // Back up opened: the size of each choice, from the file store, before anything is made.
  await openProfilePage(bob.page);
  const backups = bob.page.getByTestId("profile-backups");
  await backups.getByTestId("backup-open").click();
  const size = backups.getByTestId("backup-content-size");
  await expect(size).toHaveText(/^Files: 20\.0 MB$/);
  await backups.getByTestId("backup-content").getByRole("radio", { name: "Light" }).click();
  await expect(size).toHaveText(/^Files: \d+ KB\. Leaves out 20\.0 MB\.$/);
  await backups.getByTestId("backup-content").getByTestId("row-info").click();
  await expect(backups.getByTestId("backup-content")).toContainText("voice messages up to 4 MB stay");

  const everything = await backUp(bob.page, "Everything");
  const light = await backUp(bob.page, "Light");
  await expect(backups.getByTestId("backup-done")).toContainText("Files over 1 MB were left out (20.0 MB).");
  testInfo.annotations.push({ type: "sizes", description: `everything ${everything.length} bytes, light ${light.length} bytes` });
  expect(everything.length).toBeGreaterThan(20 * MIB);
  expect(light.length, "the light one is a small fraction of it").toBeLessThan(everything.length / 20);

  // Restored as a copy: every message, the wallet, the voice message plays, and the 20 MB file says it is not here.
  await backups.getByTestId("restore-open").click();
  await backups.getByTestId("restore-file").setInputFiles({ name: "light.ghostly-backup", mimeType: "application/octet-stream", buffer: light });
  await backups.getByTestId("restore-passphrase").fill(PASSPHRASE);
  await backups.getByTestId("restore-go").click();
  await backups.getByTestId("restore-same-device").getByTestId("restore-copy").click();
  await expect(bob.page.getByTestId("profile-restored-tag")).toHaveText("Restored", { timeout: 120_000 });

  await openWallet(bob, "cashu-testnet");
  await expect(bob.page.getByTestId("wallet-balance")).toHaveText(new RegExp(`^${TEST_COINS.toLocaleString("en-US")}\\s*test sats`));
  await bob.page.goto("/#/");
  await bob.page.getByTestId("sidebar").getByTestId("chat-row").first().click();
  for (const text of ["first from alice", "answer from bob", "second from alice"]) await expect(chat(bob).getByText(text)).toBeVisible();
  const leftOut = chat(bob).getByTestId("file-bubble").filter({ hasText: "holiday video.bin" });
  await expect(leftOut.getByTestId("file-status")).toHaveText("Not in this backup");
  await expect(leftOut.getByTestId("file-save"), "nothing to save: its bytes are not here").toHaveCount(0);
  await expect(leftOut.getByTestId("file-request"), "and nothing asks the sender for a finished file").toHaveCount(0);
  const kept = chat(bob).getByTestId("voice-bubble").last();
  await kept.getByTestId("voice-play").click();
  await expect(kept).toHaveAttribute("data-state", "playing");
  expect(statSync(big).size).toBe(20 * MIB);
});
