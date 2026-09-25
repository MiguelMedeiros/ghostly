import { test, expect, choose } from "../support/desktop";

/**
 * One test, and it is the one that was missing: Ghostly Desktop opens, and the
 * peer inside it is the one Rust backs.
 *
 * Desktop builds the same UI as the browser clients, and `ghostlyPlatformModules()`
 * quietly swaps modules under it — so a Desktop-only implementation can be
 * replaced by a browser stand-in and nobody notices. Everything asserted here
 * can only be true when the Desktop wiring survived that swap.
 */
test("Desktop opens, with the peer Rust backs behind it", { tag: ["@feature:desktop.boot"] }, async ({ app }) => {
  // The window is there before the page is: everything here is waited for.
  await expect.poll(() => app.title()).toContain("Ghostly");

  // The UI rendered inside the real shell: the bundle, the asset protocol and the CSP all hold.
  await expect.poll(() => app.text("h2")).toBe("Ghostly");
  await expect.poll(() => app.text('[title="New Chat"]')).not.toBeNull();

  await app.click('[title="Settings"]');

  // Only `src/desktop/host.ts` describes Pkarr this way. The browser stand-in
  // would say "Pkarr relays (HTTP) → Mainline DHT (BEP44)": Rust is reaching
  // the DHT itself, which is the whole reason Desktop exists.
  await expect.poll(() => app.text('[data-testid="network-protocol"]')).toBe("Mainline DHT (BEP44) — Direct UDP");

  // And the host is installed, not only its transport: sharing a local web app
  // is offered, which no web page is allowed to do.
  await app.click('[data-testid="account-services"]');
  await expect.poll(() => app.text('[data-testid="add-service"]')).toContain("Share a local service");
});

test("the webview's <html lang> and <html dir> follow the language", { tag: ["@feature:app.i18n"] }, async ({ app }) => {
  await expect.poll(() => app.text('[title="New Chat"]')).not.toBeNull();
  await expect.poll(() => app.attribute("html", "lang")).toBe("en");
  await expect.poll(() => app.attribute("html", "dir")).toBe("ltr");

  await app.click('[title="Settings"]');
  await choose(app, "settings-language", "ar");
  await expect.poll(() => app.attribute("html", "lang")).toBe("ar");
  await expect.poll(() => app.attribute("html", "dir")).toBe("rtl");

  // The profile outlives the test: leave it in English for the next one.
  await choose(app, "settings-language", "en");
  await expect.poll(() => app.attribute("html", "lang")).toBe("en");
  await expect.poll(() => app.attribute("html", "dir")).toBe("ltr");
});
