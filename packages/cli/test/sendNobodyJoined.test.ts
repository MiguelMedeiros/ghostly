import { describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";
// covers: headless.cli

/**
 * A one-shot `send` waits by default until the text went out, as it leaves with the process. To a chat whose invite
 * nobody took there is no one to send to: it sat its whole 30 s and failed `timeout` (exit 4, which a bot retries, one
 * more copy each time), though the text is kept and goes once the contact joins.
 */
describe("a one-shot send to a chat nobody joined yet", () => {
  it("answers at once that the message waits for them to join", { timeout: 60_000 }, async () => {
    const dir = home("send-nobody-joined");
    const chat = ok(await ghostly(["--home", dir, "invite", "create"])).chat as string;
    const from = performance.now();
    const answer = ok(await ghostly(["--home", dir, "send", chat, "hello"]));
    expect(performance.now() - from).toBeLessThan(10_000);
    expect(answer).toMatchObject({ chat, delivery: "waiting", note: expect.stringContaining("Nobody joined this chat yet") });
    expect((ok(await ghostly(["--home", dir, "chat", "history", chat])).messages as { text: string }[]).map((m) => m.text)).toEqual(["hello"]);
  });

  it("still waits when --wait is given", { timeout: 60_000 }, async () => {
    const dir = home("send-nobody-joined-wait");
    const chat = ok(await ghostly(["--home", dir, "invite", "create"])).chat as string;
    error(await ghostly(["--home", dir, "send", chat, "hello", "--wait", "sent", "--timeout", "1"]), "timeout", 4);
  });
});
