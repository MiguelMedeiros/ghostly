import type { Locator, Page } from "@playwright/test";
import { pasteInvite } from "../support/clipboard";
import { chat, expect, expectConnected, test } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";

/**
 * A chat's header on a phone. It had every button at once (the connection, a call, a video call, a bot's Tasks, ⋮),
 * the contact's marks, their key, a bot's meter and its activity dot: nine marks and buttons in three styles, and the
 * name cut to eight letters ("Cérebro (…"). It keeps the name, the connection, a voice call and ⋮ now, and one quiet
 * line under the name; the video call, the Tasks and the identities are rows of ⋮, which counts the running tasks.
 * The connection stays in the row: it changes by itself, and a chat that fails has to show it.
 */
test.describe.configure({ timeout: 5 * 60_000 });

const MOVED = ["call-video", "chat-tasks", "chat-identity-badges"];

test("on a phone a chat's header keeps the contact's whole name beside the connection, a call and ⋮, and has the rest in ⋮", { tag: ["@feature:app.mobile-layout", "@feature:chat.status-cards", "@feature:app.menus"] }, async ({ peer, relay }) => {
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
    /** The name against what it holds: cut with an ellipsis when `shown` < `whole`. */
    const line = () => name.evaluate((el) => ({ shown: el.clientWidth, whole: el.scrollWidth }));

    // The names seen in the wild and an Arabic one, on each phone they fit.
    const names: [string, number][] = [["Cérebro (Mac)", 320], ["Hermes (Omarchy)", 375], ["عبد الرحمن الفارسي", 375]];
    for (const [shown, narrowest] of names) {
      if (shown !== "Cérebro (Mac)") await rename(shown);
      for (const phone of [{ width: 402, height: 874 }, { width: 390, height: 844 }, { width: 375, height: 667 }, { width: 320, height: 568 }]) {
        if (phone.width < narrowest) continue;
        await page.setViewportSize(phone);
        const room = await line();
        expect(room.whole, `"${shown}" at ${phone.width}px: ${JSON.stringify(room)}`).toBeLessThanOrEqual(room.shown);
      }
    }

    // A 25-letter name is longer than the row: it is cut with an ellipsis after twenty letters or more, never to eight.
    await rename("Maximiliano Albuquerque S");
    await page.setViewportSize({ width: 390, height: 844 });
    const long = await name.evaluate((el) => {
      const probe = document.createElement("span");
      probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
      probe.textContent = `${(el.textContent ?? "").slice(0, 20)}…`;
      el.parentElement!.appendChild(probe);
      const twenty = probe.getBoundingClientRect().width;
      probe.remove();
      return { shown: el.clientWidth, twenty };
    });
    expect(long.shown, JSON.stringify(long)).toBeGreaterThanOrEqual(long.twenty);

    for (const phone of [{ width: 402, height: 874 }, { width: 320, height: 568 }]) {
      await page.setViewportSize(phone);
      // Three buttons, each a 44px target, whole and inside the screen; nothing else beside the name.
      for (const id of ["connection-options", "call-audio", "chat-options"]) {
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
    await expect(menu.getByTestId("connection-options")).toHaveCount(0);
    await expect(menu.getByTestId("chat-identity-badges")).toContainText(/\S{6}\.\.\.\S{6}/);
    await menu.getByTestId("chat-tasks").click();
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId("chat-tasks-panel")).toHaveAttribute("data-layout", "sheet");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("chat-tasks-panel")).toHaveCount(0);
    await expect(page.getByTestId("chat-options")).toBeFocused();
    // The connection opens its panel from the header, as on a wide screen.
    await page.getByTestId("connection-options").click();
    await expect(page.getByRole("dialog", { name: "Connection options" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Connection options" })).toBeHidden();
    await expect(page.getByTestId("connection-options")).toBeFocused();

    // The sheet in groups: what is done now, the conversation (the identities, the bot's Tasks), More…, and Delete chat
    // apart. No Move up or Move down: a pinned chat's place is the list's. A separator is "—".
    await page.getByTestId("chat-options").click();
    const layout = (sheet: typeof menu) => sheet.locator("[data-menu-item], [role=separator]")
      .evaluateAll(els => els.map(el => el.getAttribute("role") === "separator" ? "—" : (el as HTMLElement).dataset.testid ?? el.textContent));
    await expect.poll(() => layout(menu)).toEqual(["call-video", "chat-search-open", "chat-mute-open", "chat-pin-toggle", "—", "chat-identity-badges", "chat-tasks", "—", "chat-more-open", "—", "Delete chat"]);
    await expect(menu.getByTestId("chat-more-open")).toHaveText("More…");
    await page.screenshot({ path: test.info().outputPath("phone-menu.png") });
    // More…: a second sheet with the rarer rows, the first one focused; Escape gives the focus back to ⋮.
    await menu.getByTestId("chat-more-open").click();
    await expect(menu).toHaveCount(0);
    const more = page.getByTestId("chat-more-menu");
    await expect(more).toHaveAttribute("data-menu", "sheet");
    await expect.poll(() => layout(more)).toEqual(["chat-folder-open", "chat-hold-open", "chat-refresh", "chat-tech-info"]);
    await expect(more.getByTestId("chat-folder-open")).toBeFocused();
    await page.waitForTimeout(400); // the sheet fades in: the picture after it
    await page.screenshot({ path: test.info().outputPath("phone-more.png") });
    await page.keyboard.press("Escape");
    await expect(more).toHaveCount(0);
    await expect(page.getByTestId("chat-options")).toBeFocused();
    // Its rows open what they did: Hold messages….
    await page.getByTestId("chat-options").click();
    await menu.getByTestId("chat-more-open").click();
    await more.getByTestId("chat-hold-open").click();
    await expect(more).toHaveCount(0);
    await expect(page.getByTestId("chat-hold")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("chat-hold")).toHaveCount(0);

    // A phone on its side has the room: every button is in the header again.
    await page.setViewportSize({ width: 844, height: 390 });
    for (const id of ["connection-options", ...MOVED]) await expect(page.getByTestId(id), id).toBeVisible();
  } finally {
    await bot.stop();
  }
});

/**
 * A received message's name line on the narrowest phone, with a name of one long word (30 letters, the longest a
 * contact's name takes). It had no rule to wrap or cut it, and ran from 19 to 381 px on a 320 px screen: past its
 * bubble, past the screen's edge and over the message's ⋮. It is one line cut with an ellipsis inside the bubble now,
 * the whole name in its tooltip; in a 1:1 chat (the name given to the contact) and in a group (a member's own name).
 * In Arabic the Latin name is cut at its end too: its ellipsis was on its left, where it starts, and only its end showed.
 */
test.describe("a received message's long one-word name on a 320px phone", () => {
  const LONG = "W".repeat(30);
  const PHONE = { width: 320, height: 568 };

  /** The name line against its bubble and the screen: inside both, its text cut where the ellipsis is (it holds more than it shows). */
  async function insideItsBubble(nick: Locator, whole: string) {
    await expect(nick).toHaveText(whole);
    await expect(nick).toHaveAttribute("title", whole);
    const at = await nick.evaluate((el) => {
      // In a group the name is a button (it opens who the member is) and the ellipsis is on it, inside the line.
      const cut = el.querySelector<HTMLElement>("[data-testid='message-nick-open']") ?? el;
      const line = el.getBoundingClientRect(), bubble = el.closest("[data-message-bubble]")!.getBoundingClientRect();
      // The name's first letter, where it starts reading: inside the box that cuts it, the ellipsis at the other end.
      const text = document.createTreeWalker(cut, NodeFilter.SHOW_TEXT).nextNode()!;
      const first = document.createRange();
      first.setStart(text, 0);
      first.setEnd(text, 1);
      const letter = first.getBoundingClientRect(), box = cut.getBoundingClientRect();
      return { left: line.left, right: line.right, bubbleLeft: bubble.left, bubbleRight: bubble.right, screen: window.innerWidth,
        shown: cut.clientWidth, whole: cut.scrollWidth, page: document.documentElement.scrollWidth,
        firstShown: letter.left >= box.left - 0.5 && letter.right <= box.right + 0.5 };
    });
    const seen = JSON.stringify(at);
    expect(at.left, seen).toBeGreaterThanOrEqual(at.bubbleLeft);
    expect(at.right, seen).toBeLessThanOrEqual(at.bubbleRight);
    expect(at.bubbleRight, seen).toBeLessThanOrEqual(at.screen);
    expect(at.page, seen).toBeLessThanOrEqual(at.screen);
    expect(at.whole, seen).toBeGreaterThan(at.shown);
    expect(at.firstShown, seen).toBe(true);
  }

  /** The app in Arabic (right to left), the chat open again on the same message. */
  async function inArabic(page: Page, row: Locator) {
    await page.evaluate(() => localStorage.setItem("ghostly_app_settings", JSON.stringify({ ...JSON.parse(localStorage.getItem("ghostly_app_settings") ?? "{}"), language: "ar" })));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(row).toBeVisible({ timeout: 60_000 });
  }

  test("a contact's name of one long word stays inside their message's bubble", { tag: ["@feature:app.mobile-layout", "@feature:chats.list.rename"] }, async ({ peer, relay }) => {
    const url = await relay.listen();
    const bot = new HeadlessBot();
    try {
      await bot.start(url, "Cérebro (Mac)");
      const person = await peer("long-name-person", { mobile: true, viewport: { width: 402, height: 874 } });
      const invite = await bot.run("invite", "create", "--label", "person");
      await person.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
      await pasteInvite(person.page, invite.invite as string);
      await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
      const page = person.page;
      await expectConnected(page);
      await page.getByTitle("Click to set a name").click();
      await page.getByPlaceholder("Set a name...").fill(LONG);
      await page.getByPlaceholder("Set a name...").press("Enter");
      await expect(page.getByTestId("chat-name")).toHaveText(LONG);

      await bot.run("send", invite.chat as string, "Build finished", "--wait", "delivered");
      await page.setViewportSize(PHONE);
      const row = chat(person).locator("[data-message-row]").filter({ hasText: "Build finished" });
      await insideItsBubble(row.getByTestId("message-nick"), LONG);
      await page.screenshot({ path: test.info().outputPath("long-name-1to1.png") });
      await inArabic(page, row);
      await insideItsBubble(row.getByTestId("message-nick"), LONG);
      await page.screenshot({ path: test.info().outputPath("long-name-1to1-ar.png") });
    } finally {
      await bot.stop();
    }
  });

  test("a group member's own name of one long word stays inside their message's bubble", { tag: ["@feature:app.mobile-layout", "@feature:groups.member-colors"] }, async ({ peer, relay }) => {
    test.setTimeout(8 * 60_000);
    const url = await relay.listen();
    const bot = new HeadlessBot();
    try {
      await bot.start(url, LONG);
      const person = await peer("long-name-member", { mobile: true, viewport: { width: 402, height: 874 } });
      const page = person.page;
      const group = (await bot.run("group", "create", "Long names", "--mesh")).group as string;
      const { link } = await bot.run("group", "link", group) as { link: string };
      const code = link.includes("#/join/") ? link.slice(link.indexOf("#/join/") + "#/join/".length) : link;
      await page.goto(`/#/join/${code}`);
      await expect(page.getByTestId("group-chat")).toHaveAttribute("data-status", "active", { timeout: 150_000 });
      type Shown = { status?: string; members?: { me: boolean; online: boolean }[] };
      await expect.poll(async () => {
        const shown = await bot.run("group", "show", group) as Shown;
        return shown.status === "active" && shown.members?.length === 2 && shown.members.every(m => m.me || m.online);
      }, { timeout: 150_000, intervals: [2_000] }).toBe(true);

      await bot.run("group", "send", group, "Build finished", "--wait", "sent", "--timeout", "120");
      await page.setViewportSize(PHONE);
      const row = chat(person).locator("[data-message-row]").filter({ hasText: "Build finished" });
      await expect(row).toBeVisible({ timeout: 120_000 });
      // Not a contact here: the name the member gave themselves, marked "~".
      await insideItsBubble(row.getByTestId("message-nick"), `~${LONG}`);
      await page.screenshot({ path: test.info().outputPath("long-name-group.png") });
      await inArabic(page, row);
      await insideItsBubble(row.getByTestId("message-nick"), `~${LONG}`);
      await page.screenshot({ path: test.info().outputPath("long-name-group-ar.png") });
    } finally {
      await bot.stop();
    }
  });
});
