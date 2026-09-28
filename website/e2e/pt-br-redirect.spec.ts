import { expect, test } from "@playwright/test";

/**
 * The site is English only. The Brazilian Portuguese pages it used to have under
 * /pt-br redirect for good to their English pages, so links out there still land.
 */
for (const [from, to] of [
  ["/pt-br", "/"],
  ["/pt-br/developers", "/developers"],
  ["/pt-br/developers/catalog", "/developers/wisps"],
  ["/pt-br/developers/wisps/100-transports", "/developers/wisps/100-transports"],
  ["/pt-br/roadmap", "/roadmap"],
]) {
  test(`${from} redirects permanently to ${to}`, async ({ request }) => {
    const res = await request.get(from, { maxRedirects: 0 });
    expect([301, 308]).toContain(res.status());
    expect(new URL(res.headers()["location"], "http://x").pathname).toBe(to);
  });
}
