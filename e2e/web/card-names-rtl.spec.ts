import type { Locator, Page } from "@playwright/test";
import { pasteInvite } from "../support/clipboard";
import { expect, test } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";

/**
 * In Arabic (right to left) a bot's Latin name or tag that is longer than its place is cut at its end, as in English:
 * its first letter is drawn inside the box that cuts it. The usage details' title and a tag to filter the Tasks board
 * by cut them in the page's direction with the text in a <bdi> inside, so in Arabic they lost their start.
 */
test.describe.configure({ timeout: 6 * 60_000 });

/** Whether `el`'s text is cut, and its first letter is drawn inside the (clipping) box that cuts it, up to `top`. */
async function start(el: Locator, top: string) {
  return el.evaluate((el, top) => {
    let box: Element = el;
    while (box.scrollWidth <= box.clientWidth && box.parentElement && !box.matches(top)) box = box.parentElement;
    const text = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 1);
    const letter = range.getBoundingClientRect(), cut = box.getBoundingClientRect();
    return { cut: box.scrollWidth > box.clientWidth, inside: letter.left >= cut.left - 1 && letter.right <= cut.right + 1 };
  }, top);
}

async function language(page: Page, code: "en" | "ar") {
  await page.evaluate((language) => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
  }, code);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", code === "ar" ? "rtl" : "ltr");
}

test("in Arabic a bot's long Latin usage name and task tag start with their first letters", { tag: ["@feature:chat.status-cards.usage", "@feature:chat.tasks-board", "@feature:app.i18n"] }, async ({ peer, relay }) => {
  // The longest a reader keeps (24 characters each), wide enough to be cut in the details' popover (about 215 px for the
  // title) and in a tag's pill (about 140 px for the text).
  const label = "WOMBAT WORKSPACE MAXIMUM", tag = "WOMBAT-WORKSPACE-MAXIMUM";
  const url = await relay.listen();
  const bot = new HeadlessBot();
  try {
    await bot.start(url, "Hermes One");
    const person = await peer("card-names-person");
    const page = person.page;
    await page.setViewportSize({ width: 1280, height: 800 });
    const invite = await bot.run("invite", "create", "--label", "person");
    await page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(page, invite.invite as string);
    await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
    await expect(page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 90_000 });
    const direct = invite.chat as string;
    await bot.run("usage", "send", direct, "--label", label, "--left", "62", "--wait", "sent");
    await bot.run("task", "send", direct, "--id", "release", "--title", "Ship the release", "--tag", tag, "--wait", "delivered");
    await expect(page.getByTestId("chat-usage")).toHaveAttribute("data-left", "62", { timeout: 60_000 });

    for (const code of ["en", "ar"] as const) {
      await language(page, code);
      // The usage details' title, in the header's popover.
      await page.getByTestId("chat-row").filter({ hasText: "Hermes One" }).click();
      await page.getByTestId("chat-usage-open").click();
      const title = page.getByTestId("chat-usage-panel").getByRole("heading");
      await expect(title).toHaveText(label);
      expect(await start(title.locator("bdi"), "h2"), `the usage name in ${code}`).toEqual({ cut: true, inside: true });
      await page.screenshot({ path: test.info().outputPath(`usage-${code}.png`) });
      await page.keyboard.press("Escape");

      // A tag to filter the Tasks board by, 160 px at most.
      await page.getByTestId("sidebar-tasks").click();
      const pill = page.getByTestId("tasks-tags").getByTestId("tasks-tag");
      await expect(pill).toHaveText(tag);
      expect(await start(pill.locator("bdi"), "button"), `the tag in ${code}`).toEqual({ cut: true, inside: true });
      await page.screenshot({ path: test.info().outputPath(`tags-${code}.png`) });
    }
  } finally {
    await bot.stop();
  }
});
