// "Made here. Open there.": Boo runs a photo gallery on their computer and lets Casper open it, from
// the chat. Sharing needs the desktop app or the browser extension at both ends, so both run Ghostly
// Browser (the built extension). The phone shot is the web app on a phone, where the same dialog
// says what sharing needs: phones do not share apps.
import { test, expect } from "@playwright/test";
import { LocalRelay } from "../../../e2e/support/relay";
import { join } from "node:path";
import { CAST, OUT, converse, dress, openExtension, pair, person, shot, type Peer } from "./helpers";
import { startGallery } from "./gallery";

/** Where the gallery listens: CAPTURE_APP_PORT, in the capture's port range. */
const PORT = Number(process.env.CAPTURE_APP_PORT) || 4391;

async function grant(p: Peer) {
  await p.page.getByTitle("Options").click();
  await p.page.getByTestId("chat-services-open").click();
  await expect(p.page.getByTestId("chat-services")).toBeVisible();
}

test("desktop: an app shared in the chat, and opened by the contact", async () => {
  test.setTimeout(12 * 60_000);
  const relay = new LocalRelay();
  const gallery = await startGallery(PORT);
  const [boo, casper] = await Promise.all([openExtension(relay, "Boo"), openExtension(relay, "Casper")]);
  try {
    await dress(boo, CAST.boo);
    await dress(casper, CAST.casper);
    await pair(casper, boo);
    await converse([
      [casper, "can I see the photos from saturday?"],
      [boo, "better: open my gallery, it runs on my laptop"],
    ], [boo, casper]);

    // Boo adds the app once on the Services page, then lets Casper open it, from this chat.
    await boo.page.getByTestId("account-services").click();
    await boo.page.getByTestId("add-service").click();
    await boo.page.getByTestId("service-name").fill("Lake photos");
    await boo.page.getByTestId("service-target").fill(`localhost:${gallery.port}`);
    await boo.page.getByTestId("service-save").click();
    await expect(boo.page.getByTestId("service-item")).toContainText("Not shared with anyone yet");
    await boo.page.goBack();
    await grant(boo);
    const toggle = boo.page.getByTestId("chat-services").getByTestId("chat-service-toggle");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await boo.page.waitForTimeout(600);
    await shot(boo, "services-chat.png");
    await boo.page.getByRole("button", { name: "Done" }).click();

    // Casper sees it in the chat and opens it over the paired session.
    const open = casper.page.getByTestId("open-service").filter({ hasText: "Lake photos" });
    await expect(open).toBeVisible({ timeout: 120_000 });
    await shot(casper, "x-services-casper.png");
    const viewerPromise = casper.context.waitForEvent("page");
    await open.click();
    const viewer = await viewerPromise;
    await viewer.setViewportSize({ width: 1280, height: 820 });
    await viewer.waitForSelector("body[data-ready='1']", { timeout: 150_000 });
    await viewer.waitForTimeout(800);
    await viewer.screenshot({ path: join(OUT, "x-services-viewer.png") });
    await converse([[casper, "the canoe one 😍 can I keep a copy?"]], [boo, casper]);
  } finally {
    for (const p of [boo, casper]) { await p.context.close().catch(() => {}); p.dispose(); }
    await gallery.close();
    relay.close();
  }
});

test("phone: what sharing needs, on a phone", async ({ browser, baseURL }) => {
  const relay = new LocalRelay();
  const [boo, casper] = await Promise.all([person(browser, relay, baseURL!, CAST.boo, { mobile: true }), person(browser, relay, baseURL!, CAST.casper)]);
  await pair(casper, boo);
  await converse([[casper, "can I see the photos from saturday?"], [boo, "open my gallery from your laptop, I'll share it there"]], [boo, casper]);
  await grant(boo);
  await boo.page.waitForTimeout(600);
  await shot(boo, "services-mobile.png");
  relay.close();
});
