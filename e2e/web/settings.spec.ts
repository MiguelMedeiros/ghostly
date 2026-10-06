import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../support/fixtures";
import { choose } from "../support/select";

const version = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "apps", "web", "package.json"), "utf8")).version;

test("shows the version being released", { tag: ["@feature:app.version"] }, async ({ peer }) => {
  test.skip(!!process.env.E2E_WEB_URL, "a deployed app may be on another version");
  const { page } = await peer("alice");
  await page.getByTitle("Settings").click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText(version, { exact: true })).toBeVisible();
});

test("the nickname is kept, and can be made up", { tag: ["@feature:settings.nickname"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await page.goto("/#/settings");
  const nick = page.getByPlaceholder("Enter your nickname...");
  // Use a custom name outside the generator's vocabulary (which includes Casper).
  await nick.fill("QA custom nickname");
  await page.reload();
  await expect(nick).toHaveValue("QA custom nickname");
  await page.getByTitle("Generate random name").click();
  await expect(nick).not.toHaveValue("QA custom nickname");
  await expect(nick).not.toHaveValue("");
});

test("color theme and mode apply at once and survive a reload", { tag: ["@feature:app.theme"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await page.goto("/#/settings");
  const html = page.locator("html");
  await page.getByTestId("settings-theme-purple").click();
  await expect(html).toHaveAttribute("data-color-theme", "purple");
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(html).toHaveAttribute("data-color-theme", "purple");
  await expect(html).toHaveAttribute("data-theme", "light");
  await page.getByTestId("settings-theme-monochrome").click();
  await expect(html).toHaveAttribute("data-color-theme", "monochrome");
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
});

test("the language changes the interface", { tag: ["@feature:app.i18n"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await page.goto("/#/settings");
  await choose(page.getByTestId("settings-language"), "pt");
  await expect(page.getByTitle("Nova conversa", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ajustes" })).toBeVisible();
  await page.reload();
  await expect(page.getByTitle("Nova conversa")).toBeVisible();
  await choose(page.getByTestId("settings-language"), "en");
  // Sentence case, as every label (Settings is "Ajustes" in Portuguese, on every bar).
  await expect(page.getByTitle("New chat", { exact: true })).toBeVisible();
});

test("<html lang> and <html dir> follow the language, from the first paint", { tag: ["@feature:app.i18n"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await page.goto("/#/settings");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("lang", "en");
  await expect(html).toHaveAttribute("dir", "ltr");

  // Arabic turns the page right to left: screen readers, hyphenation and spell-check read it as Arabic.
  await choose(page.getByTestId("settings-language"), "ar");
  await expect(html).toHaveAttribute("lang", "ar");
  await expect(html).toHaveAttribute("dir", "rtl");

  // A reload starts in it: the entry point sets both before React renders, so the page never shows in the wrong direction.
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      (window as unknown as { atLoad: string[] }).atLoad = [document.documentElement.lang, document.documentElement.dir];
    });
  });
  await page.reload();
  expect(await page.evaluate(() => (window as unknown as { atLoad: string[] }).atLoad)).toEqual(["ar", "rtl"]);
  await expect(page.getByRole("heading", { name: "الإعدادات" })).toBeVisible();

  await choose(page.getByTestId("settings-language"), "pt");
  await expect(html).toHaveAttribute("lang", "pt-BR");
  await expect(html).toHaveAttribute("dir", "ltr");
  await choose(page.getByTestId("settings-language"), "en");
  await expect(html).toHaveAttribute("lang", "en");
});

test("reduce motion is a switch", { tag: ["@feature:app.reduce-motion", "@feature:app.attention.sounds"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await page.goto("/#/settings");
  const reduce = page.getByTestId("settings-reduce-motion");
  await expect(reduce).toHaveAttribute("aria-checked", "false");
  await reduce.click();
  await expect(reduce).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", /.*/);
  const sounds = page.getByTestId("settings-sounds");
  await expect(sounds).toHaveAttribute("aria-checked", "true");
  await sounds.click();
  await expect(sounds).toHaveAttribute("aria-checked", "false");
  await page.reload();
  await expect(sounds).toHaveAttribute("aria-checked", "false");
});

test("lock screen: a password locks the app, only it unlocks it", { tag: ["@feature:settings.lock.now", "@feature:settings.lock.password"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await page.goto("/#/settings");
  await page.getByRole("switch", { name: "Lock Screen" }).click();
  const passwords = page.getByTestId("settings-password-form").locator("input[type=password]");

  await passwords.nth(0).fill("boo");
  await passwords.nth(1).fill("boo");
  await page.getByRole("button", { name: "Set password" }).click();
  // Said under the field, and in the floating card.
  await expect(page.getByTestId("settings-password-new-error")).toHaveText("Password must be at least 4 characters");
  await expect(page.getByTestId("settings-notice")).toContainText("Password not set");

  await passwords.nth(0).fill("spooky");
  await passwords.nth(1).fill("spookier");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByTestId("settings-password-confirm-error")).toHaveText("Passwords do not match");

  await passwords.nth(1).fill("spooky");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByText("Password set successfully")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Lock Screen" })).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: "Lock Now" }).click();
  await expect(page.getByText("Ghostly is locked")).toBeVisible();
  await page.getByPlaceholder("Password").fill("wrong");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Incorrect password, try again")).toBeVisible();
  await expect(page.getByText("Ghostly is locked")).toBeVisible();
  await page.getByPlaceholder("Password").fill("spooky");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Ghostly is locked")).toHaveCount(0);

  // Removing it asks for the current one, in the form that opens on demand.
  await page.goto("/#/settings");
  await expect(passwords).toHaveCount(0);
  await page.getByTestId("settings-password-edit").click();
  await passwords.nth(0).fill("wrong");
  await page.getByRole("button", { name: "Remove password" }).click();
  await expect(page.getByTestId("settings-password-current-error")).toHaveText("Incorrect password");
  await expect(page.getByTestId("settings-notice")).toContainText("Password not removed");
  await passwords.nth(0).fill("spooky");
  await page.getByRole("button", { name: "Remove password" }).click();
  await expect(page.getByText("Password removed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Lock Now" })).toHaveCount(0);
});

test("lock screen: locks by itself after the chosen idle time", { tag: ["@feature:settings.lock.idle"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await page.clock.install();
  await page.goto("/#/settings");
  await page.getByRole("switch", { name: "Lock Screen" }).click();
  const passwords = page.getByTestId("settings-password-form").locator("input[type=password]");
  await passwords.nth(0).fill("spooky");
  await passwords.nth(1).fill("spooky");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByText("Password set successfully")).toBeVisible();
  await choose(page.getByTestId("settings-timeout"), "1");
  await page.clock.runFor(30_000);
  await expect(page.getByText("Ghostly is locked")).toHaveCount(0);
  await page.clock.runFor(45_000);
  await expect(page.getByText("Ghostly is locked")).toBeVisible();
});

test("network: relays can be changed and reset", { tag: ["@feature:settings.network.relays"] }, async ({ peer }) => {
  const { page, context } = await peer("alice");
  // The relay typed below is a real name on the Internet: refused here, so the peer never reaches it.
  await context.route(/^https?:\/\/relay\.example\.org\//, (route) => route.abort());
  // Its own section: the index beside the page goes there, and the address names it.
  await page.goto("/#/settings");
  await page.getByTestId("settings-index-network").click();
  await expect(page).toHaveURL(/#\/settings\/network$/);
  const relays = page.getByTestId("network-relays");
  await expect(relays).toHaveValue("https://pkarr.pubky.org\nhttps://pkarr.pubky.app");
  await relays.fill("https://relay.example.org/\nnot a url");
  await page.getByTestId("network-save").click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  // Kept normalized, and what is not a URL is dropped.
  await expect(relays).toHaveValue("https://relay.example.org");
  await page.getByRole("button", { name: "Reset to defaults" }).click();
  await page.getByTestId("network-save").click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(relays).toHaveValue("https://pkarr.pubky.org\nhttps://pkarr.pubky.app");
});

test("on a phone: a menu of sections, each on its own screen, and Back to the menu", { tag: ["@feature:settings.sections", "@feature:app.mobile-layout"] }, async ({ peer }) => {
  const { page } = await peer("alice", { mobile: true });
  await page.getByTestId("mobile-tab-settings").click();
  await expect(page.getByTestId("settings-menu")).toBeVisible();
  await expect(page.getByTestId("settings-open-appearance")).toContainText("English");
  await expect(page.getByTestId("settings-lock")).toHaveCount(0);

  await page.getByTestId("settings-open-privacy").click();
  await expect(page).toHaveURL(/#\/settings\/privacy$/);
  await expect(page.getByRole("heading", { level: 1, name: "Privacy & security" })).toBeVisible();
  await expect(page.getByTestId("settings-lock")).toBeVisible();
  // The phone's Back gesture: the menu again.
  await page.goBack();
  await expect(page).toHaveURL(/#\/settings$/);
  await expect(page.getByTestId("settings-menu")).toBeVisible();

  // The search finds an option by name and opens its section; the header's Back goes up to the menu.
  await page.getByTestId("settings-search").fill("chat list");
  await page.getByTestId("settings-search-result").click();
  await expect(page).toHaveURL(/#\/settings\/appearance$/);
  await choose(page.getByTestId("settings-language"), "pt");
  await expect(page.getByRole("heading", { level: 1, name: "Aparência" })).toBeVisible();
  await page.getByTestId("page-back").click();
  await expect(page.getByRole("heading", { level: 1, name: "Ajustes" })).toBeVisible();

  // An address from before the sections opens its new place, with Back to the menu, after a reload too.
  await page.goto("/#/settings/advanced");
  await expect(page).toHaveURL(/#\/settings\/network$/);
  await expect(page.getByTestId("network-relays")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("network-relays")).toBeVisible();
  await page.getByTestId("page-back").click();
  await expect(page.getByTestId("settings-menu")).toBeVisible();
});

test("on a wide screen: the index marks the section picked or named, the last ones too", { tag: ["@feature:settings.sections"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  const marked = page.locator("[data-testid^=settings-index-][aria-current=true]");
  await page.goto("/#/settings");
  // About and Data & storage end the page: it cannot scroll them to its top, and the index still marks them.
  for (const section of ["about", "storage", "network", "about"]) {
    await page.getByTestId(`settings-index-${section}`).click();
    await expect(page).toHaveURL(new RegExp(`#/settings/${section}$`));
    await expect(marked).toHaveAttribute("data-testid", `settings-index-${section}`);
  }
  // An address that names the last section, after a reload.
  await page.reload();
  await expect(page.getByTestId("settings-about-version")).toBeInViewport();
  await expect(marked).toHaveAttribute("data-testid", "settings-index-about");
  // Scrolled by hand to the top and back to the end: the first section, then the last.
  await page.getByTestId("settings-about-version").hover();
  await page.mouse.wheel(0, -100_000);
  await expect(marked).toHaveAttribute("data-testid", "settings-index-profile");
  await page.mouse.wheel(0, 100_000);
  await expect(marked).toHaveAttribute("data-testid", "settings-index-about");
  // Picked Network, then scrolled up by hand while it is still in view: the section now at the top is marked.
  await page.getByTestId("settings-index-network").click();
  await expect(marked).toHaveAttribute("data-testid", "settings-index-network");
  // Once the page has scrolled there (smoothly) and stopped: Network's top under the header. Coming up from About,
  // Network is above the page (y < 0) until the scroll ends; a wheel turned while the smooth scroll still ran left
  // the page far above it (r9j: 1 run in 3).
  await expect.poll(async () => {
    const y = (await page.locator("#settings-section-network").boundingBox())?.y ?? -1;
    return y >= 0 && y < 120;
  }).toBe(true);
  await page.locator("[data-page-body]").evaluate((body) => new Promise<void>((done) => {
    let last = -1, still = 0;
    const tick = () => { still = body.scrollTop === last ? still + 1 : 0; last = body.scrollTop; if (still >= 5) done(); else requestAnimationFrame(tick); };
    tick();
  }));
  await page.getByTestId("network-relays").hover();
  await page.mouse.wheel(0, -400);
  await expect(page.getByTestId("network-relays")).toBeInViewport();
  await expect(marked).not.toHaveAttribute("data-testid", "settings-index-network");
});

test("on a wide screen: a section drawn late above the one picked still lets the page reach it", { tag: ["@feature:settings.sections"] }, async ({ peer }) => {
  // Network is drawn once its settings load, 680px taller: on a busy machine that came while the page still glided to
  // About, which then ended short of it, Network marked (CI, nearly every run). Made certain here: Network grows a
  // frame after the pick, the smooth scroll already on its way.
  const { page } = await peer("alice");
  const marked = page.locator("[data-testid^=settings-index-][aria-current=true]");
  await page.goto("/#/settings");
  await expect(page.getByTestId("network-relays")).toBeAttached();
  await page.getByTestId("settings-index-about").evaluate((button) => button.addEventListener("click", () => {
    requestAnimationFrame(() => { document.getElementById("settings-section-network")!.style.minHeight = "1600px"; });
  }, { once: true }));
  await page.getByTestId("settings-index-about").click();
  await expect(page).toHaveURL(/#\/settings\/about$/);
  await expect(page.getByTestId("settings-about-version")).toBeInViewport();
  await expect(marked).toHaveAttribute("data-testid", "settings-index-about");
});

for (const screen of [{ name: "a tablet held upright", width: 820, height: 1180, mobile: true }, { name: "a phone on its side", width: 874, height: 402, mobile: true }, { name: "a narrow window", width: 1024, height: 768, mobile: false }]) {
  test(`${screen.name}: the search is there with no room for the index beside the page`, { tag: ["@feature:settings.sections", "@feature:app.responsive"] }, async ({ peer }) => {
    // From 768px Settings is one page, and its index (with the search) waits for room beside it: in between there was
    // neither the phone's menu search nor the index's.
    const { page } = await peer("alice", { mobile: screen.mobile, viewport: { width: screen.width, height: screen.height } });
    await page.goto("/#/settings");
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await expect(page.getByTestId("settings-index")).toBeHidden();
    const search = page.getByTestId("settings-page-search-field");
    await expect(search).toBeVisible();
    await search.fill("chat list");
    await page.getByTestId("settings-search-result").click();
    await expect(page).toHaveURL(/#\/settings\/appearance$/);
    await expect(page.getByTestId("chat-list-density")).toBeInViewport();
    await expect(search).toHaveValue("");
    await expect(page.getByTestId("settings-search-result")).toHaveCount(0);
  });
}

test("a wide window: the index's search beside the page, no second one above it", { tag: ["@feature:settings.sections"] }, async ({ peer }) => {
  const { page } = await peer("alice");
  await page.goto("/#/settings");
  await expect(page.getByTestId("settings-index-search")).toBeVisible();
  await expect(page.getByTestId("settings-page-search-field")).toBeHidden();
});
