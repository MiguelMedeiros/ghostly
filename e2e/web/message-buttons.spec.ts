import { pasteInvite } from "../support/clipboard";
import type { Page } from "@playwright/test";
import { chat, expect, test } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";

/**
 * A bot's buttons (WISP 4xx · Message Buttons): a headless bot asks "Want the $30 one?" with Yes and No; the person on
 * the web app taps Yes; the bot hears `button.pressed`, answers, and closes the question, which then shows Yes chosen
 * and every button disabled. In a group, the bot learns which member pressed.
 */
test.describe.configure({ timeout: 5 * 60_000 });

/** The app's light or dark look, as Settings sets it, once its colours have settled. */
async function theme(page: Page, scheme: "light" | "dark") {
  await page.evaluate(async (scheme) => {
    document.documentElement.setAttribute("data-theme", scheme);
    document.documentElement.style.colorScheme = scheme;
    await new Promise(requestAnimationFrame);
    // Transitions settle, but never wait past a second for one (a transition restarted on every frame never ends).
    await Promise.race([Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 1_000))]);
  }, scheme);
}

const QUESTION = "Want the $30 one? Reply yes or no";

test("a bot asks with Yes and No, the person taps Yes, and the bot hears it and answers", { tag: ["@feature:chat.buttons", "@feature:chat.buttons.wire", "@feature:headless.buttons"] }, async ({ peer, relay }) => {
  const url = await relay.listen();
  const bot = new HeadlessBot();
  try {
    await bot.start(url, "Shop");
    const person = await peer("buttons-person");
    const invite = await bot.run("invite", "create", "--label", "person");
    await person.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(person.page, invite.invite as string);
    await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
    await expect(person.page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 90_000 });
    const page = person.page, room = chat(person), chatId = invite.chat as string;

    const sent = await bot.run("send", chatId, QUESTION, "--button", "yes:Yes", "--button", "no:No", "--style", "yes=primary", "--once", "--wait", "delivered");
    expect(sent).toMatchObject({ chat: chatId, pressable: true });
    const question = sent.messageId as string;

    // The question shows as text, its buttons under it: Yes highlighted, both open.
    const buttons = room.getByTestId("message-buttons");
    await expect(buttons).toBeVisible();
    await expect(room.getByText("Want the $30 one? Reply yes or no")).toBeVisible();
    await expect(buttons.getByTestId("message-button")).toHaveText(["Yes", "No"]);
    await expect(buttons).toHaveAttribute("role", "group");
    const yes = buttons.locator('[data-testid="message-button"][data-button-id="yes"]');
    await expect(yes).not.toHaveAttribute("aria-disabled", "true");
    await buttons.scrollIntoViewIfNeeded();
    for (const scheme of ["dark", "light"] as const) {
      await theme(page, scheme);
      await page.screenshot({ path: test.info().outputPath(`desktop-${scheme}-asked.png`) });
    }

    // A tap: the bot hears which button, from whom, on which message.
    await yes.click();
    const pressed = await bot.event((e) => e.type === "button.pressed" && e.chat === chatId, 90_000);
    expect(pressed).toMatchObject({ chat: chatId, messageId: question, button: "yes", label: "Yes" });
    expect(pressed.inferred).toBeUndefined();
    // On the person's side: Yes chosen, and no second answer.
    await expect(yes).toHaveAttribute("data-chosen", "true");
    await expect(buttons.locator('[data-testid="message-button"][data-button-id="no"]')).toHaveAttribute("aria-disabled", "true");
    // The press shows as a compact line, not a quote.
    await expect(room.getByTestId("button-press")).toContainText("Yes");

    // The bot answers and closes the question: the buttons stay, Yes marked, all disabled.
    await bot.run("send", chatId, "Great, the $30 one is yours.", "--reply", question, "--wait", "delivered");
    await bot.run("button", "update", chatId, question, "--chosen", "yes", "--close", "--wait", "confirmed", "--timeout", "60");
    await expect(room.getByText("Great, the $30 one is yours.")).toBeVisible();
    await expect(room.getByTestId("message-buttons-closed")).toBeVisible({ timeout: 60_000 });
    await expect(yes).toHaveAttribute("aria-disabled", "true");
    await expect(yes).toHaveAttribute("data-chosen", "true");
    await expect(yes).toHaveAttribute("aria-pressed", "true");
    // Marked and closed by the bot: that is the question's life, not an edit to point out.
    await expect(room.locator("[data-message-row]").filter({ has: buttons }).getByTestId("message-edited")).toHaveCount(0);

    for (const scheme of ["dark", "light"] as const) {
      await theme(page, scheme);
      await page.screenshot({ path: test.info().outputPath(`desktop-${scheme}.png`) });
    }

    // A phone's width: a new question with more answers wraps and fits.
    await page.setViewportSize({ width: 375, height: 740 });
    await theme(page, "dark");
    await bot.run("send", chatId, "Which size? Reply S, M, L or XL", "--button", "s:Small", "--button", "m:Medium", "--button", "l:Large",
      "--button", "xl:Extra large", "--button", "cancel:Cancel order", "--style", "m=primary", "--style", "cancel=danger", "--wait", "delivered");
    const sizes = room.getByTestId("message-buttons").last();
    await expect(sizes.getByTestId("message-button")).toHaveCount(5);
    await sizes.scrollIntoViewIfNeeded();
    const box = await sizes.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await page.screenshot({ path: test.info().outputPath("phone-dark.png") });
    // The narrowest phone: still no spill.
    await page.setViewportSize({ width: 320, height: 700 });
    await sizes.scrollIntoViewIfNeeded();
    const narrow = await sizes.boundingBox();
    expect(narrow!.x + narrow!.width).toBeLessThanOrEqual(320);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await page.screenshot({ path: test.info().outputPath("phone-320-dark.png") });
  } finally {
    await bot.stop();
  }
});

test("a question asked while the person's app was closed shows its buttons once the chat is live again", { tag: ["@feature:chat.buttons", "@feature:chat.buttons.wire", "@feature:headless.buttons"] }, async ({ peer, relay }) => {
  const url = await relay.listen();
  const bot = new HeadlessBot();
  try {
    await bot.start(url, "Shop");
    const person = await peer("buttons-away-person");
    const invite = await bot.run("invite", "create", "--label", "person");
    await person.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(person.page, invite.invite as string);
    const chatId = invite.chat as string;
    await bot.run("chat", "wait", chatId, "--until", "live", "--timeout", "120");
    await expect(person.page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 90_000 });

    // The bot's join notice confirmed first: the DHT floor carries one text at a time, and the question must be it.
    type Row = { id: string; from: string; via: string; delivery: string | null; edits?: number; editPending?: boolean };
    const rows = async () => (await bot.run("chat", "history", chatId)).messages as Row[];
    await expect.poll(async () => (await rows()).filter((m) => m.from === "me" && m.delivery !== "delivered").length, { timeout: 90_000 }).toBe(0);
    // The person's app closes; the bot sees the chat drop, then asks: the question goes on the DHT floor, text alone.
    const returnTo = person.page.url();
    await person.page.goto("about:blank");
    await bot.event((e) => e.type === "chat.connection" && e.chat === chatId && e.live === false, 90_000);
    await bot.run("chat", "wait", chatId, "--until", "text", "--timeout", "120");
    const sent = await bot.run("send", chatId, QUESTION, "--button", "yes:Yes", "--button", "no:No", "--once", "--wait", "sent", "--timeout", "120");
    const question = sent.messageId as string;
    const history = async () => (await rows()).find((m) => m.id === question)!;
    expect(["pkarr", "hold"]).toContain((await history()).via);

    // Back: the question shows, and once the chat is live its buttons come as an edit of the buttons alone.
    await person.page.goto(returnTo);
    const room = chat(person);
    await expect(room.getByText(QUESTION)).toBeVisible({ timeout: 120_000 });
    const buttons = room.getByTestId("message-buttons");
    await expect(buttons.getByTestId("message-button")).toHaveText(["Yes", "No"], { timeout: 120_000 });
    const edited = await bot.event((e) => e.type === "message.edited" && e.chat === chatId && e.messageId === question, 120_000);
    expect(edited).toMatchObject({ edits: 1, message: { text: QUESTION } });
    // The same text: no edit mark.
    await expect(room.locator("[data-message-row]").filter({ has: buttons }).getByTestId("message-edited")).toHaveCount(0);

    // A tap is a press with its button, not a word the bot must guess from.
    await buttons.locator('[data-testid="message-button"][data-button-id="yes"]').click();
    const pressed = await bot.event((e) => e.type === "button.pressed" && e.chat === chatId, 90_000);
    expect(pressed).toMatchObject({ chat: chatId, messageId: question, button: "yes", label: "Yes" });
    expect(pressed.inferred).toBeUndefined();

    // Once: the app closed and opened again brings no second restore.
    await expect.poll(async () => (await history()).editPending ?? false, { timeout: 60_000 }).toBe(false);
    await person.page.reload();
    await expect(buttons.locator('[data-testid="message-button"][data-button-id="yes"]')).toHaveAttribute("data-chosen", "true", { timeout: 120_000 });
    await expect(person.page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 90_000 });
    expect((await history()).edits).toBe(1);
    expect(bot.events.filter((e) => e.type === "message.edited" && e.messageId === question)).toHaveLength(1);
  } finally {
    await bot.stop();
  }
});

test("in a group, the bot learns which member pressed", { tag: ["@feature:chat.buttons", "@feature:groups.send", "@feature:headless.buttons"] }, async ({ peer, relay }) => {
  test.setTimeout(8 * 60_000);
  const url = await relay.listen();
  const bot = new HeadlessBot();
  try {
    await bot.start(url, "Deploy bot");
    const person = await peer("buttons-group-person");
    const page = person.page;
    const created = await bot.run("group", "create", "Release room", "--mesh");
    const group = created.group as string;
    const { link } = await bot.run("group", "link", group) as { link: string };
    const code = link.includes("#/join/") ? link.slice(link.indexOf("#/join/") + "#/join/".length) : link;
    await page.goto(`/#/join/${code}`);
    await expect(page.getByTestId("group-chat")).toHaveAttribute("data-status", "active", { timeout: 150_000 });
    type Shown = { status?: string; members?: { me: boolean; online: boolean }[] };
    await expect.poll(async () => {
      const shown = await bot.run("group", "show", group) as Shown;
      return shown.status === "active" && shown.members?.length === 2 && shown.members.every(m => m.me || m.online);
    }, { timeout: 150_000, intervals: [2_000] }).toBe(true);

    const asked = await bot.run("group", "send", group, "Deploy 1.0.1 to production? Reply approve or hold", "--button", "approve:Approve", "--button", "hold:Hold",
      "--style", "approve=primary", "--style", "hold=danger", "--once", "--wait", "sent", "--timeout", "120");
    const room = page.locator(".chat-wallpaper");
    const buttons = room.getByTestId("message-buttons");
    await expect(buttons.getByTestId("message-button")).toHaveText(["Approve", "Hold"], { timeout: 120_000 });
    await buttons.locator('[data-testid="message-button"][data-button-id="approve"]').click();
    const pressed = await bot.event((e) => e.type === "button.pressed" && e.group === group, 120_000);
    expect(pressed).toMatchObject({ group, messageId: asked.messageId, button: "approve", label: "Approve" });
    expect(typeof pressed.by).toBe("string");
    await bot.run("button", "update", group, asked.messageId as string, "--chosen", "approve", "--close", "--wait", "sent", "--timeout", "120");
    await expect(room.getByTestId("message-buttons-closed")).toBeVisible({ timeout: 120_000 });
    await expect(buttons.locator('[data-testid="message-button"][data-button-id="approve"]')).toHaveAttribute("data-chosen", "true");
    await expect(room.getByTestId("button-press")).toContainText("Approve");
    await buttons.scrollIntoViewIfNeeded();
    await theme(page, "dark");
    await page.screenshot({ path: test.info().outputPath("group-dark.png") });
  } finally {
    await bot.stop();
  }
});
