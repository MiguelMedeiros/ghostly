import { expect, test } from "@playwright/test";

/**
 * Cloudflare reaches the site through the tunnel whatever the visitor used, and says which it was in CF-Visitor. A
 * visit over plain http:// lands on the same address over https:// in one hop, path and query kept; one over https://,
 * or one straight to the server that says nothing (this test's own), gets the page.
 */
const HTTP = { "cf-visitor": '{"scheme":"http"}', "x-forwarded-proto": "http" };
const HTTPS = { "cf-visitor": '{"scheme":"https"}', "x-forwarded-proto": "https" };

test("a visit over http:// redirects permanently to https://, path and query kept", async ({ request }) => {
  for (const path of ["/", "/cli", "/wisps/100-transports?a=1&b=two", "/wisps/no-such", "/pt-br/roadmap"]) {
    const res = await request.get(path, { headers: { ...HTTP, host: "ghostly.tools" }, maxRedirects: 0 });
    expect([301, 308], path).toContain(res.status());
    expect(new URL(res.headers()["location"]).href, path).toBe(`https://ghostly.tools${path}`);
  }
});

for (const [name, headers] of [["over https://", HTTPS], ["straight to the server", {}]] as const) {
  test(`a visit ${name} gets the page, or the missing page`, async ({ request }) => {
    expect((await request.get("/cli", { headers, maxRedirects: 0 })).status()).toBe(200);
    expect((await request.get("/wisps/no-such", { headers, maxRedirects: 0 })).status()).toBe(404);
  });
}
