import { describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";

// covers: headless.cli

/** `profile create <name> --name <shown name>`: a refused name leaves no profile behind, so the retry works. */
describe("profile create --name", { timeout: 60_000 }, () => {
  it("a name over 64 characters, or with nothing that shows, is refused before the profile is made or selected", async () => {
    const dir = home("create-bad-name");
    ok(await ghostly(["--home", dir, "profile", "create", "first", "--use"]));
    expect(error(await ghostly(["--home", dir, "profile", "create", "bot", "--use", "--name", "x".repeat(65)]), "bad_request", 1).message)
      .toBe("name must be up to 64 characters on one line");
    // Nothing that shows: no profile either (it was made, and kept the invisible name).
    expect(error(await ghostly(["--home", dir, "profile", "create", "bot", "--use", "--name", "\u200b\u200b"]), "bad_request", 1).message)
      .toBe("name needs a character that shows (an empty one is no name)");
    expect(ok(await ghostly(["--home", dir, "profile", "list"])).profiles).toEqual([{ name: "first", current: true, running: false }]);
    expect(ok(await ghostly(["--home", dir, "profile", "create", "bot", "--use", "--name", "Bot"]))).toMatchObject({ created: "bot", current: true, profile: { name: "Bot" } });
  });
});
