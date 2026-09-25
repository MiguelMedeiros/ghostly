import { expect, test, type Page } from "@playwright/test";

/**
 * The home's wallet deck is the app's: with a mouse, a stack whose cards come up as the pointer passes over them
 * (no click), the arrow keys, Home and End move along it, and it deals the next card by itself until the reader
 * touches it. The phone's track is wallet-deck-phone.spec.ts.
 */

const RAILS = ["cashu", "lightning", "arkade", "bark", "spark", "bitcoin", "fedimint", "usdt"];
const card = (page: Page, rail: string) => page.getByTestId(`wallet-card-${rail}`);
const active = (page: Page) => page.locator(".wallet-deck-card[data-active=true]");

async function openDeck(page: Page) {
  await page.goto("/");
  const deck = page.locator(".wallet-deck");
  await deck.scrollIntoViewIfNeeded();
  await expect(deck).toBeVisible();
  return deck;
}

test("every wallet of the app, in its order, as the app's stack", async ({ page }) => {
  const deck = await openDeck(page);
  await expect(deck).toHaveAttribute("data-mode", "stack");
  const ids = await page.locator(".wallet-deck-card").evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!.replace("wallet-card-", "")));
  expect(ids).toEqual(RAILS);
  await expect(page.getByRole("tablist", { name: "One wallet, many ways to pay." })).toBeVisible();
  // The arrows under the deck are the app's; the site's "Choose a card" caption is gone.
  await expect(page.getByTestId("wallet-deck-next")).toBeVisible();
  await expect(page.getByText("Choose a card", { exact: true })).toHaveCount(0);
});

test("a card comes up as the pointer passes over it, with no click", async ({ page }) => {
  await openDeck(page);
  let clicks = 0;
  await page.exposeFunction("countClick", () => clicks++);
  await page.evaluate(() => document.addEventListener("click", () => (window as unknown as { countClick: () => void }).countClick(), true));

  for (const rail of ["fedimint", "bark", "spark"]) {
    // A card's button is the strip of it that shows: its middle is on that card.
    const box = (await card(page, rail).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await expect(card(page, rail)).toHaveAttribute("data-active", "true");
    await expect(card(page, rail)).toHaveAttribute("aria-selected", "true");
  }
  // The chosen card's details are in the panel under the deck.
  await expect(page.locator("#wallet-panel")).toContainText("Bitcoin on Spark");
  await expect(page.locator("#wallet-panel")).toHaveAttribute("aria-labelledby", "wallet-tab-spark");
  // It lifted: its face stands higher than the cards beside it.
  const lift = async (rail: string) => (await card(page, rail).locator("[data-deck=face]").boundingBox())!.y;
  await expect.poll(async () => (await lift("bark")) - (await lift("spark"))).toBeGreaterThan(5);
  expect(clicks).toBe(0);

  // Pointing at it stopped the dealing for good, even after the pointer leaves.
  await page.mouse.move(5, 5);
  await page.waitForTimeout(4500);
  await expect(card(page, "spark")).toHaveAttribute("data-active", "true");
});

/**
 * Runs in a blank page: for each frame (a PNG), the sharpest step in brightness between pixels 2 apart along the rows
 * of the card's middle, inside its edges. The card's surface and its sheen are soft gradients; a hard edge in there
 * is a picture of something that is not on the card.
 */
async function sharpestStep({ frames, face }: { frames: string[]; face: { x: number; y: number; width: number; height: number } }) {
  const steps: number[] = [];
  for (const png of frames) {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const g = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d", { willReadFrequently: true })!;
    g.drawImage(bitmap, 0, 0);
    // Clear of the card's edges wherever the lift and the swing take them.
    const x0 = Math.round(face.x + 16), w = Math.round(face.width - 32);
    let sharpest = 0;
    for (let y = Math.round(face.y + face.height * 0.3); y <= face.y + face.height * 0.7; y += 3) {
      const px = g.getImageData(x0, y, w, 1).data;
      const light = (i: number) => 0.2126 * px[4 * i] + 0.7152 * px[4 * i + 1] + 0.0722 * px[4 * i + 2];
      for (let i = 0; i + 2 < w; i++) sharpest = Math.max(sharpest, Math.abs(light(i + 2) - light(i)));
    }
    steps.push(Math.round(sharpest));
  }
  return steps;
}

test("a card comes up whole: no second edge inside it as the sheen crosses, whichever way the pointer goes", async ({ page }) => {
  // A screen-blended sheen crossing a card that swings was drawn against a shifted copy of the card: a second card
  // edge, with square corners, on the side the light came in from, for about a tenth of a second. Only real-speed
  // frames show it (with the animations slowed down or paused it never appears), so this films a switch.
  await openDeck(page);
  // Only the card's surface and the sheen: its words, marks and ghost would be edges of their own.
  await page.addStyleTag({ content: ".wallet-deck-face>:not([data-deck=sheen]){visibility:hidden!important}" });
  const cdp = await page.context().newCDPSession(page);
  const lab = await page.context().newPage();
  for (const [from, to] of [["lightning", "arkade"], ["fedimint", "bitcoin"]]) {
    const box = (await card(page, from).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
    await expect(card(page, from)).toHaveAttribute("data-active", "true");
    await page.waitForTimeout(1200);

    const frames: { png: string; at: number }[] = [];
    const onFrame = ({ data, metadata, sessionId }: { data: string; metadata: { timestamp?: number }; sessionId: number }) => {
      frames.push({ png: data, at: (metadata.timestamp ?? 0) * 1000 });
      cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    };
    cdp.on("Page.screencastFrame", onFrame);
    await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
    // When the card came up, by the page's clock (the frames carry the same wall clock).
    await card(page, to).evaluate((el) => {
      (window as unknown as { cameUp: Promise<number> }).cameUp = new Promise((resolve) =>
        new MutationObserver((_, observer) => { if (el.getAttribute("data-active") === "true") { observer.disconnect(); resolve(Date.now()); } }).observe(el, { attributes: true }));
    });
    const next = (await card(page, to).boundingBox())!;
    await page.mouse.move(next.x + next.width / 2, next.y + next.height / 2, { steps: 1 });
    const cameUp = await page.evaluate(() => (window as unknown as { cameUp: Promise<number> }).cameUp);
    await page.waitForTimeout(1000);
    await cdp.send("Page.stopScreencast");
    cdp.off("Page.screencastFrame", onFrame);

    // The switch from a tenth of a second in (the card is on top by then) to its end.
    const during = frames.filter((f) => f.at >= cameUp + 100 && f.at <= cameUp + 900).map((f) => f.png);
    expect(during.length, `${from} to ${to}: frames filmed`).toBeGreaterThan(10);
    const face = (await card(page, to).locator("[data-deck=face]").boundingBox())!;
    const steps = await lab.evaluate(sharpestStep, { frames: during, face });
    expect(Math.max(...steps), `${from} to ${to}: sharpest step inside the card, frame by frame: ${steps.join(" ")}`).toBeLessThan(16);
  }
});

test("the keyboard moves through the cards", async ({ page }) => {
  await openDeck(page);
  await active(page).focus();
  await page.keyboard.press("Home");
  await expect(card(page, "cashu")).toBeFocused();
  await expect(card(page, "cashu")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(card(page, "lightning")).toBeFocused();
  await expect(card(page, "lightning")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(card(page, "usdt")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(card(page, "cashu")).toBeFocused();
  await expect(page.locator("#wallet-panel")).toContainText("Private ecash tokens");
  // The focused card wears a visible ring.
  const outline = await card(page, "cashu").locator("[data-deck=face]").evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).toBe("solid");
});

test("the deck deals by itself while nobody touches it", async ({ page }) => {
  await openDeck(page);
  // Keep the pointer off the deck.
  await page.mouse.move(5, 5);
  const first = await active(page).getAttribute("data-testid");
  await expect(active(page)).not.toHaveAttribute("data-testid", first!, { timeout: 6000 });
});

test("with reduced motion the deck stays where the reader leaves it", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openDeck(page);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(4500);
  await expect(card(page, "cashu")).toHaveAttribute("data-active", "true");
});
