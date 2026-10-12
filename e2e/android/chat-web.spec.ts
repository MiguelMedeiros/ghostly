import { chat, say } from "../support/fixtures";
import { expect, pairWithWeb, sayFromApp, test } from "./support/android";

/**
 * The Android app and a person on the web app: the app makes the chat, the web peer joins with its invite, and
 * messages go both ways. Both sides use the test's relay; with the e2e infra's Iroh relay (GHOSTLY_IROH_RELAY_URL) the
 * live link is Iroh through it, otherwise WebRTC between the emulator and this machine.
 */

test("pairs with a web peer and messages go both ways", { tag: ["@feature:android.chat.web", "@gated"] }, async ({ app, webPeer }) => {
  const web = await webPeer("web");
  const started = Date.now();
  await pairWithWeb(app, web);
  const link = await app.page.getByTestId("connection-options").filter({ visible: true }).first().getAttribute("aria-label");
  test.info().annotations.push({ type: "link", description: `${link} after ${Date.now() - started} ms` });

  await sayFromApp(app, "hello from android");
  await expect(chat(web).getByText("hello from android")).toBeVisible();
  await say(web, "hello from the web");
  await expect(chat(app.peer).getByText("hello from the web")).toBeVisible();
  // Delivered (two ticks) on the app's side: the web peer's receipt came back.
  const mine = chat(app.peer).locator("[data-message-row]").filter({ hasText: "hello from android" }).last();
  await expect(mine.getByTestId("message-delivery")).toHaveAttribute("data-delivery", "delivered", { timeout: 30_000 });
});
