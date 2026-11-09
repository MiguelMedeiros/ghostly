import { describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";
// covers: headless.cli

/**
 * The name contacts see has one rule, whichever command sets it, as a group's name: cleaned first (a tab or a line
 * break is a space, invisible characters go), then up to 64 characters. `settings set nick` stored 300 characters that
 * `profile set --name` refused, and both took a name with a line break; `status` and `profile show` printed them whole
 * (contacts saw the first 64 only). A tab was refused as a second line, and a name with nothing that shows was kept.
 */
describe("the profile's name", { timeout: 120_000 }, () => {
  const dir = home("profile-name");
  const name = async () => ok(await ghostly(["--home", dir, "profile", "show"])).name;

  it("is refused past 64 characters or with nothing that shows, by either command, and the name before stays", async () => {
    ok(await ghostly(["--home", dir, "profile", "set", "--name", "Bot"]));
    for (const [bad, rule] of [["x".repeat(300), "must be up to 64 characters on one line"], ["\u200b", "needs a character that shows (an empty one is no name)"]]) {
      expect(error(await ghostly(["--home", dir, "settings", "set", "nick", JSON.stringify(bad)]), "bad_request", 1).message, JSON.stringify(bad)).toBe(`nick ${rule}`);
    }
    expect(await name()).toBe("Bot");
  });

  // `profile set --name` checks the option before the profile opens, as `app init --title` does: a usage error (exit
  // 2) that names --name and counts as the engine counts (code points, once cleaned). It was the engine's
  // `bad_request` (exit 1), "name must be up to 64 characters on one line", though a line break is taken as a space.
  it("refuses a --name past 64 characters or with nothing that shows as a usage error naming --name", async () => {
    ok(await ghostly(["--home", dir, "profile", "set", "--name", "Bot"]));
    for (const [bad, message] of [
      ["x".repeat(65), "--name is up to 64 characters, not 65 characters"],
      ["x".repeat(300), "--name is up to 64 characters, not 300 characters"],
      [`${"x".repeat(63)}👻👻`, "--name is up to 64 characters, not 65 characters"],
      [`${"x".repeat(32)}\n${"x".repeat(32)}`, "--name is up to 64 characters, not 65 characters"],
      ["\u200b", "--name needs a character that shows (an empty one is no name)"],
    ]) {
      expect(error(await ghostly(["--home", dir, "profile", "set", "--name", bad]), "usage", 2).message, JSON.stringify(bad)).toBe(message);
    }
    expect(await name()).toBe("Bot");
  });

  it("takes a tab or a line break as a space, by either command", async () => {
    for (const given of ["a\nb", "a\rb", "a\tb"]) {
      expect(ok(await ghostly(["--home", dir, "profile", "set", "--name", given])).name, JSON.stringify(given)).toBe("a b");
      expect(ok(await ghostly(["--home", dir, "settings", "set", "nick", JSON.stringify(`${given}!`)])).nick, JSON.stringify(given)).toBe("a b!");
    }
    expect(await name()).toBe("a b!");
  });

  it("is taken at 64 characters, emoji counted as one, and trimmed, by either command", async () => {
    const long = `${"x".repeat(62)}👻👻`;
    expect(ok(await ghostly(["--home", dir, "settings", "set", "nick", ` ${long} `])).nick).toBe(long);
    expect(await name()).toBe(long);
    expect(ok(await ghostly(["--home", dir, "profile", "set", "--name", long])).name).toBe(long);
    // 65 code points as given, 64 once in NFC (e + a combining acute is é): taken, as the engine counts the stored name.
    expect(ok(await ghostly(["--home", dir, "profile", "set", "--name", `${"x".repeat(63)}e\u0301`])).name).toBe(`${"x".repeat(63)}é`);
    expect(ok(await ghostly(["--home", dir, "profile", "set", "--name", "  Ghost bot "])).name).toBe("Ghost bot");
    // Empty: no name, as before.
    expect(ok(await ghostly(["--home", dir, "settings", "set", "nick", ""])).nick).toBe("");
    expect(await name()).toBeNull();
  });
});
