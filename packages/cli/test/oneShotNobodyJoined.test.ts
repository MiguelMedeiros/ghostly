import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";
// covers: headless.cli

/**
 * A one-shot waits by default until what it did went out or the contact confirmed it, as it leaves with the process. On
 * a chat whose invite nobody took there is no one to wait for: `edit`, `react` and `pin` sat their whole 30 s, a card 30 s
 * and a file 300 s, then failed `timeout` (exit 4, which a bot retries: one more card or file each time), though all of
 * it is kept and goes once the contact joins. Their timeout said it "goes with this profile's next command": it does not.
 */
async function unjoined(name: string): Promise<{ dir: string; chat: string; messageId: string }> {
  const dir = home(`nobody-joined-${name}`);
  const chat = ok(await ghostly(["--home", dir, "invite", "create"])).chat as string;
  const messageId = ok(await ghostly(["--home", dir, "send", chat, "hello", "--wait", "none"])).messageId as string;
  return { dir, chat, messageId };
}

const CASES: [string, (chat: string, messageId: string, dir: string) => string[]][] = [
  ["edit", (chat, id) => ["edit", chat, id, "hello again"]],
  ["react", (chat, id) => ["react", chat, id, "👍"]],
  ["pin", (chat, id) => ["pin", chat, id]],
  ["task send", (chat) => ["task", "send", chat, "--title", "Build"]],
  ["routine send", (chat) => ["routine", "send", chat, "--name", "Backup", "--schedule", "every day 01:00"]],
  ["usage send", (chat) => ["usage", "send", chat, "--left", "40"]],
  ["file send", (chat, _id, dir) => {
    const path = join(dir, "note.txt");
    writeFileSync(path, "a small file");
    return ["file", "send", chat, path];
  }],
];

describe("a one-shot on a chat nobody joined yet", () => {
  it.each(CASES)("%s answers at once that it goes once they join", { timeout: 40_000 }, async (name, args) => {
    const { dir, chat, messageId } = await unjoined(name.replace(" ", "-"));
    const from = performance.now();
    const answer = ok(await ghostly(["--home", dir, ...args(chat, messageId, dir)]));
    expect(performance.now() - from).toBeLessThan(15_000);
    expect(answer.note).toMatch(/^Nobody joined this chat yet: .+ goes once they join while this profile is online/);
  });

  it("a task's update answers at once too", { timeout: 60_000 }, async () => {
    const { dir, chat } = await unjoined("task-update");
    const task = ok(await ghostly(["--home", dir, "task", "send", chat, "--title", "Build", "--wait", "none"])).task as string;
    const from = performance.now();
    const answer = ok(await ghostly(["--home", dir, "task", "update", chat, task, "--status", "done"]));
    expect(performance.now() - from).toBeLessThan(15_000);
    expect(answer).toMatchObject({ confirmed: false, note: expect.stringContaining("Nobody joined this chat yet") });
  });

  it("still waits when --wait is given, and its timeout says it goes once the contact joins", { timeout: 60_000 }, async () => {
    const { dir, chat, messageId } = await unjoined("wait");
    const reacted = error(await ghostly(["--home", dir, "react", chat, messageId, "👍", "--wait", "confirmed", "--timeout", "1"]), "timeout", 4);
    expect(reacted.message).toContain("goes once the contact joins this chat (nobody has yet)");
    expect(reacted.message).not.toContain("next command");
    const path = join(dir, "note.txt");
    writeFileSync(path, "a small file");
    const filed = error(await ghostly(["--home", dir, "file", "send", chat, path, "--wait", "sent", "--timeout", "1"]), "timeout", 4);
    expect(filed.message).toContain("goes once the contact joins this chat (nobody has yet)");
  });
});
