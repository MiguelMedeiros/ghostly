import { describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";

// covers: headless.cli

/** `profile use default` makes `default` on first use, as every other command does; any other name must exist. */
describe("profile use", { timeout: 60_000 }, () => {
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
    expect(error(await ghostly(["--home", dir, "profile", "use", "nobody"]), "not_found", 3).message).toBe("No profile nobody");
    expect(ok(await ghostly(["--home", dir, "profile", "list"])).profiles).toEqual([{ name: "bot", current: true, running: false }]);
  });
});
