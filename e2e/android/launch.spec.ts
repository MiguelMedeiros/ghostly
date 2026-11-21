import { expect, inviteStage, newChat, test } from "./support/android";

/**
 * What A0 proved by hand on the emulator (docs/ANDROID.md, "What the emulator measured"), kept proven: the debug APK
 * starts with no data, its UI renders, a profile is there with no name step, the engine runs with the Desktop host
 * (Rust's Pkarr client), and New publishes an invite, here through the test's own relay over `adb reverse`.
 */

test("the app starts with no data: the UI renders, a profile with no name step, the engine on the Desktop host", { tag: ["@feature:android.app.boot", "@gated"] }, async ({ app }) => {
  const { page } = app;
  await expect(newChat(page)).toBeVisible();
  // A debug e2e start (`--ez ghostly_e2e true`) is GHOSTLY_E2E=1: no name step for the new profile.
  await expect(page.getByTestId("name-step")).toHaveCount(0);
  const env = await page.evaluate(() => ({ android: /Android/.test(navigator.userAgent), tauri: "__TAURI_INTERNALS__" in window, secure: isSecureContext }));
  expect(env).toEqual({ android: true, tauri: true, secure: true });
  // Only the Desktop host (apps/ui/src/desktop/host.ts) reaches the DHT directly: Rust reaches the DHT itself.
  await page.evaluate(() => { location.hash = "#/settings/network"; });
  await expect(page.getByTestId("network-protocol")).toHaveAttribute("data-kind", "direct");
  // The relay the fixture saved is the one the engine holds now.
  await expect(page.getByTestId("network-relays")).toHaveValue(/^http:\/\/127\.0\.0\.1:\d+$/);
});

test("a font size changed in the system's settings while the app runs is the page's text size at once", { tag: ["@feature:android.app.boot", "@gated"] }, async ({ app }) => {
  const { adb, page } = app;
  const before = adb.run("shell", "settings", "get", "system", "font_scale").trim();
  // A line of the page's own text, as wide as its letters: the WebView's text zoom is what changes it.
  const width = () => page.evaluate(() => {
    let line = document.getElementById("zz-font-line");
    if (!line) {
      line = document.createElement("span");
      line.id = "zz-font-line";
      line.textContent = "Ghostly Ghostly Ghostly";
      line.style.cssText = "position:fixed;top:0;left:0;font-size:16px;white-space:nowrap;visibility:hidden";
      document.body.append(line);
    }
    return line.getBoundingClientRect().width;
  });
  try {
    adb.run("shell", "settings", "put", "system", "font_scale", "1.0");
    await expect.poll(width).toBeGreaterThan(0);
    const normal = await width();
    adb.run("shell", "settings", "put", "system", "font_scale", "1.3");
    // The same page, never started again: its text grows as a start at that size shows it.
    await expect.poll(width, { timeout: 10_000, message: "the text grew with the system's font size" }).toBeGreaterThan(normal * 1.2);
    adb.run("shell", "settings", "put", "system", "font_scale", "1.0");
    await expect.poll(width, { timeout: 10_000, message: "and went back with it" }).toBeLessThan(normal * 1.05);
  } finally {
    adb.run("shell", "settings", "put", "system", "font_scale", before === "null" ? "1.0" : before);
  }
});

test("New publishes the invite through the relay on the host, and the card shows it", { tag: ["@feature:android.pairing.new", "@gated"] }, async ({ app, relay }) => {
  const { page } = app;
  const puts = relay.puts;
  const started = Date.now();
  await newChat(page).click();
  await expect.poll(async () => String(await inviteStage(page)), { timeout: 90_000, message: "the invite left \"publishing\"" }).not.toMatch(/^(publishing|null)$/);
  expect(await inviteStage(page)).not.toBe("failed");
  test.info().annotations.push({ type: "timing", description: `New until published: ${Date.now() - started} ms` });
  // Written to the test's relay, which the emulator reached at 127.0.0.1 through `adb reverse`.
  expect(relay.puts).toBeGreaterThan(puts);
  await expect(page.getByTestId("invite-link")).toHaveAttribute("title", /^https:\/\/ghostly\.tools\/#ghostly1/);
});
