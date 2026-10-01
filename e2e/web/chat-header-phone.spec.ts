import { pasteInvite } from "../support/clipboard";
import { expect, test } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";

/**
 * A chat's header on a phone, with every button it can have: the connection (a globe once connected), a call, a video
 * call, a bot's Tasks and ⋮. The contact's name had what was left, down to one letter on a 375px phone. It keeps at
 * least eight characters now, with the same buttons.
 */
test.describe.configure({ timeout: 5 * 60_000 });

test("on a phone a chat's header keeps eight characters of the contact's name beside all its buttons", { tag: ["@feature:app.mobile-layout", "@feature:chat.status-cards"] }, async ({ peer, relay }) => {
  const url = await relay.listen();
  const bot = new HeadlessBot();
  try {
    await bot.start(url, "Coordinator");
    const person = await peer("header-person", { mobile: true, viewport: { width: 402, height: 874 } });
    const invite = await bot.run("invite", "create", "--label", "person");
    await person.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(person.page, invite.invite as string);
    await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
    const page = person.page;
    await expect(page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 90_000 });
    await bot.run("task", "send", invite.chat as string, "--id", "relay", "--title", "Fix relay rotation", "--steps", "1/4", "--wait", "delivered");
    await expect(page.getByTestId("chat-tasks")).toBeVisible();
    const name = page.getByTestId("chat-name");
    await expect(name).toHaveText("Coordinator");

    for (const phone of [{ width: 402, height: 874 }, { width: 390, height: 844 }, { width: 375, height: 667 }]) {
      await page.setViewportSize(phone);
      // Every button is there and whole, inside the screen.
      for (const id of ["connection-options", "call-audio", "call-video", "chat-tasks", "chat-options"]) {
        const box = (await page.getByTestId(id).boundingBox())!;
        expect(box.x + box.width, `${id} at ${phone.width}px`).toBeLessThanOrEqual(phone.width);
      }
      // The name's box is as wide as its first eight characters and the ellipsis at least.
      const room = await name.evaluate((el) => {
        const line = el.parentElement!;
        const probe = document.createElement("span");
        probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
        probe.textContent = `${(el.textContent ?? "").slice(0, 8)}…`;
        line.appendChild(probe);
        const eight = probe.getBoundingClientRect().width;
        probe.remove();
        return { shown: line.getBoundingClientRect().width, eight };
      });
      expect(room.shown, `name at ${phone.width}px: ${JSON.stringify(room)}`).toBeGreaterThanOrEqual(room.eight);    }
  } finally {
    await bot.stop();
  }
});
