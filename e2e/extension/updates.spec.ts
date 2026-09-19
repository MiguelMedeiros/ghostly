import { expect, test, LATEST_URL } from "../support/extension";

/**
 * Chrome never updates an unpacked extension, and no API can. All Ghostly can
 * do is say that a new version is out and point at it — which it has to do,
 * because otherwise nobody would know.
 */
test("says when a new version is out, and points at the download", async ({ extensionPeer }) => {
  const { page } = await extensionPeer("alice");

  await page.route(LATEST_URL, (route) =>
    route.fulfill({
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ version: "9.9.9" }),
    }),
  );
  await page.reload();

  const banner = page.getByTestId("update-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("9.9.9");

  // No button: replacing the folder is the user's to do.
  const download = banner.getByRole("link", { name: "Download" });
  await expect(download).toHaveAttribute("href", "https://github.com/MiguelMedeiros/ghostly/releases/latest");
});
