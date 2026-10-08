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
  // Only the Desktop host (apps/ui/src/desktop/host.ts) describes Pkarr this way: Rust reaches the DHT itself.
  await page.evaluate(() => { location.hash = "#/settings/network"; });
  await expect(page.getByTestId("network-protocol")).toContainText("Direct UDP");
  // The relay the fixture saved is the one the engine holds now.
  await expect(page.getByTestId("network-relays")).toHaveValue(/^http:\/\/127\.0\.0\.1:\d+$/);
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
