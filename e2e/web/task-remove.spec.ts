import { pasteInvite } from "../support/clipboard";
import { chat, expect, test } from "../support/fixtures";
import { HeadlessBot } from "../support/headless";

/**
 * A bot takes its cards back (WISP 405 · Status Cards § Removing a card): it sends tasks and a routine to a person's chat
 * and a task to a group, lists them with `task remove --all`, which sends nothing, then takes them all back with
 * `--all --yes`. The person's chat shows no card and no Tasks button, only the short line that says what went; the
 * group shows no card; the way to the Tasks board above the chat list is gone, and the board has no task.
 */
test.describe.configure({ timeout: 6 * 60_000 });

test("task remove --all --yes takes every card back from the chat, the group and the Tasks board", { tag: ["@feature:chat.status-cards", "@feature:chat.status-cards.wire", "@feature:headless.status-cards", "@feature:chat.tasks-board"] }, async ({ peer, relay }) => {
  const url = await relay.listen();
  const bot = new HeadlessBot();
  try {
    await bot.start(url, "Coordinator");
    const person = await peer("remove-person");
    const page = person.page, room = chat(person);
    const invite = await bot.run("invite", "create", "--label", "person");
    await page.getByRole("button", { name: "Join chat", exact: true }).first().click();
    await pasteInvite(page, invite.invite as string);
    await bot.run("chat", "wait", invite.chat as string, "--until", "live", "--timeout", "120");
    await expect(page.getByTestId("connection-options")).toHaveAccessibleName(/Connected · /, { timeout: 90_000 });
    const direct = invite.chat as string;

    // A private group the bot made, joined through its link.
    const group = (await bot.run("group", "create", "Sala de Máquinas", "--mesh")).group as string;
    const { link } = await bot.run("group", "link", group) as { link: string };
    const code = link.includes("#/join/") ? link.slice(link.indexOf("#/join/") + "#/join/".length) : link;
    await page.goto(`/#/join/${code}`);
    await expect(page.getByTestId("group-chat")).toHaveAttribute("data-status", "active", { timeout: 150_000 });
    type Shown = { status?: string; members?: { me: boolean; online: boolean }[] };
    await expect.poll(async () => {
      const shown = await bot.run("group", "show", group) as Shown;
      return shown.status === "active" && shown.members?.length === 2 && shown.members.every((m) => m.me || m.online);
    }, { timeout: 150_000, intervals: [2_000] }).toBe(true);

    // Two tasks and a routine in the 1:1 chat, a task in the group.
    await bot.run("task", "send", direct, "--id", "relay", "--title", "Fix relay rotation", "--progress", "40", "--wait", "delivered");
    await bot.run("task", "send", direct, "--id", "docs", "--title", "Write the WISP", "--status", "done", "--wait", "delivered");
    await bot.run("routine", "send", direct, "--id", "nightly", "--name", "Nightly bug hunt", "--schedule", "every day 01:00", "--wait", "delivered");
    await bot.run("task", "send", group, "--id", "ci", "--title", "Fix the flaky spec", "--progress", "60", "--wait", "sent", "--timeout", "120");
    const entry = page.getByTestId("sidebar-tasks");
    await expect(entry).toHaveAccessibleName("Tasks, 2 active", { timeout: 120_000 });
    await expect(page.getByTestId("group-chat").locator('[data-testid="status-card"][data-card-id="ci"]')).toBeVisible();

    // The list sends nothing: every card stays.
    const listed = await bot.run("task", "remove", "--all") as { dryRun: boolean; count: number; cards: { id: string }[] };
    expect(listed.dryRun).toBe(true);
    expect(listed.cards.map((c) => c.id).sort()).toEqual(["ci", "docs", "nightly", "relay"]);

    const removed = await bot.run("task", "remove", "--all", "--yes") as { dryRun: boolean; count: number; failed?: unknown };
    expect(removed).toMatchObject({ dryRun: false, count: 4 });
    expect(removed.failed).toBeUndefined();

    // The group: its card is gone.
    await expect(page.getByTestId("group-chat").locator('[data-testid="status-card"]')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByTestId("group-chat").getByText("🗑 Task removed: Fix the flaky spec")).toBeVisible();

    // The 1:1 chat: no card, no Tasks button, a line for each that went.
    await page.goto("/#/");
    await page.getByTestId("chat-row").filter({ hasText: "Coordinator" }).first().click();
    await expect(room.locator('[data-testid="status-card"]')).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByTestId("chat-tasks")).toHaveCount(0);
    await expect(room.getByText("🗑 Task removed: Fix relay rotation")).toBeVisible();
    await expect(room.getByText("🗑 Task removed: Write the WISP")).toBeVisible();
    await expect(room.getByText("🗑 Routine removed: Nightly bug hunt")).toBeVisible();

    // The board: no way to it above the chat list, and nothing on it.
    await expect(entry).toHaveCount(0);
    await page.goto("/#/tasks");
    await expect(page.getByTestId("tasks-empty")).toContainText("No tasks yet");
    await expect(page.getByTestId("board-card")).toHaveCount(0);

    // Nothing of the bot's is left to take back.
    expect(await bot.run("task", "remove", "--all")).toMatchObject({ dryRun: true, count: 0 });
  } finally {
    await bot.stop();
  }
});
