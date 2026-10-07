import { expect, test } from "../support/fixtures";
import { APP_URL, serveStore, testStore } from "../support/appStore";

/*
 * Installing an app in a browser that keeps no app files (WISP 1200 § Where installed apps live): Safari's Private
 * Browsing refuses a Blob in IndexedDB and has no origin-private file system, so the bundle cannot be stored. WebKit's
 * in-memory contexts (a Playwright context with no profile on disk) do the same. The install screen says so in words,
 * with the story behind its ⓘ, never the browser's "Error preparing Blob/File data to be stored in object store".
 */

test("in a browser that keeps no app files, installing says to try a normal window", { tag: ["@feature:apps.page"] }, async ({ peer, browserName }) => {
  test.skip(browserName !== "webkit", "WebKit's in-memory contexts keep no Blob in IndexedDB, as Safari's Private Browsing");
  const store = await testStore();
  // Not persistent: the context lives in memory, as a private window.
  const ana = await peer("ana");
  await serveStore(ana.context, store);
  await ana.page.goto("/#/apps");
  await ana.page.getByTestId("apps-add").click();
  await ana.page.getByTestId("apps-add-url").fill(APP_URL);
  await ana.page.getByTestId("apps-add-check").click();
  const screen = ana.page.getByTestId("app-install");
  await screen.getByTestId("app-install-confirm").click();

  const error = screen.getByTestId("app-install-error");
  await expect(error).toHaveText("This browser can't keep apps here (private browsing?). Try a normal window.");
  await screen.getByTestId("app-install-error-info").click();
  await expect(screen.getByTestId("app-install-error-text")).toContainText("Open Ghostly in a normal window and install the app there.");
  await expect(error).not.toContainText(/Blob|IndexedDB|object store/);

  // Nothing was installed.
  await screen.getByRole("button", { name: "Cancel" }).click();
  await expect(ana.page.getByTestId("installed-app")).toHaveCount(0);
});
