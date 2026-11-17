import { expect, test } from "@playwright/test";

/**
 * A WISP's article has nothing to hydrate. Drawn as a server component tree, every element of it went into the page's
 * flight data (the `self.__next_f.push` scripts) as JSON the browser parses and React walks: on
 * /wisps/1200-marketplace 456 KB of a 501 KB payload, and half a second of a 4x-throttled main thread. It goes in as
 * the article's HTML, one string.
 */
function flightData(html: string) {
  return [...html.matchAll(/<script[^>]*>self\.__next_f\.push\((.*?)\)<\/script>/gs)]
    .map((m) => JSON.parse(m[1]) as [number, string?])
    .filter(([kind]) => kind === 1)
    .map(([, text]) => text)
    .join("");
}

test("a WISP page sends its article as one HTML string, not again as an element tree in its flight data", async ({ page, request }) => {
  const path = "/wisps/1200-marketplace";
  const flight = flightData(await (await request.get(path)).text());
  expect(flight.length).toBeGreaterThan(0);
  // An element in flight data reads ["$","td",null,{…}] or ["$","td","td-0",{…}].
  const elements = (tag: string) => flight.split(`["$","${tag}",`).length - 1;
  expect({ table: elements("table"), td: elements("td") }).toEqual({ table: 0, td: 0 });

  await page.goto(path);
  const article = await page.locator(".reader-prose").evaluate((el) => el.innerHTML.length);
  expect(await page.locator(".reader-prose table").count()).toBeGreaterThan(20);
  // The article is most of the page's data; what is left of it is the page around the article.
  expect(article).toBeGreaterThan(100_000);
  expect(flight.length - article).toBeLessThan(80_000);
});
