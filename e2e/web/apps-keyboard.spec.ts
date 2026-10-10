import { expect, test } from "../support/fixtures";
import { STORE_URL, serveStore, testStore } from "../support/appStore";

/*
 * The Apps page by keyboard (WISP 1200 § Stores), on the e2e suite's build (VITE_APPS_TEST): a button disabled while its
 * work runs lost the focus to the page, so the next Tab started again at the top.
 */

test("a store's Refresh and Uninstall's Export keep the keyboard focus once their work is done", { tag: ["@feature:apps.page"] }, async ({ peer }) => {
  const store = await testStore();
  const ana = await peer("ana");
  await serveStore(ana.context, store);
  await ana.page.goto("/#/apps");
  await ana.page.getByTestId("apps-add").click();
  await ana.page.getByTestId("apps-add-url").fill(STORE_URL);
  await ana.page.getByTestId("apps-add-check").click();
  await ana.page.getByTestId("apps-add-store-confirm").click();
  const listed = ana.page.getByTestId("app-store").filter({ hasText: store.storeName });

  const refresh = listed.getByTestId("app-store-refresh");
  await refresh.focus();
  await ana.page.keyboard.press("Enter");
  await expect(refresh).toBeEnabled();
  await expect(refresh).toBeFocused();

  await listed.getByRole("button", { name: new RegExp(store.storeName) }).click();
  await listed.getByTestId("app-listing-install").click();
  await ana.page.getByTestId("app-install-confirm").click();
  await ana.page.getByTestId("installed-app").getByRole("button", { name: `${store.title}: details` }).click();
  await ana.page.getByTestId("app-uninstall-open").click();
  const exportButton = ana.page.getByTestId("app-export");
  await exportButton.focus();
  // The app kept nothing, so nothing is saved: the export is asked and answered, the button disabled meanwhile.
  await ana.page.keyboard.press("Enter");
  await expect(exportButton).toBeEnabled();
  await expect(exportButton).toBeFocused();
});
