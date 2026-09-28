import type { Page } from "@playwright/test";
import { pasteInvite } from "../support/clipboard";
import { chat, expect, say, test, type Peer } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";
import { NOTE, heard, listen } from "../support/sounds";

/**
 * Only a new message plays the message sound (packages/browser/src/engine/attention.ts). A bot on the headless Ghostly
 * works the way the agents in Miguel's chats do: "thinking" with a status line that changes every few seconds, a status
 * message edited in place, reactions, and in a private group the admin's role handed over and a new name reaching the
 * group. None of it is a new message, so none of it is heard; each new message is heard once.
 *
 * What is heard is recorded, not played (support/sounds.ts): the message sound's first note is `NOTE.message`.
 */
test.describe.configure({ timeout: 8 * 60_000 });

/** Every note this peer's app started, and how many of them were not a message sound (its two notes). */
const notes = (peer: Peer) => peer.page.evaluate(() => JSON.parse(localStorage.getItem("qa-notes") ?? "[]") as number[]);
const otherNotes = async (peer: Peer) => (await notes(peer)).filter((hz) => hz !== NOTE.message && hz !== 1046).length;
const wallpaper = (page: Page) => page.locator(".chat-wallpaper");

test("a bot's thinking status, edits, reactions and a group's admin line play no sound; each new message plays one", { tag: ["@feature:app.attention.sounds", "@feature:headless.typing", "@feature:headless.edit", "@feature:headless.reactions", "@feature:groups.typing"] }, async ({ peer, relay }) => {
  const url = await relay.listen();
  const bot = new HeadlessBot();
  try {
    await bot.start(url, "Helper bot");
    const person = await peer("person");
    await listen(person);

    // A chat with the bot, live.
    const invite = await bot.run("invite", "create", "--label", "person");
    const chatId = invite.chat as string;
    await person.page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(person.page, invite.invite as string);
    await expect(person.page.getByPlaceholder("Message…")).toBeEnabled();
    await bot.run("chat", "wait", chatId, "--until", "live", "--timeout", "120");
    await expect(person.page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 90_000 });
    await expect(chat(person).getByText(/joined the chat/)).toHaveCount(2);
    await say(person, "status please");
    const asked = await bot.event((e) => e.type === "message.received");
    const first = await bot.run("send", chatId, "Working on it", "--wait", "delivered");
    await expect(chat(person).getByText("Working on it", { exact: true })).toBeVisible();
    // The joins were lines, not messages: the answer is the first message sound.
    await expect.poll(() => heard(person, NOTE.message)).toBe(1);
    const quiet = await otherNotes(person);

    // Thinking, its status changing every moment, as a bot does while it works; then nothing sent (a NO_REPLY turn).
    for (const status of ["Reading the chat", "Thinking", "Running the tests", "Writing the answer"]) {
      await bot.run("typing", chatId, "--kind", "thinking", "--status", status, "--for", "30");
      await expect(person.page.getByTestId("chat-typing-status")).toHaveText(status, { timeout: 30_000 });
    }
    await bot.run("typing", chatId, "--stop");
    await expect(person.page.getByTestId("chat-typing")).toHaveCount(0, { timeout: 15_000 });
    // The status message edited in place, twice, and a reaction.
    await bot.run("edit", chatId, first.messageId as string, "Working on it: tests");
    await expect(chat(person).getByText("Working on it: tests", { exact: true })).toBeVisible();
    await bot.run("edit", chatId, first.messageId as string, "Working on it: done");
    await expect(chat(person).getByText("Working on it: done", { exact: true })).toBeVisible();
    await bot.run("react", chatId, (asked.message as { id: string }).id, "👍");
    await expect(chat(person).locator('[data-testid="reaction-chip"][data-emoji="👍"]')).toBeVisible();
    await person.page.waitForTimeout(3_000);
    expect(await heard(person, NOTE.message)).toBe(1);
    expect(await otherNotes(person)).toBe(quiet);

    // A new message: one sound.
    await bot.run("send", chatId, "All green", "--wait", "delivered");
    await expect(chat(person).getByText("All green", { exact: true })).toBeVisible();
    await expect.poll(() => heard(person, NOTE.message)).toBe(2);

    // A private group with the bot, which is its admin: the person joins by its link.
    const group = (await bot.run("group", "create", "Engine room", "--mesh")).group as string;
    const link = (await bot.run("group", "link", group)).link as string;
    await person.page.goto(link.includes("#") ? "/" + link.slice(link.indexOf("#")) : `/#/join/${link}`);
    await expect(person.page.getByTestId("group-chat")).toHaveAttribute("data-status", "active", { timeout: 150_000 });
    await expect(person.page.getByPlaceholder("Message…")).toBeEnabled({ timeout: 90_000 });
    // Joining played what it always did (a group made or joined: the message sound while Interface cues are off).
    await person.page.waitForTimeout(2_000);
    const inGroup = await heard(person, NOTE.message);
    const hello = await bot.run("group", "send", group, "Hello room", "--wait", "sent", "--timeout", "90");
    await expect(wallpaper(person.page).getByText("Hello room", { exact: true })).toBeVisible();
    await expect.poll(() => heard(person, NOTE.message)).toBe(inGroup + 1);
    const groupQuiet = await otherNotes(person);

    // Thinking in the group, the status changing; an edit; a reaction.
    for (const status of ["Reading the room", "Thinking"]) {
      await bot.run("group", "typing", group, "--kind", "thinking", "--status", status, "--for", "30");
      await expect(person.page.getByTestId("group-typing-status")).toHaveText(status, { timeout: 30_000 });
    }
    await bot.run("group", "typing", group, "--stop");
    await bot.run("group", "edit", group, hello.messageId as string, "Hello room, again");
    await expect(wallpaper(person.page).getByText("Hello room, again", { exact: true })).toBeVisible();
    await bot.run("group", "react", group, hello.messageId as string, "👀");
    await expect(wallpaper(person.page).locator('[data-testid="reaction-chip"][data-emoji="👀"]')).toBeVisible();

    // The bot hands the admin role to the person: one line. Its new name then reaches the group, which changes the
    // group's session again: the line stays one (it was written, and heard, again on every such change).
    const members = (await bot.run("group", "show", group)).members as { key: string; me: boolean }[];
    await bot.run("group", "admin", group, members.find((m) => !m.me)!.key);
    const adminLines = wallpaper(person.page).getByTestId("group-event").filter({ hasText: "now the admin" });
    await expect(adminLines).toHaveCount(1, { timeout: 60_000 });
    await bot.run("profile", "set", "--name", "Helper bot two");
    await person.page.waitForTimeout(8_000);
    await expect(adminLines).toHaveCount(1);
    expect(await heard(person, NOTE.message)).toBe(inGroup + 1);
    expect(await otherNotes(person)).toBe(groupQuiet);

    // And a new message in the group: one sound.
    await bot.run("group", "send", group, "Handed over", "--wait", "sent", "--timeout", "90");
    await expect(wallpaper(person.page).getByText("Handed over", { exact: true })).toBeVisible();
    await expect.poll(() => heard(person, NOTE.message)).toBe(inGroup + 2);
  } finally {
    await bot.stop();
  }
});
