import { expect, type Page } from "@playwright/test";

/** The story's lines a reader has on screen (below the nav). Not a deck's card details (HomeDeck.tsx): the deck deals
 * the next card by itself every few seconds, so they change with the time on the page, not with the place. */
function linesOnScreen() {
  const lines = new Set<string>();
  for (const el of document.querySelectorAll("main h1, main h2, main h3, main h4, main p, main figcaption, main blockquote")) {
    const r = el.getBoundingClientRect();
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length < 12 || r.height === 0 || getComputedStyle(el).visibility === "hidden" || el.closest("[aria-hidden=true], svg, [role=tabpanel]")) continue;
    if (r.top >= 64 && r.bottom <= innerHeight) lines.add(text.slice(0, 60));
  }
  return [...lines];
}

/**
 * The page has run: on a touch screen or a narrow window the chapters have taken their own shape (no film steps
 * left from the server's page, stage.tsx). A slow runner can take seconds past `load` for it; lines read before it
 * are the server's page, not the one the reader reads.
 */
function shaped() {
  return !matchMedia("(pointer: coarse), (max-width: 860px)").matches || !document.querySelector(".scene-steps");
}

/**
 * A real touch screen keeps its pointer. An emulated one is gone as a reload starts, with the old page still up (on a
 * slow runner, for up to seconds): the head's script (layout.tsx) then takes `data-touch` away, and on its way out the
 * page reads as a wide window with a mouse, keeps no place, and the browser restores the offset into the server's page.
 */
function touchStays() {
  const coarse = "(pointer: coarse)";
  const read = Object.getOwnPropertyDescriptor(MediaQueryList.prototype, "matches")!.get!;
  const add = MediaQueryList.prototype.addEventListener;
  const held = read.call(matchMedia(coarse));
  Object.defineProperty(MediaQueryList.prototype, "matches", {
    get(this: MediaQueryList) {
      return this.media === coarse ? held : read.call(this);
    },
  });
  MediaQueryList.prototype.addEventListener = function (this: MediaQueryList, ...args: Parameters<typeof add>) {
    if (this.media !== coarse) add.apply(this, args);
  };
}

/**
 * A reader scrolls the home to `at` (a fraction of the way down), reloads it, and finds the lines they were reading
 * on screen once the reloaded page has settled. `sameOffset`: the page is the server's (a wide window with a
 * mouse), where the offset is the place, to the frame of a scroll-driven film.
 */
export async function reloadKeepsLines(page: Page, at: number, sameOffset = false) {
  await page.addInitScript(touchStays);
  await page.goto("/", { waitUntil: "load" });
  await page.waitForFunction(shaped);
  await page.waitForTimeout(1500);
  // A real wheel at the end, so the page knows a reader is here (html.landed), as it would.
  await page.mouse.move(200, 200);
  await page.evaluate((at) => scrollTo({ top: Math.round((document.documentElement.scrollHeight - innerHeight) * at) - 300, behavior: "instant" }), at);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(1500);
  let before = await page.evaluate(linesOnScreen);
  // A spot with only a picture on screen: on to the next lines.
  for (let i = 0; i < 6 && !before.length; i++) {
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(800);
    before = await page.evaluate(linesOnScreen);
  }
  expect(before.length, "lines on screen before the reload").toBeGreaterThan(0);
  const y = await page.evaluate(() => scrollY);

  await page.reload({ waitUntil: "load" });
  // Settled: in its shape, and done taking the reader back (KeepPlace holds the place while the page settles, then
  // lets go); the page then stays where it is.
  await page.waitForFunction(shaped);
  await page.waitForFunction(() => !document.documentElement.dataset.landing);
  await page.waitForTimeout(500);
  const after = await page.evaluate(linesOnScreen);
  const kept = before.filter((line) => after.includes(line));
  expect(kept, `before: ${before.join(" / ")}\nafter: ${after.join(" / ")}`).toEqual(before);
  if (sameOffset) expect(Math.abs((await page.evaluate(() => scrollY)) - y), `offset ${y}`).toBeLessThanOrEqual(1);
}
