import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ghostly, home } from "./support/cli";
// covers: headless.cli

/**
 * A path on this machine that is not there, or a folder where a file goes: said before the profile opens, in the API's
 * words. Before, a one-shot opened the profile and went online first (~1 s on a big profile) to refuse it. This home
 * has no profile: anything past the check fails as no profile.
 */
describe("local paths checked before the profile opens", () => {
  it("file send, profile picture, group picture and profile backup --out refuse a missing path or a folder first", async () => {
    const dir = home("local-paths-first");
    const folder = join(dir, "a-folder"), missing = join(dir, "nodir"), file = join(dir, "a-file");
    mkdirSync(folder);
    writeFileSync(file, "x");
    const cases: [string[], string, string][] = [
      [["file", "send", "bob", join(missing, "f.txt")], "not_found", `No file ${join(missing, "f.txt")}`],
      [["file", "send", "bob", folder], "bad_request", `${folder} is not a file`],
      [["profile", "picture", join(missing, "me.jpg")], "not_found", `No such file or folder: ${join(missing, "me.jpg")}`],
      [["profile", "picture", folder], "bad_request", `${folder} is a folder: name a file`],
      [["group", "picture", "Crew", join(missing, "crew.jpg")], "not_found", `No such file or folder: ${join(missing, "crew.jpg")}`],
      [["group", "picture", "Crew", folder], "bad_request", `${folder} is a folder: name a file`],
      [["profile", "backup", "--out", join(missing, "x.ghostly-backup"), "--no-passphrase"], "not_found", `No such file or folder: ${missing}`],
      [["profile", "backup", "--out", join(missing, "deeper", "x.ghostly-backup"), "--no-passphrase"], "not_found", `No such file or folder: ${join(missing, "deeper")}`],
      [["profile", "backup", "--out", join(file, "x.ghostly-backup"), "--no-passphrase"], "not_found", `No such file or folder: ${file}`],
    ];
    const seen = [];
    for (const [args] of cases) {
      const result = await ghostly(["--home", dir, ...args], { input: "" });
      seen.push({ args, code: result.code, json: result.json });
    }
    expect(seen).toMatchObject(cases.map(([args, code, message]) => ({ args, code: code === "not_found" ? 3 : 1, json: { error: { code, message } } })));
    expect(existsSync(join(dir, "profiles"))).toBe(false);
  });

  it("a path that loops through symbolic links is not there, as the API said it, not the engine failing", async () => {
    // Before: the check's stat threw Node's raw ELOOP, answered as `engine` (exit 1) naming no next step.
    const dir = home("local-paths-loop");
    const loop = join(dir, "loop");
    symlinkSync(loop, loop);
    const gone = `No such file or folder: ${loop} (its symbolic links go round in a loop)`;
    const cases: [string[], string][] = [
      [["file", "send", "bob", loop], `No file ${loop}`],
      [["profile", "picture", loop], gone],
      [["group", "picture", "Crew", loop], gone],
      [["profile", "backup", "--out", join(loop, "x.ghostly-backup"), "--no-passphrase"], gone],
    ];
    const seen = [];
    for (const [args] of cases) {
      const result = await ghostly(["--home", dir, ...args], { input: "" });
      seen.push({ args, code: result.code, json: result.json });
    }
    expect(seen).toMatchObject(cases.map(([args, message]) => ({ args, code: 3, json: { error: { code: "not_found", message } } })));
    expect(existsSync(join(dir, "profiles"))).toBe(false);
  });
});
