import { pasteInvite } from "../support/clipboard";
import { expect, expectConnected, headerControl, test } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";

/**
 * A chat's header on a phone. It had every button at once (the connection, a call, a video call, a bot's Tasks, ⋮),
 * the contact's marks, their key, a bot's meter and its activity dot: nine marks and buttons in three styles, and the
 * name cut to eight letters ("Cérebro (…"). It keeps the name, a voice call and ⋮ now, and one quiet line under the
 * name; the connection, the video call, the Tasks and the identities are rows of ⋮, which counts the running tasks.
 */
test.describe.configure({ timeout: 5 * 60_000 });

const MOVED = ["call-video", "chat-tasks", "connection-options", "chat-identity-badges"];

test("on a phone a chat's header keeps the contact's whole name beside a call and ⋮, and has the rest in ⋮", { tag: ["@feature:app.mobile-layout", "@feature:chat.status-cards", "@feature:app.menus"] }, async ({ peer, relay }) => {
  const url = await relay.listen();
  const bot = new HeadlessBot();
  try {
    await bot.start(url, "Cérebro (Mac)");
    const person = await peer("header-person", { mobile: true, viewport: { width: 402, height: 874 } });
    const invite = await bot.run("invite", "create", "--label", "person");
    await person.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(person.page, invite.invite as string);
    await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
    const page = person.page;
    await expectConnected(page);
    await bot.run("usage", "send", invite.chat as string, "--label", "Claude", "--left", "72", "--window", "5 h", "--wait", "sent");
    await bot.run("task", "send", invite.chat as string, "--id", "relay", "--title", "Fix relay rotation", "--status", "running", "--wait", "delivered");
    await expect(page.getByTestId("chat-tasks-count")).toHaveText("1");
    const name = page.getByTestId("chat-name");
    const rename = async (to: string) => {
      await page.getByTitle("Click to set a name").click();
      await page.getByPlaceholder("Set a name...").fill(to);
      await page.getByPlaceholder("Set a name...").press("Enter");
      await expect(name).toHaveText(to);
    };
    /** The name's line against what it holds: cut with an ellipsis when `shown` < `whole`. */
    const line = () => name.evaluate((el) => ({ shown: el.parentElement!.clientWidth, whole: el.parentElement!.scrollWidth }));

    // The names seen in the wild, a 25-letter one and an Arabic one, on each phone they fit.
    const names: [string, number][] = [["Cérebro (Mac)", 320], ["Hermes (Omarchy)", 375], ["Maximiliano Albuquerque S", 390], ["عبد الرحمن الفارسي", 375]];
    for (const [shown, narrowest] of names) {
      if (shown !== "Cérebro (Mac)") await rename(shown);
      for (const phone of [{ width: 402, height: 874 }, { width: 390, height: 844 }, { width: 375, height: 667 }, { width: 320, height: 568 }]) {
        if (phone.width < narrowest) continue;
        await page.setViewportSize(phone);
        const room = await line();
        expect(room.whole, `"${shown}" at ${phone.width}px: ${JSON.stringify(room)}`).toBeLessThanOrEqual(room.shown);
      }
    }

    for (const phone of [{ width: 402, height: 874 }, { width: 320, height: 568 }]) {
      await page.setViewportSize(phone);
      // Two buttons, each a 44px target, whole and inside the screen; nothing else beside the name.
      for (const id of ["call-audio", "chat-options"]) {
        const box = (await page.getByTestId(id).boundingBox())!;
        expect(Math.min(box.width, box.height), `${id} at ${phone.width}px`).toBeGreaterThanOrEqual(44);
        expect(box.x + box.width, `${id} at ${phone.width}px`).toBeLessThanOrEqual(phone.width);
      }
      for (const id of MOVED) await expect(page.getByTestId(id), `${id} at ${phone.width}px`).toHaveCount(0);
      // A bot's line under its name: the meter and what it is doing, without its key.
      await expect(page.getByTestId("chat-usage")).toBeVisible();
      await expect(page.getByTestId("chat-working")).toBeVisible();
      await expect(page.getByTestId("chat-subtitle")).toBeHidden();
    }

    // The rest is in ⋮, each row saying what it is; the rows open what the header's buttons opened.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("chat-options").click();
    const menu = page.getByTestId("chat-options-menu");
    for (const id of MOVED) await expect(menu.getByTestId(id), id).toBeVisible();
    await expect(menu.getByTestId("call-video")).toHaveText("Video call");
    await expect(menu.getByTestId("chat-tasks")).toHaveText("Tasks, 1 active");
    await expect(menu.getByTestId("connection-options")).toContainText(/Connected · /);
    await expect(menu.getByTestId("chat-identity-badges")).toContainText(/\S{6}\.\.\.\S{6}/);
    await menu.getByTestId("chat-tasks").click();
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId("chat-tasks-panel")).toHaveAttribute("data-layout", "sheet");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("chat-tasks-panel")).toHaveCount(0);
    await expect(page.getByTestId("chat-options")).toBeFocused();
    await (await headerControl(page, "connection-options")).click();
    await expect(page.getByRole("dialog", { name: "Connection options" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Connection options" })).toBeHidden();
    await expect(page.getByTestId("chat-options")).toBeFocused();

    // A phone on its side has the room: every button is in the header again.
    await page.setViewportSize({ width: 844, height: 390 });
    for (const id of MOVED) await expect(page.getByTestId(id), id).toBeVisible();
  } finally {
    await bot.stop();
  }
});
