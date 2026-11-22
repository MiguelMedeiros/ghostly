import { describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";

// covers: headless.cli

/** `profile create <name> --name <shown name>`: a refused name leaves no profile behind, so the retry works. */
describe("profile create --name", { timeout: 60_000 }, () => {
  it("a name over 64 characters, or with nothing that shows, is refused before the profile is made or selected", async () => {
    const dir = home("create-bad-name");
    ok(await ghostly(["--home", dir, "profile", "create", "first", "--use"]));
    // A usage error naming --name (exit 2), counted in code points as the engine counts: it was the engine's
    // `bad_request` (exit 1), "name must be up to 64 characters on one line".
    expect(error(await ghostly(["--home", dir, "profile", "create", "bot", "--use", "--name", "x".repeat(65)]), "usage", 2).message)
      .toBe("--name is up to 64 characters, not 65 characters");
    expect(error(await ghostly(["--home", dir, "profile", "create", "bot", "--use", "--name", `${"x".repeat(63)}👻👻`]), "usage", 2).message)
      .toBe("--name is up to 64 characters, not 65 characters");
    // Nothing that shows: no profile either (it was made, and kept the invisible name).
    expect(error(await ghostly(["--home", dir, "profile", "create", "bot", "--use", "--name", "\u200b\u200b"]), "usage", 2).message)
      .toBe("--name needs a character that shows (an empty one is no name)");
    expect(ok(await ghostly(["--home", dir, "profile", "list"])).profiles).toEqual([{ name: "first", current: true, running: false }]);
    expect(ok(await ghostly(["--home", dir, "profile", "create", "bot", "--use", "--name", "Bot"]))).toMatchObject({ created: "bot", current: true, profile: { name: "Bot" } });
    // At the limit, emoji counted as one: taken.
    const long = `${"x".repeat(62)}👻👻`;
    expect(ok(await ghostly(["--home", dir, "profile", "create", "bot2", "--name", long]))).toMatchObject({ created: "bot2", profile: { name: long } });
  });
});
