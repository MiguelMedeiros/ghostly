import { describe, expect, it } from "vitest";
import { error, ghostly, home, ok, Running } from "./support/cli";

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
      [["daemon", "status", "extra"], "daemon status [--timeout s]"],
      [["daemon", "stop", "extra"], "daemon stop [--timeout s]"],
      [["daemon", "restart", "extra"], "daemon restart [--timeout s]"],
      [["daemon", "--detach", "extra"], "daemon [--detach] [--timeout s]"],
      [["settings", "get", "extra"], "settings get [--show-secret]"],
      [["engine", "--list", "extra"], "engine --list"],
    ];
    for (const [args, usage] of cases) {
      expect(error(await ghostly(["--home", dir, ...args]), "usage", 2).message, args.join(" ")).toBe(`Too many arguments: ghostly ${usage}`);
    }
    expect(ok(await ghostly(["--home", dir, "profile", "list"])).profiles).toContainEqual({ name: "other", current: true, running: false });
  });

  it("`listen bob` is one too: no listener of every chat starts for a word that was meant as a filter", async () => {
    const dir = home("extra-listen");
    ok(await ghostly(["--home", dir, "profile", "create", "my", "--use"]));
    for (const words of [["bob"], ["message.received"], ["--print", "extra", "words"]]) {
      const listen = new Running(["--home", dir, "listen", ...words]);
      try {
        expect(await listen.exited(30_000), words.join(" ")).toBe(2);
        expect(listen.lines).toEqual([{ error: { code: "usage", message: "Too many arguments: ghostly listen [--since seq] [--cursor file] [--type t]... [--turns] [--from <chat|key>]... [--group <group>]... [--exec cmd] [--webhook url] [--print]" } }]);
      } finally { await listen.stop(); }
    }
  });

  it("a global option before the command adds none: `--name --` after it is still the name", async () => {
    // `--home <dir>` went between `--name` and its `--`: the name was "--home" and <dir> one word too many.
    const dir = home("globals-first");
    expect(ok(await ghostly(["--home", dir, "-p", "default", "profile", "set", "--name", "--"])).name).toBe("--");
  });
});
