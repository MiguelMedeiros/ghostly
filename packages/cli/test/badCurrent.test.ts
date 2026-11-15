import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";

// covers: headless.cli

/**
 * A `<home>/current` that names no profile (edited by hand, written by a script) is refused naming the file and the way
 * out, not a usage error of a name nobody typed. `profile list`, `use` and `create` run anyway: they are that way out.
 * Before, every command answered `Not a profile name: "bad/name"` (exit 2), and only `-p` got past it.
 */
describe("a bad name in <home>/current", { timeout: 60_000 }, () => {
  it("is refused naming the file, and profile list, use and create still run", async () => {
    const dir = home("bad-current");
    const file = join(dir, "current");
    ok(await ghostly(["--home", dir, "profile", "create", "bot"]));
    writeFileSync(file, "bad/name\n");

    for (const args of [["status"], ["profile", "show"]]) {
      const refused = error(await ghostly(["--home", dir, ...args]), "refused", 1);
      expect(refused.message, args.join(" ")).toContain(file);
      expect(refused.message, args.join(" ")).toContain("ghostly profile use");
    }
    expect(ok(await ghostly(["--home", dir, "-p", "bot", "profile", "show"])).profile).toBeDefined();

    const listed = ok(await ghostly(["--home", dir, "profile", "list"])).profiles as { name: string; current: boolean }[];
    expect(listed.map((p) => [p.name, p.current])).toEqual([["bot", false]]);

    expect(ok(await ghostly(["--home", dir, "profile", "create", "other"])).current).toBe(false);
    expect(ok(await ghostly(["--home", dir, "profile", "use", "bot"]))).toEqual({ current: "bot" });
    expect(readFileSync(file, "utf8").trim()).toBe("bot");
    ok(await ghostly(["--home", dir, "status"]));

    writeFileSync(file, "bad/name\n");
    expect(ok(await ghostly(["--home", dir, "profile", "create", "third", "--use"])).current).toBe(true);
    expect(readFileSync(file, "utf8").trim()).toBe("third");
  });
});

/**
 * GHOSTLY_PROFILE set to a name no profile can have (`my work`, a path) is refused naming the variable and the way out.
 * Before, every command, `profile list` and `use` too, answered `Not a profile name: "my work"`, the words of a
 * `--profile` typed on that line, which nobody had typed.
 */
describe("a bad name in GHOSTLY_PROFILE", { timeout: 60_000 }, () => {
  it("is refused naming the variable, and --profile still wins", async () => {
    const dir = home("bad-env-profile");
    ok(await ghostly(["--home", dir, "profile", "create", "bot"]));
    for (const value of ["my work", "../bot"]) {
      for (const args of [["status"], ["profile", "list"], ["profile", "use", "bot"]]) {
        const refused = error(await ghostly(["--home", dir, ...args], { env: { GHOSTLY_PROFILE: value } }), "usage", 2);
        expect(refused.message, `${value}: ${args.join(" ")}`).toContain("GHOSTLY_PROFILE");
        expect(refused.message, `${value}: ${args.join(" ")}`).toContain("unset it");
      }
    }
    expect(ok(await ghostly(["--home", dir, "-p", "bot", "profile", "show"], { env: { GHOSTLY_PROFILE: "my work" } })).profile).toBeDefined();
    // A --profile typed on the line keeps its own words.
    expect(error(await ghostly(["--home", dir, "-p", "my work", "status"]), "usage", 2).message).toContain("Not a profile name");
  });
});
