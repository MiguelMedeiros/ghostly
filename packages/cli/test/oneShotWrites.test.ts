import { describe, expect, it } from "vitest";
import { ghostly, home, ok } from "./support/cli";
// covers: headless.cli

/**
 * With no daemon, each command opens the profile, does its work and leaves. A command with no chat to say goodbye to
 * left in the turn it wrote in: it answered done, and the next command found the profile as it was before.
 */
describe("a one-shot command's write is there for the next command", () => {
  it("lists the service `service add` answered, on a profile with no chat", { timeout: 60_000 }, async () => {
    const dir = home("one-shot-service");
    expect(ok(await ghostly(["--home", dir, "service", "add", "web", "http://127.0.0.1:5101"])).serviceId).toBe("web");
    const listed = ok(await ghostly(["--home", dir, "service", "list"])).services as { id: string }[];
    expect(listed.map((service) => service.id)).toEqual(["web"]);
  });

  it("shows the name `chat rename` answered, with no relay in reach", { timeout: 60_000 }, async () => {
    const dir = home("one-shot-rename");
    const chat = ok(await ghostly(["--home", dir, "invite", "create"])).chat as string;
    expect(ok(await ghostly(["--home", dir, "chat", "rename", chat, "Alice"])).name).toBe("Alice");
    expect(ok(await ghostly(["--home", dir, "chat", "show", chat])).name).toBe("Alice");
  });

  it("no longer lists the profile's only chat after `chat remove --yes`", { timeout: 60_000 }, async () => {
    const dir = home("one-shot-remove");
    const chat = ok(await ghostly(["--home", dir, "invite", "create"])).chat as string;
    expect(ok(await ghostly(["--home", dir, "chat", "remove", chat, "--yes"])).removed).toBe(chat);
    expect(ok(await ghostly(["--home", dir, "chat", "list"])).chats).toEqual([]);
  });
});
