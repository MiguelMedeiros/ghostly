import { fileURLToPath } from "node:url";
import { chat, expect, say, test } from "../support/fixtures";
import { pair } from "../support/paired";

/**
 * A phone on its side (iPhone 17: 874 by 402, the Dynamic Island 62px into one end, the home indicator 20px
 * above the bottom). The page runs under both (viewport-fit=cover), so the app keeps its content clear of the
 * sides. Chromium's DevTools protocol plays the safe area.
 */
const LANDSCAPE = { width: 874, height: 402 };
const SIDE = 62;
const HOME = 20;

test("a phone on its side: nothing sits under the notch or the home indicator", { tag: ["@feature:app.mobile-layout", "@feature:app.responsive"] }, async ({ peer }) => {
  const { page } = await peer("alice", { mobile: true, viewport: LANDSCAPE });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { left: SIDE, right: SIDE, top: 0, bottom: HOME } });
  await expect.poll(() => page.evaluate(() => {
    const probe = document.body.appendChild(document.createElement("div"));
    probe.style.paddingLeft = "env(safe-area-inset-left)";
    const inset = getComputedStyle(probe).paddingLeft;
    probe.remove();
    return inset;
  })).toBe(`${SIDE}px`);

  for (const locator of [page.getByPlaceholder("Search chats..."), page.getByTitle("New Chat").first()]) {
    const box = (await locator.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(SIDE);
    expect(box.x + box.width).toBeLessThanOrEqual(LANDSCAPE.width - SIDE);
  }
  // Nothing wider than the screen for the insets.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(LANDSCAPE.width);

  // A chat: its header and composer too.
  await page.getByTitle("New Chat").first().click();
  for (const locator of [page.getByPlaceholder("Message…"), page.getByTestId("chat-options")]) {
    const box = (await locator.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(SIDE);
    expect(box.x + box.width).toBeLessThanOrEqual(LANDSCAPE.width - SIDE);
  }
  // Two panes, both bottom rows above the home indicator: the message field and the account bar's places sat 7px into
  // it (an installed iPad too, 20px under both).
  const composer = (await page.locator(".composer-row").boundingBox())!;
  expect(composer.y + composer.height).toBeLessThanOrEqual(LANDSCAPE.height - HOME);
  for (const place of await page.getByTestId("account-bar").locator(".account-action").all()) {
    const box = (await place.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(LANDSCAPE.height - HOME);
  }

  // With the keyboard up the indicator is covered: the composer stands on the keyboard, no band for it in between.
  const field = page.getByPlaceholder("Message…");
  const composerPadding = () => page.locator("[data-composer]").evaluate((element) => parseFloat(getComputedStyle(element).paddingBottom));
  const resting = await composerPadding();
  await field.focus();
  await page.setViewportSize({ width: LANDSCAPE.width, height: LANDSCAPE.height - 200 });
  await expect(page.locator("html")).toHaveAttribute("data-keyboard", "true");
  await expect.poll(composerPadding).toBe(resting - HOME);
});

test("a phone on its side: the chat beside the list uses its width, and a video keeps its shape", { tag: ["@feature:app.mobile-layout", "@feature:files.video.play"] }, async ({ peer }) => {
  // Two panes from 768px: the chat is what the list and the notch leave (about 330px here). Its rows kept a desktop's
  // 63px on each side, so a message took a third of it and a video became a tall black box around a small picture.
  const [alice, bob] = await Promise.all([peer("side-alice"), peer("side-bob", { mobile: true, viewport: LANDSCAPE })]);
  const cdp = await bob.page.context().newCDPSession(bob.page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { left: SIDE, right: SIDE, top: 0, bottom: 20 } });
  await pair(alice, bob);
  const text = "A message long enough to fill a whole line of the chat and then wrap onto a second one";
  await say(alice, text);
  await expect(chat(bob).getByText(text)).toBeVisible({ timeout: 30_000 });
  await alice.page.getByTestId("media-input").setInputFiles(fileURLToPath(new URL("../support/video-fixtures/ghosts.mp4", import.meta.url)));
  const frame = chat(bob).getByTestId("video-frame").last();
  await expect(frame).toBeVisible({ timeout: 30_000 });

  const listWidth = await chat(bob).evaluate((list) => list.clientWidth);
  expect(listWidth).toBeLessThan(400);
  const bubble = chat(bob).locator("[data-message-bubble]", { hasText: text });
  expect((await bubble.boundingBox())!.width).toBeGreaterThan(listWidth * 0.6);
  // 320 by 180: as wide as the chat lets it, as tall as that makes it.
  const box = (await frame.boundingBox())!;
  expect(box.width / box.height).toBeCloseTo(16 / 9, 1);
});
