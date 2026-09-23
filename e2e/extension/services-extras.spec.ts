import { startAtlas } from "../../extension/test/atlas.mjs";
import { expect, test } from "../support/extension";
import { pair } from "../support/paired";

/**
 * What the contact sees of a shared app beyond the chat strip: the Services
 * page's "From your contacts" opens it, and removing the app on the sharing
 * side takes it away from both places.
 */
test("the contact opens a shared app from Services, and it is gone once removed", async ({ extensionPeer }) => {
  test.setTimeout(8 * 60_000);
  const atlas = await startAtlas();
  try {
    const [a, b] = await Promise.all([extensionPeer("extras-a"), extensionPeer("extras-b")]);
    await pair(a, b);

    await a.page.getByTestId("account-services").click();
    await a.page.getByTestId("add-service").click();
    await a.page.getByTestId("service-name").fill("Atlas");
    await a.page.getByTestId("service-target").fill(`localhost:${atlas.port}`);
    await a.page.getByTestId("service-save").click();
    const item = a.page.getByTestId("service-item").filter({ hasText: "Atlas" });
    await item.getByTestId("service-people").click();
    const grant = item.getByTestId("service-grant").getByRole("switch");
    await grant.click();
    await expect(grant).toHaveAttribute("aria-checked", "true");
    await expect(item).toContainText("Shared with 1 contact");

    // The contact finds it on its own Services page, under the contact who shares it.
    await expect(b.page.getByTestId("open-service").filter({ hasText: "Atlas" })).toBeVisible({ timeout: 120_000 });
    await b.page.getByTestId("account-services").click();
    const fromContacts = b.page.getByTestId("contact-services");
    const open = fromContacts.getByTestId("contact-service-open").filter({ hasText: "Open Atlas" });
    await expect(open).toBeVisible();
    await expect(fromContacts.getByText("Apps your contacts share show up here.")).toHaveCount(0);
    // Nothing of B's own: B shares nothing.
    await expect(b.page.getByTestId("service-item")).toHaveCount(0);

    const viewerPromise = b.context.waitForEvent("page");
    await open.click();
    const viewer = await viewerPromise;
    await viewer.waitForSelector("body[data-ready='1']", { timeout: 150_000 });
    expect(new URL(viewer.url()).hostname.endsWith(".invalid"), "a virtual origin").toBe(true);
    const out = JSON.parse((await viewer.locator("#out").textContent())!);
    expect(out.inline, "the app ran").toBe(true);
    // Opened from the extension: no "needs the extension" error on the page.
    await expect(fromContacts.getByText(/needs the Ghostly browser extension/)).toHaveCount(0);

    // Removed on A: it leaves A's page, and the contact's Services page and chat forget it.
    await a.page.getByRole("button", { name: "Remove Atlas" }).click();
    await expect(a.page.getByTestId("service-item")).toHaveCount(0);
    await expect(a.page.getByTestId("your-apps")).toContainText("Nothing shared yet.");
    await expect(open).toHaveCount(0, { timeout: 60_000 });
    await expect(fromContacts).toContainText("Apps your contacts share show up here.");
    await b.page.goBack();
    await expect(b.page.getByPlaceholder("Message…")).toBeVisible();
    await expect(b.page.getByTestId("open-service")).toHaveCount(0);
    // And the page B still had open is refused, not served.
    await viewer.reload();
    await expect(viewer.getByText("This peer does not share that service")).toBeVisible();
  } finally {
    atlas.server.close();
  }
});
