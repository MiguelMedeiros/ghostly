import { describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";

// covers: headless.cli

const SEED = "legal winner thank year wave sausage worth useful legal winner thank yellow";

/** `ghostly engine` reaches the engine's own send calls: the secret guard `send` has holds there too (docs/CLI.md § Safety). */
describe("ghostly engine and the secret guard", { timeout: 60_000 }, () => {
  it("refuses a seed in sendMessage and sendGroupMessage (exit 5) unless --force", async () => {
    const dir = home("engine-secret");
    ok(await ghostly(["--home", dir, "profile", "create", "bot", "--use"]));
    const sends: [string, Record<string, unknown>][] = [
      ["sendMessage", { linkId: "nope", text: SEED }],
      ["sendGroupMessage", { groupId: "nope", text: SEED }],
    ];
    for (const [method, params] of sends) {
      expect(error(await ghostly(["--home", dir, "engine", method, JSON.stringify(params)]), "confirm", 5).message, method).toMatch(/looks like a secret.*--force/);
      expect(error(await ghostly(["--home", dir, "engine", method, "-"], { input: JSON.stringify(params) }), "confirm", 5).message, method).toMatch(/--force/);
    }
    // With --force the guard lets it through to the engine, which answers for a group it does not have.
    expect(ok(await ghostly(["--home", dir, "engine", "sendGroupMessage", JSON.stringify(sends[1][1]), "--force"]))).toMatchObject({ error: expect.any(String) });
  });
});
