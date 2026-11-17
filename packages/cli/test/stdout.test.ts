import { describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";
// covers: headless.cli

/**
 * Stdout is the command's answer and nothing else. The engine notes things as it works (a relay it leaves alone for a
 * minute, say) with `console.info`, which Node writes to stdout: a script reading the answer met a line that is not
 * JSON. A relay that does not answer is the easy way to make it say something.
 */
describe("stdout", () => {
  it("holds the answer alone when the engine has something to note: its notes go to stderr", async () => {
    const dir = home("stdout");
    // Nothing listens there: every request is refused at once, and the relay is soon left alone, with a note.
    ok(await ghostly(["--home", dir, "settings", "set", "relays", JSON.stringify(["http://127.0.0.1:9"])]));
    const { chat } = ok(await ghostly(["--home", dir, "invite", "create", "--label", "nobody"]));
    // The note comes at the first refused request (a connection never made leaves the relay alone at once), so a
    // short wait is enough: the rest of it is only the wait running out.
    const result = await ghostly(["--home", dir, "chat", "wait", chat as string, "--until", "live", "--timeout", "4"]);
    expect(error(result, "timeout", 4).message).toContain("Timed out");
    expect(result.stdout.trim().split("\n"), "one line, the answer").toHaveLength(1);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stderr).toMatch(/ghostly: relay 127\.0\.0\.1:9 did not answer; asked again in \d+ s/);
    expect(result.stderr).not.toContain("[ghostly:relay]");
  }, 60_000);
});
