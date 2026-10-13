import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";

// covers: headless.cli

/**
 * An empty `--profile` or `--home` (an unset variable in a script: `ghostly -p "$BOT" …`) is a usage error before
 * anything opens. Taken as not given, it ran the command as the current profile (the person's own, for a script meant
 * for its bot), or in the current folder.
 */
describe("an empty global option", { timeout: 60_000 }, () => {
  it("`--profile` is a usage error, not the current profile", async () => {
    const dir = home("empty-profile");
    ok(await ghostly(["--home", dir, "profile", "create", "personal", "--use"]));
    ok(await ghostly(["--home", dir, "profile", "create", "bot"]));
    for (const args of [["-p", "", "profile", "show"], ["profile", "show", "-p", ""], ["--profile=", "profile", "show"], ["profile", "show", "--profile", ""]]) {
      expect(error(await ghostly(["--home", dir, ...args]), "usage", 2).message, args.join(" ")).toBe("--profile needs a profile name");
    }
    expect(ok(await ghostly(["--home", dir, "-p", "bot", "profile", "show"])).profile).toBe("bot");
  });

  it("`--home` is a usage error, not the current folder", async () => {
    for (const args of [["--home", "", "profile", "list"], ["--home=", "profile", "list"], ["profile", "list", "--home", ""]]) {
      expect(error(await ghostly(args), "usage", 2).message, args.join(" ")).toBe("--home needs a folder");
    }
    expect(existsSync(join(process.cwd(), "profiles"))).toBe(false);
  });
});
