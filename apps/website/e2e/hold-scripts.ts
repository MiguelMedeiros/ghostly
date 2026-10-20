import type { Page } from "@playwright/test";

/** Holds the page's scripts until the returned function is called, so a reader can scroll before the page hydrates. */
export async function holdScripts(page: Page) {
  let release = () => {};
  const scripts = new Promise<void>((r) => (release = r));
  await page.route(/\/_next\/static\/chunks\/.*\.js$/, async (route) => {
    await scripts;
    await route.continue();
  });
  // The head's layout flags run before the first paint (inline). Where the build still queues them for Next's
  // runtime, inline them here, so the only change left at hydration is the chapters' shape.
  await page.route(
    (url) => url.pathname === "/",
    async (route) => {
      const res = await route.fetch();
      let html = await res.text();
      const queued = html.match(/\(self\.__next_s=self\.__next_s\|\|\[\]\)\.push\(\[0,\{"children":"(var d=document\.documentElement;.*?)","id":"js-flag"\}\]\)/);
      if (queued) html = html.replace("<head>", `<head><script>${JSON.parse(`"${queued[1]}"`)}</script>`);
      await route.fulfill({ response: res, body: html });
    },
  );
  return () => release();
}
