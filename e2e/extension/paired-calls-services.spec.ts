import { startAtlas } from "../../extension/test/atlas.mjs";
import { composerRow } from "../support/composer";
import { expect, test } from "../support/extension";
import { chat } from "../support/fixtures";
import { pair } from "../support/paired";

const clock = /^\d{1,2}:\d{2}$/;

/**
 * Everything the old chat did, in the one chat: two extension peers in a new (paired) chat, where one
 * reaches a local web app the other shares (`services/1`), and they call each other (`calls/1`), both over
 * the live paired session.
 */
test("a new chat shares an app and calls, both over its live session", { tag: ["@feature:calls.paired", "@feature:calls.paired.negotiate", "@feature:services.paired.negotiate", "@feature:services.open", "@feature:extension.interop"] }, async ({ extensionPeer }, testInfo) => {
  test.setTimeout(8 * 60_000);
  const atlas = await startAtlas();
  try {
    const [a, b] = await Promise.all([extensionPeer("pcs-a"), extensionPeer("pcs-b")]);
    await pair(a, b);

    await a.page.getByTestId("account-services").click();
    await a.page.getByTestId("add-service").click();
    await a.page.getByTestId("service-name").fill("Atlas");
    await a.page.getByTestId("service-target").fill(`localhost:${atlas.port}`);
    await a.page.getByTestId("service-save").click();
    await a.page.goBack();
    // Both apps offer services/1 and the chat is live: nothing to explain.
    const row = await composerRow(a.page, "composer-services");
    await expect(row).toBeEnabled();
    await expect(row).not.toHaveAttribute("title");
    await row.click();
    await expect(a.page.getByTestId("chat-services")).toBeVisible();
    await expect(a.page.getByTestId("chat-services-unavailable")).toHaveCount(0);
    await a.page.getByTestId("chat-services").getByTestId("chat-service-toggle").click();
    await a.page.getByRole("button", { name: "Done" }).click();

    const open = b.page.getByTestId("open-service").filter({ hasText: "Atlas" });
    await expect(open).toBeVisible({ timeout: 120_000 });
    const viewerPromise = b.context.waitForEvent("page");
    await open.click();
    const viewer = await viewerPromise;
    await viewer.waitForSelector("body[data-ready='1']", { timeout: 150_000 });
    expect(atlas.requests.some((r: { path: string }) => r.path === "/lib/hash.js"), "requests reached A's localhost").toBe(true);
    await viewer.close();

    // The same chat calls: B rings A, A answers, the media flows, B hangs up.
    await expect(b.page.getByTestId("call-audio")).toBeEnabled();
    await b.page.getByTestId("call-audio").click();
    await expect(a.page.getByText("Incoming audio call...")).toBeVisible();
    await a.page.getByTitle("Accept audio call").click();
    for (const p of [a, b]) await expect(p.page.getByText(clock).first()).toBeVisible();
    await b.page.screenshot({ path: testInfo.outputPath("extension-call.png") });
    await b.page.getByTitle("End call").click();
    await expect(a.page.getByTitle("End call")).toHaveCount(0);
    for (const p of [a, b]) await expect(chat(p).getByText("Audio call ended")).toBeVisible();
  } finally {
    await atlas.close?.();
  }
});

test("with a web contact the chat calls, and says why apps cannot travel", { tag: ["@feature:calls.paired", "@feature:services.paired.negotiate"] }, async ({ extensionPeer, webPeer }, testInfo) => {
  const [ext, web] = await Promise.all([extensionPeer("pcs-ext"), webPeer("pcs-web")]);
  await pair(ext, web);
  await expect(ext.page.getByTestId("call-video")).toBeEnabled();
  // The web app can neither serve nor open local apps, so it does not offer services/1: nothing to choose in the
  // chat's apps, and the + row says why.
  const row = await composerRow(ext.page, "composer-services");
  await expect(row).toBeDisabled();
  await expect(row).toHaveAttribute("title", /cannot open or share apps/);
  // After the menu's fade-in, so the picture shows it and not half of it.
  await ext.page.waitForTimeout(700);
  await ext.page.screenshot({ path: testInfo.outputPath("services-web-contact.png") });
  await ext.page.keyboard.press("Escape");
  await expect(ext.page.getByTestId("composer-menu")).toHaveCount(0);

  await web.page.getByTestId("call-video").click();
  await expect(ext.page.getByText("Incoming video call...")).toBeVisible();
  await ext.page.getByTitle("Accept video call").click();
  for (const p of [ext, web]) await expect(p.page.getByText(clock).first()).toBeVisible();
  await ext.page.getByTitle("End call").click();
  await expect(web.page.getByTitle("End call")).toHaveCount(0);
});
