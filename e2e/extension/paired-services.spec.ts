import { BIG_SHA256, startAtlas } from "../../extension/test/atlas.mjs";
import { expect, test } from "../support/extension";
import { pair } from "../support/paired";

/**
 * A paired chat, the kind every new chat is: an app is added on the Services page, granted to one
 * contact from the chat, and opened by that contact through the authenticated paired session.
 */
test("a local web app shared in a paired chat, from the chat itself", { tag: ["@feature:services.add", "@feature:services.share", "@feature:services.open", "@feature:services.stop", "@feature:services.http"] }, async ({ extensionPeer }) => {
  test.setTimeout(8 * 60_000);
  const atlas = await startAtlas();
  try {
    const [a, b] = await Promise.all([extensionPeer("paired-svc-a"), extensionPeer("paired-svc-b")]);
    await pair(a, b);

    await a.page.getByTestId("account-services").click();
    await a.page.getByTestId("add-service").click();
    await a.page.getByTestId("service-name").fill("Atlas");
    await a.page.getByTestId("service-target").fill(`localhost:${atlas.port}`);
    await a.page.getByTestId("service-save").click();
    await expect(a.page.getByTestId("service-item")).toContainText("Not shared with anyone yet");
    await a.page.goBack();

    // Granted per chat, from the chat's own menu.
    await a.page.getByTestId("chat-options").click();
    await a.page.getByTestId("chat-services-open").click();
    const toggle = a.page.getByTestId("chat-services").getByTestId("chat-service-toggle");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await a.page.getByRole("button", { name: "Done" }).click();
    await expect(a.page.getByTestId("grant-services")).toContainText("You share 1 app");

    // The contact sees it in the chat and opens it over the paired session.
    const open = b.page.getByTestId("open-service").filter({ hasText: "Atlas" });
    await expect(open).toBeVisible({ timeout: 120_000 });
    const viewerPromise = b.context.waitForEvent("page");
    await open.click();
    const viewer = await viewerPromise;
    await viewer.waitForSelector("body[data-ready='1']", { timeout: 150_000 });
    const out = JSON.parse((await viewer.locator("#out").textContent())!);
    expect(out.echo, "POST with JSON body, query and custom header").toEqual({ body: { hello: "ghost" }, query: "?x=1", header: "yes" });
    expect(out.bigSha, "3 MiB binary download intact").toBe(BIG_SHA256);
    expect(atlas.requests.some((r: { path: string }) => r.path === "/lib/hash.js"), "requests reached A's localhost").toBe(true);

    // Withdrawn in the chat: gone for the contact.
    await a.page.getByTestId("grant-services").click();
    await a.page.getByTestId("chat-services").getByTestId("chat-service-toggle").click();
    await a.page.getByRole("button", { name: "Done" }).click();
    await expect(open).toHaveCount(0, { timeout: 60_000 });
  } finally {
    await atlas.close?.();
  }
});
