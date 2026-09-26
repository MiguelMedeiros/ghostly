import { copyInvite, pasteInvite } from "../support/clipboard";
import { chat, expect, say, test } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";

/**
 * A bot on the headless Ghostly (packages/cli, WISP 11xx) and a person on the web app, in one chat: the same engine on
 * both sides, meeting through the test's Pkarr relay and going live over WebRTC (Chromium and libdatachannel).
 */
test.describe.configure({ timeout: 4 * 60_000 });

test("a person on the web chats with a headless bot, both ways", { tag: ["@feature:headless.web-interop", "@feature:headless.chat", "@feature:headless.events"] }, async ({ peer, relay }) => {
  const url = await relay.listen();
  const bot = new HeadlessBot();
  try {
    await bot.start(url, "Helper bot");
    const person = await peer("person");

    // The bot invites; the person joins on the web.
    const invite = await bot.run("invite", "create", "--label", "person");
    await person.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(person.page, invite.invite as string);
    await expect(person.page.getByPlaceholder("Message…")).toBeEnabled();
    await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
    await expect(person.page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 90_000 });

    await say(person, "hi bot");
    const received = await bot.event((e) => e.type === "message.received");
    expect(received).toMatchObject({ chat: invite.chat, message: { text: "hi bot", from: "peer" } });
    await bot.run("send", invite.chat as string, "hello from the bot", "--wait", "delivered");
    await expect(chat(person).getByText("hello from the bot")).toBeVisible();
    await expect(chat(person).getByText("~Helper bot").first()).toBeVisible();
    // The person's app announced itself; the bot saw a join, not a message, and answered it as the app would.
    expect(await bot.event((e) => e.type === "chat.joined")).toMatchObject({ chat: invite.chat });
    // The app shows each notice as a line: the person's own, and the bot's answer.
    await expect(chat(person).getByText(/joined the chat/)).toHaveCount(2);

    // The person invites; the bot joins.
    await person.page.goto("/#/");
    await person.page.getByTitle("New Chat").click();
    const second = await copyInvite(person.page);
    const joined = await bot.run("invite", "join", second);
    await bot.run("chat", "wait", joined.chat as string, "--until", "live", "--timeout", "120");
    await bot.run("send", joined.chat as string, "joined from the CLI", "--wait", "delivered");
    await expect(chat(person).getByText("joined from the CLI")).toBeVisible();
  } finally {
    await bot.stop();
  }
});
