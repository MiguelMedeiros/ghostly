import { BIG_SHA256, startAtlas } from "../../extension/test/atlas.mjs";
import { connect, linkLegacy } from "../support/fixtures";
import { expect, test } from "../support/extension";

/**
 * The milestone: a peer shares a web app running on its own machine, a
 * contact opens it over WebRTC on a virtual origin, and it is gone the moment
 * the peer stops sharing or closes Ghostly.
 */
test("a local web app, shared with a contact and opened over WebRTC", { tag: ["@feature:services.add", "@feature:services.share", "@feature:services.open", "@feature:services.stop", "@feature:services.http"] }, async ({ extensionPeer }) => {
  test.setTimeout(8 * 60_000);
  const atlas = await startAtlas();
  try {
    const [a, b] = await Promise.all([extensionPeer("chrome-a"), extensionPeer("chrome-b")]);
    await linkLegacy(a, b);
    await connect(a, b);

    // Sharing a local app lives on the Services page, beside the chat list.
    await a.page.getByTestId("account-services").click();
    await a.page.getByTestId("add-service").click();
    await a.page.getByTestId("service-name").fill("Atlas");
    await a.page.getByTestId("service-target").fill(`localhost:${atlas.port}`);
    await a.page.getByTestId("service-save").click();
    // A new service reaches nobody until a contact is granted it by name.
    await expect(a.page.getByTestId("service-item").filter({ hasText: "Not shared with anyone yet" })).toBeVisible();
    await expect(b.page.getByTestId("open-service")).toHaveCount(0);

    // Who can reach it is chosen per contact, right on the page.
    await a.page.getByTestId("service-item").getByTestId("service-people").click();
    const grant = a.page.getByTestId("service-grant").getByRole("switch");
    await expect(grant).toHaveAttribute("aria-checked", "false");
    await grant.click();
    await expect(grant).toHaveAttribute("aria-checked", "true");
    // The page counts the contacts a service reaches.
    await expect(a.page.getByTestId("service-item").filter({ hasText: "Shared with 1 contact" })).toBeVisible();

    const open = b.page.getByTestId("open-service").filter({ hasText: "Atlas" });
    await expect(open).toBeVisible({ timeout: 120_000 });
    const viewerPromise = b.context.waitForEvent("page");
    await open.click();
    const viewer = await viewerPromise;
    await viewer.waitForSelector("body[data-ready='1']", { timeout: 150_000 });
    const out = JSON.parse((await viewer.locator("#out").textContent())!);

    expect(new URL(viewer.url()).hostname.endsWith(".invalid"), "a virtual origin").toBe(true);
    expect(out.inline, "inline script ran").toBe(true);
    expect(out.secure, "secure context").toBe(true);
    expect(out.css, "stylesheet applied").toBe("rgb(1, 2, 3)");
    expect(out.echo, "POST with JSON body, query and custom header").toEqual({ body: { hello: "ghost" }, query: "?x=1", header: "yes" });
    expect(out.bigSha, "3 MiB binary download intact").toBe(BIG_SHA256);
    expect(out.missing, "404 passes through").toBe(404);
    expect(out.image, "image decoded").toBe(1);
    expect(atlas.requests.some((r: { path: string }) => r.path === "/lib/hash.js"), "requests reached A's localhost").toBe(true);
    expect(atlas.requests.every((r: { headers: Record<string, string> }) => !r.headers.cookie), "the local app never receives cookies").toBe(true);

    await viewer.locator("#next").click();
    await viewer.waitForSelector("text=Page two");
    expect(new URL(viewer.url()).pathname, "redirects stay inside the virtual origin").toBe("/page2");

    await expect(a.page.getByTestId("service-item")).toContainText(/\d+ requests/);

    // Stopped: refused. Shared again: served.
    await a.page.getByTestId("service-sharing").click();
    await viewer.goto(viewer.url().replace("/page2", "/"));
    await viewer.waitForSelector("text=This peer does not share that service");
    await a.page.getByTestId("service-sharing").click();
    await viewer.reload();
    await viewer.waitForSelector("body[data-ready='1']");

    // Offline: nothing shared stays reachable.
    await a.page.getByTestId("online-toggle").click();
    await expect(a.page.getByTestId("online-toggle")).toHaveText("Offline");
    await expect(a.page.getByTestId("service-item")).toContainText("Not reachable while offline");
    await a.page.getByTestId("online-toggle").click();
    await expect(a.page.getByTestId("online-toggle")).toHaveText("Online");

    // A closes Ghostly: Atlas is gone.
    await a.context.close();
    await viewer.reload({ timeout: 200_000 });
    await viewer.waitForSelector("text=This service is not reachable", { timeout: 200_000 });
  } finally {
    atlas.server.close();
  }
});
