import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";
import { smallTargets } from "../support/touchTargets";

/*
 * A group call's whole window on a phone: every button a thumb can take, 44 px where a tap lands, as the 1:1 call's are.
 * The ⓘ beside the group's name was a 20 px circle with nothing grown around it, between the name and the window's top.
 * No LiveKit here: the group's node answers a pass, and the room it names never answers, so the window stays open on
 * its own tile.
 */
const SFU = "https://sfu.targets.invalid";
const ROOM = /lk\.targets\.invalid/;

async function useLanguage(page: Page, language: string): Promise<void> {
  await page.evaluate((language) => {
    const settings = JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}");
    localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...settings, language }));
  }, language);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", language === "ar" ? "rtl" : "ltr");
}

test("on a phone the group call window's buttons are 44 px targets, in English and in Arabic", { tag: ["@feature:calls.group", "@feature:app.mobile-layout"] }, async ({ peer, relay }, testInfo) => {
  const node = new HeadlessBot();
  try {
    await node.start(await relay.listen(), "Call node");
    const group = (await node.run("group", "create", "Quinta")).group as string;
    await node.run("group", "call", group, "--sfu", SFU);
    const link = (await node.run("group", "link", group)).link as string;

    const ana = await peer("Ana", { mobile: true, viewport: { width: 375, height: 740 } });
    await ana.context.route(`${SFU}/**`, async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as { room?: string; k?: string };
      await route.fulfill({ json: { url: "wss://lk.targets.invalid", token: "t", room: body.room, identity: body.k, expiresIn: 600 } });
    });
    await ana.context.routeWebSocket(ROOM, () => {});
    await ana.context.route(ROOM, () => {});
    const { page } = ana;
    await page.goto(link.includes("#") ? "/" + link.slice(link.indexOf("#")) : `/#/join/${link}`);
    await expect(page.getByTestId("group-chat")).toHaveAttribute("data-status", "active", { timeout: 180_000 });
    const chat = page.url();

    for (const language of ["en", "ar"]) {
      for (const width of [375, 320]) {
        await page.setViewportSize({ width, height: 740 });
        await page.goto(chat);
        await useLanguage(page, language);
        await page.getByTestId("group-call-join").click();
        await expect(page.getByTestId("group-call")).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId("group-call-info")).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`group-call-${language}-${width}.png`) });
        const small = (await smallTargets(page, 44, "[data-testid=group-call] button")).map((t) => `${t.name} ${t.width}×${t.height} (${t.stops})`);
        expect(small, `${language} at ${width} px`).toEqual([]);
      }
    }
  } finally {
    await node.stop();
  }
});
