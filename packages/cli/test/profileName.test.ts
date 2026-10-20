import { describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";
// covers: headless.cli

/**
 * The name contacts see has one rule, whichever command sets it: up to 64 characters on one line, as a group's name.
 * `settings set nick` stored 300 characters that `profile set --name` refused, and both took a name with a line break;
 * `status` and `profile show` printed them whole (contacts saw the first 64 only).
 */
describe("the profile's name", { timeout: 120_000 }, () => {
  const dir = home("profile-name");
  const name = async () => ok(await ghostly(["--home", dir, "profile", "show"])).name;

  it("is refused past 64 characters or with a line break, by either command, and the name before stays", async () => {
    ok(await ghostly(["--home", dir, "profile", "set", "--name", "Bot"]));
    for (const bad of ["x".repeat(300), "a\nb", "a\rb", "tab\there"]) {
      expect(error(await ghostly(["--home", dir, "profile", "set", "--name", bad]), "bad_request", 1).message, JSON.stringify(bad))
        .toBe("name must be up to 64 characters on one line");
      expect(error(await ghostly(["--home", dir, "settings", "set", "nick", bad]), "bad_request", 1).message, JSON.stringify(bad))
        .toBe("nick must be up to 64 characters on one line");
    }
    expect(await name()).toBe("Bot");
  });

  it("is taken at 64 characters, emoji counted as one, and trimmed, by either command", async () => {
    const long = `${"x".repeat(62)}👻👻`;
    expect(ok(await ghostly(["--home", dir, "settings", "set", "nick", ` ${long} `])).nick).toBe(long);
    expect(await name()).toBe(long);
    expect(ok(await ghostly(["--home", dir, "profile", "set", "--name", "  Ghost bot "])).name).toBe("Ghost bot");
    // Empty: no name, as before.
    expect(ok(await ghostly(["--home", dir, "settings", "set", "nick", ""])).nick).toBe("");
    expect(await name()).toBeNull();
  });
});
