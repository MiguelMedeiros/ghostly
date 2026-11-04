import { describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";

// covers: headless.cli

/**
 * Usage shows `[--share-profile | --no-share-profile]` as either-or, and the CLI's other pairs refuse both: so does
 * this one, before anything is written. Before, the parser kept the last and turned sharing off with exit 0.
 */
describe("profile set --share-profile --no-share-profile", { timeout: 60_000 }, () => {
  it("is a usage error in either order, and the name and sharing stay as they were", async () => {
    const dir = home("share-both-ways");
    ok(await ghostly(["--home", dir, "profile", "create", "my", "--use", "--name", "Ana"]));
    for (const flags of [["--share-profile", "--no-share-profile"], ["--no-share-profile", "--share-profile=true"]]) {
      expect(error(await ghostly(["--home", dir, "profile", "set", "--name", "Bia", ...flags]), "usage", 2).message, flags.join(" "))
        .toBe("--share-profile or --no-share-profile, not both");
    }
    expect(ok(await ghostly(["--home", dir, "profile", "show"]))).toMatchObject({ name: "Ana", shareProfile: true });
    // The same way twice is no conflict.
    expect(ok(await ghostly(["--home", dir, "profile", "set", "--no-share-profile", "--no-share-profile"])).shareProfile).toBe(false);
  });
});
