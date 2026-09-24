import { expect, test } from "@playwright/test";

/**
 * The static page an OpenID Connect provider returns to after an identity-proof sign-in
 * (web/oidc-callback.html). It hands the answer, still in the fragment, to the Ghostly tab
 * that asked, or forwards it to the desktop app's one-shot listener on 127.0.0.1, and keeps
 * no copy in the address bar.
 */
const STATE = "A".repeat(43);

test("hands the answer to the waiting tab over a same-origin channel and clears it from the address", { tag: ["@feature:proofs.oidc.callback.web"] }, async ({ context, baseURL }) => {
  const tab = await context.newPage();
  await tab.goto(`${baseURL}/oidc-callback.html`);
  const received = tab.evaluate(() => new Promise<unknown>((resolve) => {
    const channel = new BroadcastChannel("ghostly-oidc");
    channel.onmessage = (event) => { channel.close(); resolve(event.data); };
  }));
  const popup = await context.newPage();
  await popup.goto(`${baseURL}/oidc-callback.html#id_token=header.payload.signature&state=${STATE}`);
  expect(await received).toEqual({ type: "ghostly-oidc", url: `${baseURL}/oidc-callback.html#id_token=header.payload.signature&state=${STATE}` });
  // Closed by the page itself (a window it did not open is only emptied of the token).
  if (!popup.isClosed()) await expect.poll(() => popup.url()).toBe(`${baseURL}/oidc-callback.html`);
});

test("forwards a desktop sign-in to 127.0.0.1 on the port its state names, and nowhere else", { tag: ["@feature:proofs.oidc.callback.desktop"] }, async ({ page, baseURL }) => {
  const forwarded: string[] = [];
  await page.route("http://127.0.0.1:50123/**", (route) => {
    forwarded.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "text/html", body: "<p>listener</p>" });
  });
  await page.goto(`${baseURL}/oidc-callback.html#id_token=t&state=d.50123.${STATE}`);
  await expect(page.getByText("listener")).toBeVisible();
  expect(forwarded).toEqual(["http://127.0.0.1:50123/oidc-callback"]);
  await expect.poll(() => page.url()).toBe(`http://127.0.0.1:50123/oidc-callback#id_token=t&state=d.50123.${STATE}`);

  // A state that does not name a plain port stays on this origin. (A fresh load each time:
  // changing only the fragment of the same page would not run it again.)
  await page.goto(`${baseURL}/oidc-callback.html#id_token=t&state=d.evil.example.${STATE}`);
  await expect.poll(() => page.url()).toBe(`${baseURL}/oidc-callback.html`);
  await page.goto("about:blank");
  await page.goto(`${baseURL}/oidc-callback.html#state=d.80.${STATE}`);
  await expect(page.getByText("Nothing to do here.")).toBeVisible();
});
