import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { chat, connect, expect, link, test, type Peer } from "../support/fixtures";

/**
 * Settings → Text size reaches a chat's files as it reaches its messages: a file's name and its line, an audio file's
 * name and time, an offer's words are half again their size at Huge, and none of them goes past a phone's screen. The
 * buttons keep their size.
 */
test.describe.configure({ timeout: 5 * 60_000 });

const PHONE = { width: 390, height: 844 };
const MP3 = fileURLToPath(new URL("../support/audio-fixtures/ghost-tune.mp3", import.meta.url));

const px = (target: Locator) => target.evaluate((element) => Math.round(parseFloat(getComputedStyle(element).fontSize) * 10) / 10);

/** The page wider than the screen, or one of `targets` past its edge or wider than its box. */
const cut = (page: Page, targets: Record<string, Locator>) => Promise.all(Object.entries(targets).map(([name, target]) => target.evaluate((element, name) => {
  const box = element.getBoundingClientRect();
  if (box.left < -0.5 || box.right > window.innerWidth + 0.5) return `${name} at ${box.left}-${box.right}`;
  return element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).textOverflow !== "ellipsis" ? `${name} ${element.scrollWidth} wide in ${element.clientWidth}` : "";
}, name))).then(async (out) => [...out.filter(Boolean), ...(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth ? [`page ${document.documentElement.scrollWidth}`] : []))]);

async function textSize(page: Page, textSize: string): Promise<void> {
  await page.evaluate((textSize) => localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}"), textSize })), textSize);
  await page.reload();
}

async function openChat(peer: Peer): Promise<void> {
  await peer.page.goto("/#/");
  await peer.page.getByTestId("chat-row").first().click();
  await expect(chat(peer)).toBeVisible();
}

test("at Text size Huge on a phone, a file's, an audio file's and an offer's words grow with the messages", { tag: ["@feature:settings.text-size", "@feature:app.mobile-layout", "@feature:files.paired.send", "@feature:files.audio.play", "@feature:files.large.offer"] }, async ({ peer }, testInfo) => {
  const [alice, bob] = await Promise.all([peer("media-alice"), peer("media-bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  const page = bob.page;

  // A small file and an audio file Bob takes at once; one over 25 MiB he is asked for.
  const notes = testInfo.outputPath("notes.txt");
  writeFileSync(notes, "lunch at noon\n");
  const big = testInfo.outputPath("photos.zip");
  writeFileSync(big, Buffer.alloc(26 * 1024 * 1024, 7));
  await alice.page.getByTestId("file-input").setInputFiles(notes);
  await alice.page.getByTestId("file-input").setInputFiles(MP3);
  await alice.page.getByTestId("file-input").setInputFiles(big);

  const file = chat(bob).getByTestId("file-bubble").filter({ hasText: "notes.txt" });
  const audio = chat(bob).getByTestId("audio-bubble").last();
  const offer = chat(bob).getByTestId("file-offer");
  const words = {
    fileName: file.locator("p[title]"),
    fileStatus: file.getByTestId("file-status"),
    audioName: audio.getByTestId("audio-name"),
    audioTime: audio.getByTestId("audio-time"),
    offer: offer.locator("p").first(),
    accept: chat(bob).getByTestId("file-accept"),
  };
  await expect(words.fileName).toHaveText("notes.txt", { timeout: 60_000 });
  await expect(words.audioName).toHaveText("ghost-tune.mp3", { timeout: 60_000 });
  await expect(words.offer).toContainText("photos.zip", { timeout: 60_000 });
  const sizes = async () => Object.fromEntries(await Promise.all(Object.entries(words).map(async ([name, target]) => [name, await px(target)])));
  expect(await sizes()).toEqual({ fileName: 14, fileStatus: 11, audioName: 13.5, audioTime: 11, offer: 12, accept: 12 });

  await textSize(page, "huge");
  await page.setViewportSize(PHONE);
  await openChat(bob);
  await expect(words.offer).toBeVisible();
  // Half again their size, as the messages are; the offer's button keeps its own.
  expect(await sizes()).toEqual({ fileName: 21, fileStatus: 16.5, audioName: 20.3, audioTime: 16.5, offer: 18, accept: 12 });
  const { accept: _, ...lines } = words;
  expect(await cut(page, lines)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("media-huge.png"), fullPage: true });
});
