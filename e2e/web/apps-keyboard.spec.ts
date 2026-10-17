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

  // While it runs, and after it fails: the busy button keeps the focus (a disabled one dropped it to the page, as
  // Open in a chat's + → Apps did while an app started).
  let answer!: () => void;
  const held = new Promise<void>((resolve) => { answer = resolve; });
  let asked = 0;
  await ana.context.route(/ghostly-store\.json/, async (route) => { asked++; await held; await route.fulfill({ status: 500, headers: { "access-control-allow-origin": "*" }, body: "" }); });
  await ana.page.keyboard.press("Enter");
  await expect.poll(() => asked).toBe(1);
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  // The browser moves the focus off a disabled button at its next frame: wait for one before reading it.
  await ana.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await refresh.evaluate((el) => el === document.activeElement)).toBe(true);
  answer();
  await expect(refresh).not.toHaveAttribute("aria-busy");
  await expect(refresh).toBeFocused();
  await ana.context.unroute(/ghostly-store\.json/);

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
