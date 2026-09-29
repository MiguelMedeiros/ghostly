import {test,expect} from "../support/fixtures";
test("project links open outside the app without leaving Home", { tag: ["@feature:app.project-links"] }, async ({peer}) => {
  const {page} = await peer("home-project-links");
  const home = page.url();
  await page.context().route("https://github.com/**",route=>route.fulfill({body:"Project destination"}));
  for (const name of ["GitHub",/Version /]) {
    const link=page.getByRole("link",{name,exact:typeof name==="string"});
    const expected=await link.getAttribute("href");
    const popupPromise=page.waitForEvent("popup");
    await link.click();
    const popup=await popupPromise;
    await expect(popup).toHaveURL(expected!);
    await expect(page).toHaveURL(home);
    await popup.close();
  }
});
