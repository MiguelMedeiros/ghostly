import { describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";

// covers: headless.cli

/** `profile use` answers the profile the next commands run on, as `profile create --use` does; `default` is made on first use. */
describe("profile use", { timeout: 60_000 }, () => {
  it("under GHOSTLY_PROFILE answers that profile and says it still picks the profile", async () => {
    // It answered { current: <name> } while GHOSTLY_PROFILE kept every later command in that shell on another profile.
    const dir = home("profile-use");
    ok(await ghostly(["--home", dir, "profile", "create", "a", "--use"]));
    ok(await ghostly(["--home", dir, "profile", "create", "b"]));
    const env = { GHOSTLY_PROFILE: "a" };
    const used = await ghostly(["--home", dir, "profile", "use", "b"], { env });
    expect(ok(used)).toEqual({ current: "a" });
    expect(used.stderr).toContain("GHOSTLY_PROFILE");
    expect(ok(await ghostly(["--home", dir, "profile", "list"], { env })).profiles).toContainEqual({ name: "a", current: true, running: false });
    // Without it, the profile chosen is the current one, and nothing is said.
    const plain = await ghostly(["--home", dir, "profile", "use", "b"]);
    expect(ok(plain)).toEqual({ current: "b" });
    expect(plain.stderr).toBe("");
  });

  it("selects `default` in a home whose first profile was another", async () => {
    const dir = home("use-default");
    ok(await ghostly(["--home", dir, "profile", "create", "bot", "--use"]));
    expect(ok(await ghostly(["--home", dir, "profile", "use", "default"]))).toEqual({ current: "default" });
    expect(ok(await ghostly(["--home", dir, "profile", "list"])).profiles).toEqual([
      { name: "bot", current: false, running: false },
      { name: "default", current: true, running: false },
    ]);
  });

  it("refuses a name no profile has, and selects none", async () => {
    const dir = home("use-missing");
    ok(await ghostly(["--home", dir, "profile", "create", "bot", "--use"]));
    expect(error(await ghostly(["--home", dir, "profile", "use", "nobody"]), "not_found", 3).message).toBe(
      'No profile "nobody" (ghostly profile list, or ghostly profile create nobody)',
    );
    expect(ok(await ghostly(["--home", dir, "profile", "list"])).profiles).toEqual([{ name: "bot", current: true, running: false }]);
  });
});
