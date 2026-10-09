import { describe, expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";

// covers: headless.cli

/** The commands with their own flow refuse words past their usage, as every table command does, and act on nothing. */
describe("extra words", { timeout: 60_000 }, () => {
  it("are a usage error, and `profile use my bot` selects no profile", async () => {
    const dir = home("extra-args");
    ok(await ghostly(["--home", dir, "profile", "create", "my", "--use"]));
    ok(await ghostly(["--home", dir, "profile", "create", "other", "--use"]));
    const cases: [string[], string][] = [
      [["profile", "use", "my", "bot"], "profile use <name>"],
      [["profile", "list", "extra"], "profile list"],
      [["profile", "show", "extra"], "profile show"],
      [["profile", "set", "extra", "--name", "x"], "profile set [--name <name>] [--share-profile | --no-share-profile]"],
      [["profile", "backup", "extra", "--out", "f", "--no-passphrase"], "profile backup --out <file> [--passphrase-file f | --no-passphrase] [--light]"],
      [["profile", "restore","file", "new", "extra"], "profile restore <file> <new profile> [--passphrase-file f] [--use]"],
      [["daemon", "status", "extra"], "daemon status"],
      [["daemon", "stop", "extra"], "daemon stop"],
      [["daemon", "restart", "extra"], "daemon restart"],
      [["daemon", "--detach", "extra"], "daemon [--detach]"],
      [["settings", "get", "extra"], "settings get [--show-secret]"],
      [["engine", "--list", "extra"], "engine --list"],
    ];
    for (const [args, usage] of cases) {
      expect(error(await ghostly(["--home", dir, ...args]), "usage", 2).message, args.join(" ")).toBe(`Too many arguments: ghostly ${usage}`);
    }
    expect(ok(await ghostly(["--home", dir, "profile", "list"])).profiles).toContainEqual({ name: "other", current: true, running: false });
  });
});
