import type { Page } from "@playwright/test";
import { APP_BUNDLE_MAGIC, assembleAppBundle, canonicalJsonBytes } from "@ghostly/core";
import { chat, expect, test, type Peer } from "../support/fixtures";
import { pair } from "../support/paired";
import { composerRow } from "../support/composer";
import { APP_URL, STORE_URL, serveStore, testStore } from "../support/appStore";

/*
 * A bundle Ghostly refuses says so in a few words on the install screen, with the refusal as it came behind the ⓘ. A
 * refusal can name a file of the bundle, and a path has no space or dash to break at ("assets/ChessBoard_….html", up to
 * 128 characters): on a phone the ⓘ's text ran past the screen's side, and the screen scrolled sideways.
 */
const PHONE = { width: 320, height: 640 };
/** 129 characters: one past what a path may be, so the bundle is refused naming it. */
const PATH = `assets/${"ChessBoardPiecesAndOpenings_".repeat(5)}`.slice(0, 124) + ".html";

async function setNickname(peer: Peer, nick: string): Promise<void> {
  await peer.page.goto("/#/settings");
  await peer.page.getByPlaceholder("Enter your nickname...").fill(nick);
  await peer.page.goto("/#/");
}

async function useLanguage(page: Page, language: string): Promise<void> {
  await page.evaluate((language) => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
  }, language);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
}

/** The app's bundle with its first file's path made too long: refused before its signature is read. */
function withLongPath(bytes: Uint8Array): Uint8Array {
  const at = APP_BUNDLE_MAGIC.length;
  const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);
  const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(at + 4, at + 4 + length))) as { files: { path: string }[] };
  manifest.files[0]!.path = PATH;
  return assembleAppBundle(canonicalJsonBytes(manifest), new Uint8Array(), []);
}

for (const language of ["en", "ar"]) {
  test(`${language}: on a phone a refused app's ⓘ breaks a long file name, and the install screen never scrolls sideways`, { tag: ["@feature:apps.chat.card", "@feature:app.mobile-layout"] }, async ({ peer }) => {
    const store = await testStore();
    const [ana, bob] = await Promise.all([peer("ana"), peer("bob")]);
    await serveStore(ana.context, store);
    // The card's link holds another bundle by the time Bob joins: one Ghostly refuses.
    await serveStore(bob.context, { files: new Map([...store.files, [APP_URL, withLongPath(store.files.get(APP_URL)!)]]) });
    await setNickname(ana, "Ana");
    await setNickname(bob, "Bob");
    await ana.page.getByTestId("account-apps").click();
    await ana.page.getByTestId("apps-add").click();
    await ana.page.getByTestId("apps-add-url").fill(STORE_URL);
    await ana.page.getByTestId("apps-add-check").click();
    await ana.page.getByTestId("apps-add-store-confirm").click();
    await ana.page.getByTestId("app-store").filter({ hasText: store.storeName }).getByTestId("app-listing-install").click();
    await ana.page.getByTestId("app-install").getByTestId("app-install-confirm").click();
    await expect(ana.page.getByTestId("installed-app")).toBeVisible();
    await ana.page.goto("/#/");
    await pair(ana, bob);
    await ana.page.getByTestId("chat-row").first().click();
    await (await composerRow(ana.page, "composer-apps")).click();
    await ana.page.getByTestId("chat-apps").getByTestId("chat-app").getByTestId("chat-app-open").click();
    await expect(ana.page.getByTestId("mini-app")).toBeVisible();

    const page = bob.page;
    await page.setViewportSize(PHONE);
    await useLanguage(page, language);
    await page.goto("/#/");
    await page.getByTestId("chat-row").first().click();
    await chat(bob).getByTestId("app-card").getByTestId("app-card-install").click();
    const screen = page.getByTestId("app-install");
    await screen.getByTestId("app-install-error-info").click();
    const info = screen.getByTestId("app-install-error-text");
    await expect(info).toContainText(PATH);
    // Every letter of it inside its box, and nothing to scroll sideways.
    const drawn = await info.evaluate((element) => {
      const box = element.getBoundingClientRect(), range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      const screen = element.closest("[data-testid=app-install]")!;
      return { inside: text.left >= box.left - 1 && text.right <= box.right + 1, screen: screen.scrollWidth - screen.clientWidth, page: document.documentElement.scrollWidth - innerWidth };
    });
    expect(drawn).toEqual({ inside: true, screen: 0, page: 0 });
  });
}
