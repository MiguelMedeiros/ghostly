import type { Route } from "@playwright/test";
import { openExpressions } from "../support/composer";
import { expect, GIFCITIES, GIFCITIES_RATE_LIMIT, gifCitiesAnswer, test } from "../support/fixtures";

/**
 * GifCities limits requests per IP, and says so with a 200 HTML page that has no CORS header: a browser page's fetch of
 * it fails as a network error does. The panel read that as "unavailable" and its Try again asked again at once, which
 * kept the limit on (2026-09-25). Now it is "busy": a countdown, Try again off until the wait is over, the same wait in
 * every panel, and nothing asked meanwhile. Both forms are played: the page read (as a client CORS does not bind would
 * read it), and the failed request a browser page really gets.
 */
test("GIF search: GifCities' rate limit reads as busy, and after the wait a search shows GIFs", { tag: ["@feature:chat.paired.gifs.busy"] }, async ({ peer }) => {
  const alice = await peer("alice");
  const { page } = alice;
  // The page's own clock, to skip the 30 s wait rather than sit through it.
  await page.clock.install();
  await page.getByTitle("New Chat").click();
  await expect(page.getByTestId("composer-expressions")).toBeEnabled();

  const searches: string[] = [];
  let answer: "limit page" | "blocked by CORS" | "gifs" = "limit page";
  const gifCities = (route: Route) => {
    const q = new URL(route.request().url()).searchParams.get("q")!;
    searches.push(q);
    if (answer === "blocked by CORS") return route.abort("failed");
    return route.fulfill(answer === "limit page" ? GIFCITIES_RATE_LIMIT : gifCitiesAnswer([{ gif: `http://geocities.com/${q}/boo.gif`, checksum: `${q}-boo`, url_text: `${q} boo` }]));
  };
  await alice.context.route(GIFCITIES, gifCities);

  const panel = await openExpressions(page, "gif");
  const busy = panel.getByTestId("gif-busy");
  const wait = panel.getByTestId("gif-busy-wait");
  const retry = panel.getByTestId("gif-retry");
  await expect(busy).toContainText("GIF search is busy right now.");
  await expect(panel.getByTestId("gif-trouble")).toHaveCount(0);
  await expect(wait).toHaveText("Try again in 0:30.");
  await expect(retry).toBeDisabled();
  // No GIFs from earlier in this session: the emoji are offered instead.
  await expect(panel.getByTestId("gif-emoji-instead")).toBeVisible();

  // The wait holds for every search and every panel, and none of them asks.
  await panel.getByTestId("gif-category-party").click();
  await expect(busy).toBeVisible();
  await expect(retry).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await openExpressions(page, "gif");
  await expect(busy).toBeVisible();
  await expect(retry).toBeDisabled();
  expect(searches).toEqual(["ghost"]);

  // The wait over, Try again is back; nothing asked by itself.
  answer = "gifs";
  await page.clock.fastForward(31_000);
  await expect(wait).toHaveText("You can try again now.");
  await expect(retry).toBeEnabled();
  expect(searches).toEqual(["ghost"]);
  await retry.click();
  await expect(panel.getByTitle("ghost boo")).toBeVisible();
  await expect(busy).toHaveCount(0);
  expect(searches).toEqual(["ghost", "ghost"]);

  // Told to wait again, the way a browser page is told: the request fails. A category not seen yet waits, with the
  // ghosts from before to send meanwhile.
  answer = "blocked by CORS";
  await panel.getByTestId("gif-category-animals").click();
  await expect(busy).toBeVisible();
  // A GIF came in between: the waits start over at 30 s.
  await expect(wait).toHaveText("Try again in 0:30.");
  await expect(panel.getByTestId("gif-earlier")).toHaveText("Showing earlier results.");
  await expect(panel.getByTestId("gif-grid")).toHaveAttribute("data-query", "ghost");
  await expect(panel.getByTitle("ghost boo")).toBeVisible();
  expect(searches).toEqual(["ghost", "ghost", "cat"]);
  await alice.context.unroute(GIFCITIES, gifCities);
});
