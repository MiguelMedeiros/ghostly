import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";

/*
 * Join call says why a group's call did not start in a box under the button. On a phone Join call is not the header's
 * last button (Share link and the menu come after it), and the box, 18rem wide from Join call's end edge, started past
 * the screen's side: 13 px at 375 px, 20 at 320, its first letters cut ("ão foi possível…"); past the right side in
 * Arabic. It lies across the phone's width under the header, as the connection panels there do.
 */
const SFU = "https://sfu.unreachable.invalid";

async function useLanguage(page: Page, language: string): Promise<void> {
  await page.evaluate((language) => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
  }, language);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
}

test("on a phone, Join call's problem box stays inside the screen, in English and in Arabic", { tag: ["@feature:calls.group"] }, async ({ peer, relay }) => {
  const node = new HeadlessBot();
  try {
    await node.start(await relay.listen(), "Call node");
    const group = (await node.run("group", "create", "Quinta")).group as string;
    await node.run("group", "call", group, "--sfu", SFU);
    const link = (await node.run("group", "link", group)).link as string;

    const ana = await peer("Ana", { mobile: true, viewport: { width: 320, height: 640 } });
    // The group's call node is down.
    await ana.context.route(`${SFU}/**`, (route) => route.fulfill({ status: 503, body: "down" }));
    const { page } = ana;
    await page.goto(link.includes("#") ? "/" + link.slice(link.indexOf("#")) : `/#/join/${link}`);
    await expect(page.getByTestId("group-chat")).toHaveAttribute("data-status", "active", { timeout: 180_000 });
    const chat = page.url();

    for (const language of ["en", "ar"]) {
      for (const width of [320, 375]) {
        await page.setViewportSize({ width, height: 640 });
        await page.goto(chat);
        await useLanguage(page, language);
        await page.getByTestId("group-call-join").click();
        const box = page.getByTestId("group-call-problem");
        await expect(page.getByTestId("group-call-problem-notice")).toBeVisible({ timeout: 60_000 });
        const { left, right } = await box.evaluate((el) => el.getBoundingClientRect());
        expect(left, `${language} at ${width} px`).toBeGreaterThanOrEqual(0);
        expect(right, `${language} at ${width} px`).toBeLessThanOrEqual(width);
        await expect(page.getByTestId("group-call-retry")).toBeInViewport({ ratio: 1 });
      }
    }
  } finally {
    await node.stop();
  }
});
