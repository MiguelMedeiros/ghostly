import { expect, it } from "vitest";
import { error, ghostly, home, ok } from "./support/cli";

// covers: headless.cli

/**
 * The commands with their own flow parsed each subcommand with one list of options, so a subcommand took its
 * siblings' flags and did nothing with them (`daemon stop --detach`, `engine getState --verbose`), exit 0. Each now
 * takes the flags its usage shows, as every table command does.
 */
it("a sibling's flag is an unknown option, and the command acts on nothing", { timeout: 60_000 }, async () => {
  const dir = home("sibling-flags");
  ok(await ghostly(["--home", dir, "profile", "create", "bot", "--use"]));
  const cases: [string[], string][] = [
    [["daemon", "status", "--detach"], "Unknown option --detach for ghostly daemon status (ghostly help daemon status)"],
    [["daemon", "stop", "--detach"], "Unknown option --detach for ghostly daemon stop (ghostly help daemon stop)"],
    [["settings", "get", "--force"], "Unknown option --force for ghostly settings get (ghostly help settings get)"],
    [["settings", "set", "sendTyping", "false", "--show-secret"], "Unknown option --show-secret for ghostly settings set (ghostly help settings set)"],
    [["engine", "--list", "--yes"], "Unknown option --yes for ghostly engine (ghostly help engine)"],
    [["engine", "--list", "--no-force"], "Unknown option --no-force for ghostly engine (ghostly help engine)"],
    [["engine", "getState", "--verbose"], "Unknown option --verbose for ghostly engine (ghostly help engine)"],
    // A typo beside a flag of the form is named, not the flag.
    [["engine", "--list", "--verbose", "--yess"], "Unknown option --yess for ghostly engine (did you mean --yes? ghostly help engine)"],
  ];
  for (const [args, message] of cases) {
    expect(error(await ghostly(["--home", dir, ...args]), "usage", 2).message, args.join(" ")).toBe(message);
  }
  expect(ok(await ghostly(["--home", dir, "settings", "get"])).sendTyping).not.toBe(false);
  // What each usage shows is still taken.
  ok(await ghostly(["--home", dir, "daemon", "status", "--timeout", "5"]));
  ok(await ghostly(["--home", dir, "settings", "get", "--show-secret"]));
  expect(ok(await ghostly(["--home", dir, "engine", "--list", "--verbose"])).takes).toBeTruthy();
});

it("`daemon status --timeout` is checked whether or not a daemon runs", { timeout: 60_000 }, async () => {
  // With none it was exit 0, with one exit 2: the value was read only on the way to the daemon.
  const dir = home("status-timeout");
  ok(await ghostly(["--home", dir, "profile", "create", "bot", "--use"]));
  expect(error(await ghostly(["--home", dir, "daemon", "status", "--timeout", "-3"]), "usage", 2).message).toBe("--timeout takes a number of seconds above 0");
});
