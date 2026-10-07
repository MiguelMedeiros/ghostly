import { chat, connect, expect, link, say, test } from "../support/fixtures";

test("on a phone: tabs for chats, wallet, sharing and settings, and Profile through Settings", { tag: ["@feature:app.mobile-layout"] }, async ({ peer }) => {
  const { page } = await peer("alice", { mobile: true });
  const tabs = page.getByTestId("mobile-tabs");
  await expect(tabs).toBeVisible();
  await expect(tabs.getByRole("button", { name: "Chats" })).toHaveAttribute("aria-current", "page");

  await tabs.getByRole("button", { name: "Wallets" }).click();
  await expect(page).toHaveURL(/#\/wallet$/);
  await expect(page.getByRole("heading", { name: "Wallets", exact: true })).toBeVisible();
  await expect(page.getByTestId("wallet")).toBeVisible();

  // Apps has Services' tab in the suite's build (WISP 1200; five tabs is what a phone holds).
  await tabs.getByRole("button", { name: "Apps" }).click();
  await expect(page.getByTestId("apps-page")).toBeVisible();

  await tabs.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  // No account bar and no Profile tab: Settings' Profile section leads there, showing the active profile.
  await expect(page.getByTestId("account-bar")).toHaveCount(0);
  const profileLink = page.getByTestId("settings-profile-link");
  await expect(profileLink).toContainText("Name, picture, backups and other profiles");
  await profileLink.click();
  await expect(page).toHaveURL(/#\/profile$/);
  await expect(page.getByTestId("profile-page")).toBeVisible();
  await page.getByTestId("profile-name").fill("Pocket");
  await page.getByTestId("profile-name").press("Enter");
  await tabs.getByRole("button", { name: "Settings" }).click();
  await expect(profileLink).toContainText("Pocket");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await tabs.getByRole("button", { name: "Chats" }).click();
  await expect(page.getByPlaceholder("Search chats...")).toBeVisible();
  // Nothing sticks out sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("on a phone: a chat is a screen of its own", { tag: ["@feature:app.mobile-layout", "@feature:chat.paired.send"] }, async ({ peer }) => {
  const [alice, bob] = await Promise.all([peer("alice", { mobile: true }), peer("bob")]);
  await link(alice, bob);
  await connect(alice, bob);
  await expect(alice.page.getByTestId("mobile-tabs")).toHaveCount(0);

  // WhatsApp's composer: [+] [emoji/GIF] [message] [mic]; what the + holds opens as a sheet from the bottom.
  await expect(alice.page.getByTestId("composer-expressions")).toBeVisible();
  const input = (await alice.page.getByPlaceholder("Message…").boundingBox())!;
  expect(input.width).toBeGreaterThan(200);
  await alice.page.getByTestId("composer-more").click();
  const menu = alice.page.getByTestId("composer-menu");
  await expect(menu).toHaveAttribute("data-menu", "sheet");
  await expect(menu.getByTestId("composer-file")).toBeVisible();
  await expect(menu.getByTestId("composer-media")).toBeVisible();
  await alice.page.getByTestId("menu-backdrop").click({ position: { x: 10, y: 10 } });
  await expect(menu).toHaveCount(0);

  await say(bob, "boo on the small screen");
  await expect(chat(alice).getByText("boo on the small screen")).toBeVisible();

  await alice.page.getByTestId("chat-back").click();
  await expect(alice.page.getByTestId("mobile-tabs")).toBeVisible();
  await expect(alice.page.getByText("boo on the small screen")).toBeVisible();
});

test("on a phone: the tab bar goes behind the keyboard while typing, and comes back", { tag: ["@feature:app.mobile-layout"] }, async ({ peer }) => {
  // Playwright has no keyboard to open: the viewport loses an iPhone keyboard's height while a field has the focus.
  const phone = { width: 390, height: 844 }, keyboard = 336;
  const { page } = await peer("alice", { mobile: true, viewport: phone });
  const tabs = page.getByTestId("mobile-tabs");
  const search = page.getByPlaceholder("Search chats...");
  await search.focus();
  await page.setViewportSize({ width: phone.width, height: phone.height - keyboard });
  await expect(page.locator("html")).toHaveAttribute("data-keyboard", "true");
  await expect(tabs).toBeHidden();
  await expect(search).toBeInViewport();

  // The same on a settings field.
  await search.blur();
  await page.setViewportSize(phone);
  await expect(tabs).toBeVisible();
  await tabs.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("settings-open-profile").click();
  const nickname = page.getByPlaceholder("Enter your nickname...");
  await nickname.focus();
  await page.setViewportSize({ width: phone.width, height: phone.height - keyboard });
  await expect(tabs).toBeHidden();
  await expect(nickname).toBeInViewport();

  // Keyboard down: back at the bottom of the screen.
  await nickname.blur();
  await page.setViewportSize(phone);
  await expect(tabs).toBeVisible();
  const bar = (await tabs.boundingBox())!;
  expect(bar.y + bar.height).toBe(phone.height);
});

test("on a 320px phone every tab's name fits whole, in every language", { tag: ["@feature:app.mobile-layout", "@feature:app.i18n"] }, async ({ peer }) => {
  // 64px a tab: "Configurações", "Identidades", "Portefeuilles" and "Impostazioni" ended in "…".
  const { page } = await peer("narrow-tabs", { mobile: true, viewport: { width: 320, height: 568 } });
  const cut: string[] = [];
  for (const language of ["en", "pt", "es", "fr", "it", "ar", "ja", "zh"]) {
    await page.evaluate((language) => {
      const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
      localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
    }, language);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", new RegExp(`^${language}`));
    const names = page.getByTestId("mobile-tabs").locator("button > span:last-child");
    await expect(names).toHaveCount(5);
    for (const name of await names.all()) {
      const { text, over } = await name.evaluate((element) => ({ text: element.textContent, over: element.scrollWidth - element.clientWidth }));
      if (over > 0) cut.push(`${language}: ${text}`);
    }
  }
  expect(cut).toEqual([]);
});

test("on a phone New and Join stay on the screen beside the logo, in every language", { tag: ["@feature:app.mobile-layout", "@feature:app.i18n"] }, async ({ peer }) => {
  // French at 375px: "Nouveau" and "Rejoindre" ran 5px off the screen, and against the logo; Spanish and Italian at 360px.
  const { page } = await peer("header-words", { mobile: true, viewport: { width: 375, height: 812 } });
  const bad: string[] = [];
  for (const language of ["en", "pt", "es", "fr", "it", "ar", "ja", "zh"]) {
    await page.evaluate((language) => {
      const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
      localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
    }, language);
    for (const width of [360, 375, 390, 430]) {
      await page.setViewportSize({ width, height: 812 });
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("lang", new RegExp(`^${language}`));
      await expect(page.getByTestId("sidebar-chat-actions")).toBeVisible();
      const { logo, actions } = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        const { left, right } = box("[data-testid=app-brand]"), at = box("[data-testid=sidebar-chat-actions]");
        return { logo: { left, right }, actions: { left: at.left, right: at.right } };
      });
      // The 16px padding on either side, and 8px at least between the logo and the buttons, whichever side each is on.
      const [first, second] = logo.left < actions.left ? [logo, actions] : [actions, logo];
      if (first.left < 16 - 1 || second.right > width - 16 + 1 || second.left - first.right < 8 - 1) bad.push(`${language} ${width}px: logo ${Math.round(logo.left)}..${Math.round(logo.right)}, buttons ${Math.round(actions.left)}..${Math.round(actions.right)}`);
    }
  }
  expect(bad).toEqual([]);
  // Where the words fit, they are there: English on a 390px phone.
  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language: "en" }));
  });
  await page.setViewportSize({ width: 390, height: 812 });
  await page.reload();
  await expect(page.getByTestId("sidebar-chat-actions")).toContainText("New");
  await expect(page.getByTestId("sidebar-chat-actions")).toContainText("Join");
});

test("on a wide screen the wallet and services are pages beside the list", { tag: ["@feature:app.navigation", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await expect(page.getByTestId("mobile-tabs")).toHaveCount(0);
  await page.getByTestId("wallet-chip").click();
  await expect(page).toHaveURL(/#\/wallet$/);
  await expect(page.getByRole("heading", { name: "Wallets", exact: true })).toBeVisible();
  // Apps is a place of its own beside Services on a wide screen (on in the suite's build, WISP 1200).
  await page.getByTestId("account-apps").click();
  await expect(page).toHaveURL(/#\/apps$/);
  await expect(page.getByRole("heading", { name: "Apps", exact: true })).toBeVisible();
  await page.getByTestId("account-services").click();
  await expect(page).toHaveURL(/#\/services$/);
  await expect(page.getByRole("heading", { name: "Services" })).toBeVisible();
  // The old phone route still lands on the page.
  await page.goto("/#/share");
  await expect(page).toHaveURL(/#\/services$/);
});
